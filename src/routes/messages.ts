import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config/env.js';
import type { OptimizationEvent } from '../dashboard/event-store.js';
import { extractSessionId } from '../dashboard/event-store.js';
import type { DashboardService } from '../dashboard/service.js';
import type { DiagnosticsRegistry } from '../diagnostics/diagnostics-registry.js';
import type { MetricsRegistry } from '../metrics/metrics-registry.js';
import type { PluginContext, PluginRegistry } from '../plugins/index.js';
import type { AnthropicClient, UpstreamResponse } from '../providers/anthropic-client.js';
import {
  MissingClientCredentialsError,
  UpstreamConfigurationError,
  UpstreamRequestError,
} from '../providers/anthropic-client.js';

const RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'retry-after',
  'request-id',
] as const;

const MAX_UPSTREAM_ERROR_MESSAGE_LENGTH = 500;

type ParsedUpstreamError = Readonly<{
  type: string;
  message: string;
}>;

export function isStreamingRequest(body: unknown): boolean {
  return (
    typeof body === 'object' && body !== null && (body as { stream?: unknown }).stream === true
  );
}

function getRequestModel(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const model = (body as { model?: unknown }).model;
  return typeof model === 'string' ? model : undefined;
}

function getUpstreamRequestId(headers: Headers): string | undefined {
  return (
    headers.get('request-id') ??
    headers.get('x-request-id') ??
    headers.get('anthropic-request-id') ??
    undefined
  );
}

function getDefaultErrorType(statusCode: number): string {
  if (statusCode === 400) return 'invalid_request_error';
  if (statusCode === 401 || statusCode === 403) return 'authentication_error';
  if (statusCode === 404) return 'not_found_error';
  if (statusCode === 408 || statusCode === 504) return 'timeout_error';
  if (statusCode === 429) return 'rate_limit_error';
  return 'api_error';
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_UPSTREAM_ERROR_MESSAGE_LENGTH);
}

function parseUpstreamErrorPayload(statusCode: number, payload: string): ParsedUpstreamError {
  const fallback = {
    type: getDefaultErrorType(statusCode),
    message: `Upstream provider returned HTTP ${statusCode}.`,
  };

  if (!payload.trim()) return fallback;

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return fallback;

    const container = parsed as {
      error?: { type?: unknown; message?: unknown };
      type?: unknown;
      message?: unknown;
    };
    const errorType =
      typeof container.error?.type === 'string'
        ? container.error.type
        : typeof container.type === 'string'
          ? container.type
          : fallback.type;
    const errorMessage =
      typeof container.error?.message === 'string'
        ? container.error.message
        : typeof container.message === 'string'
          ? container.message
          : fallback.message;

    return {
      type: sanitizeErrorMessage(errorType) || fallback.type,
      message: sanitizeErrorMessage(errorMessage) || fallback.message,
    };
  } catch {
    return {
      ...fallback,
      message: sanitizeErrorMessage(payload) || fallback.message,
    };
  }
}

function copyResponseHeaders(reply: FastifyReply, upstream: UpstreamResponse): void {
  for (const headerName of RESPONSE_HEADERS) {
    const value = upstream.headers.get(headerName);
    if (value) reply.header(headerName, value);
  }
}

export async function relayUpstreamError(
  request: FastifyRequest,
  reply: FastifyReply,
  upstream: UpstreamResponse,
  diagnostics: DiagnosticsRegistry,
  metrics: MetricsRegistry,
): Promise<FastifyReply> {
  copyResponseHeaders(reply, upstream);

  const payload = upstream.body ? await new Response(upstream.body).text() : '';
  const parsedError = parseUpstreamErrorPayload(upstream.status, payload);
  const upstreamRequestId = getUpstreamRequestId(upstream.headers);
  metrics.recordUpstreamError(upstream.status, parsedError.type);
  diagnostics.recordError({
    requestId: request.id,
    source: 'upstream_http_error',
    method: request.method,
    route: request.routeOptions.url ?? request.url.split('?')[0],
    model: getRequestModel(request.body),
    statusCode: upstream.status,
    upstreamStatus: upstream.status,
    upstreamRequestId,
    errorType: parsedError.type,
    errorMessage: parsedError.message,
  });

  request.log.warn(
    {
      requestId: request.id,
      upstreamRequestId,
      statusCode: upstream.status,
      upstreamStatus: upstream.status,
      model: getRequestModel(request.body),
      errorType: parsedError.type,
    },
    'Upstream provider returned an error',
  );

  return reply.status(upstream.status).send({
    type: 'error',
    error: {
      type: parsedError.type,
      message: parsedError.message,
    },
    request_id: request.id,
    upstream_request_id: upstreamRequestId,
    upstream_status: upstream.status,
  });
}

