import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config/env.js';
import type { DiagnosticsRegistry } from '../diagnostics/diagnostics-registry.js';
import type { MetricsRegistry } from '../metrics/metrics-registry.js';
import type { RenderCache } from '../pxpipe/render-cache.js';
import type { TextRenderer } from '../pxpipe/renderer.js';
import { transformRequestBody } from '../pxpipe/transform.js';
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

export type PxpipeIntegration = Readonly<{
  config: AppConfig;
  renderer: TextRenderer;
  cache: RenderCache;
}>;

export function registerMessagesRoute(
  app: FastifyInstance,
  client: AnthropicClient,
  diagnostics: DiagnosticsRegistry,
  metrics: MetricsRegistry,
  pxpipe?: PxpipeIntegration,
): void {
  app.post('/v1/messages', async (request, reply) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }

      let outboundBody = request.body;
      let pxpipeConverted = false;
      if (pxpipe?.config.pxpipeEnabled) {
        const transformed = await transformRequestBody(
          request.body,
          pxpipe.config,
          pxpipe.renderer,
          pxpipe.cache,
        );
        if (transformed.stats.renderFailures > 0) {
          metrics.recordPxpipeRenderFailure();
          request.log.warn(
            { requestId: request.id },
            'pxpipe rendering failed; forwarding original request body',
          );
        }
        if (transformed.stats.blocksConverted > 0) {
          metrics.recordPxpipeConversion(
            transformed.stats.blocksConverted,
            transformed.stats.estTokensSaved,
          );
          outboundBody = transformed.body;
          pxpipeConverted = true;
          request.log.info(
            {
              requestId: request.id,
              blocksConverted: transformed.stats.blocksConverted,
              pagesRendered: transformed.stats.pagesRendered,
              estTokensSaved: transformed.stats.estTokensSaved,
              cacheHits: transformed.stats.cacheHits,
            },
            'pxpipe converted request blocks to images',
          );
        }
      }

      let upstream = await client.createMessage(outboundBody, headers);
      if (upstream.status === 400 && pxpipeConverted) {
        metrics.recordPxpipeUpstreamRejection();
        request.log.warn(
          { requestId: request.id, upstreamStatus: upstream.status },
          'Upstream rejected pxpipe payload; retrying once with the original body',
        );
        upstream = await client.createMessage(request.body, headers);
      }

      if (upstream.status >= 400) {
        return relayUpstreamError(request, reply, upstream, diagnostics, metrics);
      }
      return relayResponse(request, reply, upstream, isStreamingRequest(request.body));
    } catch (error) {
      return handleUpstreamFailure(request, reply, error, diagnostics, metrics);
    }
  });
}
