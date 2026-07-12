import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config/env.js';
import type { DiagnosticsRegistry } from '../diagnostics/diagnostics-registry.js';

function getBearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim() || undefined;
}

function safeTokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(request: FastifyRequest, debugToken: string): boolean {
  const headerToken = request.headers['x-relaycore-debug-token'];
  const token = typeof headerToken === 'string' ? headerToken : getBearerToken(request);
  return safeTokenEquals(token, debugToken);
}

function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.status(404).send({
    error: 'not_found',
    message: 'Route not found.',
  });
}

function parseStatusCodeFilter(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{3}$/.test(value)) {
    throw new Error('status_code must be a three-digit HTTP status code.');
  }

  return Number(value);
}

function parseErrorTypeFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,80}$/.test(value)) {
    throw new Error('error_type must contain only lowercase letters, numbers, and underscores.');
  }

  return value;
}

function authorizeDebugRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): FastifyReply | undefined {
  if (!config.debugToken) {
    return sendNotFound(reply);
  }

  if (!isAuthorized(request, config.debugToken)) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'A valid debug token is required.',
    });
  }

  return undefined;
}

export function registerDebugRoute(
  app: FastifyInstance,
  config: AppConfig,
  diagnostics: DiagnosticsRegistry,
): void {
  app.get('/debug/last-error', async (request, reply) => {
    const unauthorized = authorizeDebugRequest(request, reply, config);
    if (unauthorized) return unauthorized;

    return reply.send({
      last_error: diagnostics.getLastError() ?? null,
    });
  });

  app.get('/debug/errors', async (request, reply) => {
    const unauthorized = authorizeDebugRequest(request, reply, config);
    if (unauthorized) return unauthorized;

    try {
      const query = request.query as { status_code?: unknown; error_type?: unknown };
      const statusCode = parseStatusCodeFilter(query.status_code);
      const errorType = parseErrorTypeFilter(query.error_type);
      const errors = diagnostics.listErrors({ statusCode, errorType });

      return reply.send({
        count: errors.length,
        errors,
      });
    } catch (error) {
      return reply.status(400).send({
        error: 'invalid_query',
        message: error instanceof Error ? error.message : 'Invalid debug query.',
      });
    }
  });
}