export async function relayResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  upstream: UpstreamResponse,
  stream: boolean,
): Promise<FastifyReply> {
  copyResponseHeaders(reply, upstream);
  reply.code(upstream.status);

  if (!upstream.body) return reply.send();
  if (!stream) return reply.send(Buffer.from(await new Response(upstream.body).arrayBuffer()));

  reply.hijack();
  const rawHeaders = Object.fromEntries(
    Object.entries(reply.getHeaders())
      .filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [name, Array.isArray(value) ? value.map(String) : String(value)]),
  );
  reply.raw.writeHead(upstream.status, rawHeaders);
  Readable.fromWeb(upstream.body)
    .on('error', (error) => {
      request.log.error(error, 'Upstream stream failed');
      reply.raw.destroy(error);
    })
    .pipe(reply.raw);
  return reply;
}

export async function handleUpstreamFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  diagnostics: DiagnosticsRegistry,
  metrics: MetricsRegistry,
): Promise<FastifyReply> {
  const route = request.routeOptions.url ?? request.url.split('?')[0];

  if (error instanceof MissingClientCredentialsError) {
    metrics.recordUpstreamError(401, 'authentication_error');
    diagnostics.recordError({
      requestId: request.id,
      source: 'missing_client_credentials',
      method: request.method,
      route,
      model: getRequestModel(request.body),
      statusCode: 401,
      errorType: 'authentication_error',
      errorMessage: error.message,
    });
    return reply.status(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: error.message },
      request_id: request.id,
    });
  }

  if (error instanceof UpstreamConfigurationError) {
    metrics.recordUpstreamError(503, 'api_error');
    diagnostics.recordError({
      requestId: request.id,
      source: 'upstream_configuration_error',
      method: request.method,
      route,
      model: getRequestModel(request.body),
      statusCode: 503,
      errorType: 'api_error',
      errorMessage: error.message,
    });
    return reply.status(503).send({
      type: 'error',
      error: { type: 'api_error', message: error.message },
      request_id: request.id,
    });
  }

  if (error instanceof UpstreamRequestError) {
    request.log.error(error.cause, error.message);
    metrics.recordUpstreamError(502, 'api_error');
    diagnostics.recordError({
      requestId: request.id,
      source: 'upstream_request_error',
      method: request.method,
      route,
      model: getRequestModel(request.body),
      statusCode: 502,
      errorType: 'api_error',
      errorMessage: error.message,
    });
    return reply.status(502).send({
      type: 'error',
      error: { type: 'api_error', message: error.message },
      request_id: request.id,
    });
  }

  throw error;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type DedupSummary = Mutable<OptimizationEvent['dedup']>;
type PxpipeSummary = Mutable<OptimizationEvent['pxpipe']>;

function emptyDedupSummary(): DedupSummary {
  return { blocksDeduped: 0, estTokensSaved: 0 };
}

function emptyPxpipeSummary(): PxpipeSummary {
  return {
    blocksConverted: 0,
    pagesRendered: 0,
    estTokensSaved: 0,
    cacheHits: 0,
    renderFailures: 0,
    upstreamRejected: false,
  };
}

