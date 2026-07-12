import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.js';
import { DiagnosticsRegistry } from '../diagnostics/diagnostics-registry.js';
import { MetricsRegistry } from '../metrics/metrics-registry.js';
import { RenderCache } from '../pxpipe/render-cache.js';
import { PureImageRenderer, type TextRenderer } from '../pxpipe/renderer.js';
import { FetchAnthropicClient, type AnthropicClient } from '../providers/anthropic-client.js';
import {
  FetchUpstreamHealthChecker,
  type UpstreamHealthChecker,
} from '../providers/upstream-health.js';
import { registerDebugRoute } from '../routes/debug.js';
import { registerMessagesRoute } from '../routes/messages.js';

export type CreateAppOptions = Readonly<{
  anthropicClient?: AnthropicClient;
  diagnostics?: DiagnosticsRegistry;
  metrics?: MetricsRegistry;
  upstreamHealthChecker?: UpstreamHealthChecker;
  textRenderer?: TextRenderer;
}>;

export function createApp(config: AppConfig, options: CreateAppOptions = {}): FastifyInstance {
  const diagnostics = options.diagnostics ?? new DiagnosticsRegistry();
  const metrics = options.metrics ?? new MetricsRegistry();
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: config.maxRequestBodyBytes,
  });

  app.addHook('onRequest', async (request, reply) => {
    metrics.startRequest();
    reply.header('x-request-id', request.id);
    request.log.info(
      { requestId: request.id, method: request.method, path: request.url },
      'Request received',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = reply.elapsedTime;
    const route = request.routeOptions.url ?? request.url.split('?')[0];
    metrics.completeRequest({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
    });
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        path: route,
        statusCode: reply.statusCode,
        durationMs,
      },
      'Request completed',
    );
  });

  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
  }));

  app.get('/health/upstream', async (_request, reply) => {
    const healthChecker = options.upstreamHealthChecker ?? new FetchUpstreamHealthChecker(config);
    const health = await healthChecker.check();
    const statusCode = health.status === 'ok' ? 200 : 503;
    return reply.status(statusCode).send(health);
  });

  app.get('/version', async () => ({
    name: 'relaycore',
    version: '0.1.0',
  }));

  app.get('/metrics', async (_request, reply) => {
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.renderPrometheus());
  });

  registerDebugRoute(app, config, diagnostics);
  registerMessagesRoute(
    app,
    options.anthropicClient ?? new FetchAnthropicClient(config),
    diagnostics,
    metrics,
    {
      config,
      renderer: options.textRenderer ?? new PureImageRenderer(),
      cache: new RenderCache(),
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.status(500).send({
      error: 'internal_server_error',
      message: 'An unexpected error occurred.',
    });
  });

  return app;
}