/** Best-effort inbound size: prefer the client's content-length, fall back to the parsed body. */
function estimateBytesIn(request: FastifyRequest): number {
  const header = request.headers['content-length'];
  if (typeof header === 'string') {
    const parsed = Number(header);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  try {
    return Buffer.byteLength(JSON.stringify(request.body ?? ''), 'utf8');
  } catch {
    return 0;
  }
}

/** Best-effort outbound size from the reply's content-length (unset for streamed responses). */
function estimateBytesOut(reply: FastifyReply): number {
  const header = reply.getHeader('content-length');
  const parsed = Number(Array.isArray(header) ? header[0] : header);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function buildOptimizationEvent(
  request: FastifyRequest,
  reply: FastifyReply,
  startedAt: number,
  dedup: DedupSummary,
  pxpipe: PxpipeSummary,
  body: unknown,
): OptimizationEvent {
  return {
    ts: startedAt,
    requestId: request.id,
    method: request.method,
    route: request.routeOptions.url ?? request.url.split('?')[0],
    statusCode: reply.statusCode,
    durationMs: Date.now() - startedAt,
    model: getRequestModel(request.body),
    bytesIn: estimateBytesIn(request),
    bytesOut: estimateBytesOut(reply),
    dedup,
    pxpipe,
    sessionId: extractSessionId(body),
  };
}

export function registerMessagesRoute(
  app: FastifyInstance,
  config: AppConfig,
  client: AnthropicClient,
  diagnostics: DiagnosticsRegistry,
  metrics: MetricsRegistry,
  plugins: PluginRegistry,
  dashboard?: DashboardService,
): void {
  app.post('/v1/messages', async (request, reply) => {
    const startedAt = Date.now();
    const dedupSummary = emptyDedupSummary();
    const pxpipeSummary = emptyPxpipeSummary();
    const pluginContext: PluginContext = {
      config,
      requestId: request.id,
      logger: request.log,
      metrics,
    };
    const recordEvent = (): void => {
      const event = buildOptimizationEvent(request, reply, startedAt, dedupSummary, pxpipeSummary, request.body);
      if (dashboard) dashboard.record(event);
      plugins.runOnComplete(event, pluginContext);
    };

    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }

      let outboundBody = request.body;
      let bodyTransformed = false;
      if (plugins.hasEnabledTransforms(config)) {
        const outcome = await plugins.runTransforms(request.body, pluginContext);

        const dedupStats = outcome.statsByPlugin.dedup;
        if (dedupStats) {
          dedupSummary.blocksDeduped = dedupStats.blocksDeduped ?? 0;
          dedupSummary.estTokensSaved = dedupStats.estTokensSaved ?? 0;
        }
        const pxpipeStats = outcome.statsByPlugin.pxpipe;
        if (pxpipeStats) {
          pxpipeSummary.blocksConverted = pxpipeStats.blocksConverted ?? 0;
          pxpipeSummary.pagesRendered = pxpipeStats.pagesRendered ?? 0;
          pxpipeSummary.estTokensSaved = pxpipeStats.estTokensSaved ?? 0;
          pxpipeSummary.cacheHits = pxpipeStats.cacheHits ?? 0;
          pxpipeSummary.renderFailures = pxpipeStats.renderFailures ?? 0;
        }

        if (outcome.changed) {
          outboundBody = outcome.body;
          bodyTransformed = true;
        }
      }

      let upstream = await client.createMessage(outboundBody, headers);
      if (upstream.status === 400 && bodyTransformed) {
        metrics.recordPxpipeUpstreamRejection();
        pxpipeSummary.upstreamRejected = true;
        request.log.warn(
          { requestId: request.id, upstreamStatus: upstream.status },
          'Upstream rejected transformed payload; retrying once with the original body',
        );
        upstream = await client.createMessage(request.body, headers);
      }

      if (upstream.status >= 400) {
        const result = await relayUpstreamError(request, reply, upstream, diagnostics, metrics);
        recordEvent();
        return result;
      }
      const result = await relayResponse(
        request,
        reply,
        upstream,
        isStreamingRequest(request.body),
      );
      recordEvent();
      return result;
    } catch (error) {
      const result = await handleUpstreamFailure(request, reply, error, diagnostics, metrics);
      recordEvent();
      return result;
    }
  });
}
