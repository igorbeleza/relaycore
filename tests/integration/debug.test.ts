import { ReadableStream } from 'node:stream/web';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import type { AppConfig } from '../../src/config/env.js';
import type { AnthropicClient } from '../../src/providers/anthropic-client.js';

const testConfig: AppConfig = {
  host: '127.0.0.1',
  port: 47822,
  environment: 'test',
  logLevel: 'silent',
  upstreamBaseUrl: 'https://provider.example.test',
  upstreamTimeoutMs: 120000,
  debugToken: 'test-debug-token-123',
  pxpipeEnabled: false,
  pxpipeMinChars: 4000,
  pxpipeSavingsFactor: 0.7,
  pxpipeMaxPagesPerBlock: 4,
  pxpipeKeepRecentTurns: 3,
  pxpipeScope: 'user_and_tool_results',
};

const encoder = new TextEncoder();

function streamFrom(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

function createErrorClient(status: number, errorType: string): AnthropicClient {
  return {
    createMessage: async () => ({
      status,
      headers: new Headers({
        'content-type': 'application/json',
        'request-id': `upstream_debug_${status}_${errorType}`,
      }),
      body: streamFrom(
        JSON.stringify({
          error: {
            type: errorType,
            message: `Provider error for key sk-secret-debug-token-should-redact-${status}`,
          },
        }),
      ),
    }),
  };
}

describe('debug endpoint', () => {
  let app: ReturnType<typeof createApp>;

  afterEach(async () => {
    await app.close();
  });

  it('is hidden when no debug token is configured', async () => {
    app = createApp({ ...testConfig, debugToken: undefined });

    const response = await app.inject({ method: 'GET', url: '/debug/last-error' });

    expect(response.statusCode).toBe(404);
  });

  it('requires a valid debug token', async () => {
    app = createApp(testConfig);

    const missingToken = await app.inject({ method: 'GET', url: '/debug/last-error' });
    const invalidToken = await app.inject({
      method: 'GET',
      url: '/debug/last-error',
      headers: { 'x-relaycore-debug-token': 'wrong-token' },
    });

    expect(missingToken.statusCode).toBe(401);
    expect(invalidToken.statusCode).toBe(401);
  });

  it('returns the latest sanitized upstream error', async () => {
    const client = createErrorClient(400, 'invalid_request_error');
    app = createApp(testConfig, { anthropicClient: client });

    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-unknown-model', max_tokens: 16, messages: [] },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/debug/last-error',
      headers: { authorization: `Bearer ${testConfig.debugToken}` },
    });
    const body = response.json() as {
      last_error: {
        requestId: string;
        source: string;
        route: string;
        model: string;
        statusCode: number;
        upstreamStatus: number;
        upstreamRequestId: string;
        errorType: string;
        errorMessage: string;
      };
    };

    expect(response.statusCode).toBe(200);
    expect(body.last_error.requestId).toBeTruthy();
    expect(body.last_error.source).toBe('upstream_http_error');
    expect(body.last_error.route).toBe('/v1/messages');
    expect(body.last_error.model).toBe('claude-unknown-model');
    expect(body.last_error.statusCode).toBe(400);
    expect(body.last_error.upstreamStatus).toBe(400);
    expect(body.last_error.upstreamRequestId).toBe('upstream_debug_400_invalid_request_error');
    expect(body.last_error.errorType).toBe('invalid_request_error');
    expect(body.last_error.errorMessage).toContain('[redacted]');
    expect(body.last_error.errorMessage).not.toContain('sk-secret');
  });

  it('returns recent sanitized errors with optional filters', async () => {
    let status = 400;
    let errorType = 'invalid_request_error';
    const client: AnthropicClient = {
      createMessage: async () =>
        createErrorClient(status, errorType).createMessage({}, new Headers()),
    };
    app = createApp(testConfig, { anthropicClient: client });

    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-unknown-model', max_tokens: 16, messages: [] },
    });
    status = 429;
    errorType = 'rate_limit_error';
    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-sonnet-4-6', max_tokens: 16, messages: [] },
    });

    const allErrors = await app.inject({
      method: 'GET',
      url: '/debug/errors',
      headers: { 'x-relaycore-debug-token': testConfig.debugToken },
    });
    const filtered = await app.inject({
      method: 'GET',
      url: '/debug/errors?status_code=400&error_type=invalid_request_error',
      headers: { 'x-relaycore-debug-token': testConfig.debugToken },
    });

    const allBody = allErrors.json() as { count: number; errors: Array<{ statusCode: number }> };
    const filteredBody = filtered.json() as {
      count: number;
      errors: Array<{ statusCode: number; errorType: string; errorMessage: string }>;
    };

    expect(allErrors.statusCode).toBe(200);
    expect(allBody.count).toBe(2);
    expect(allBody.errors.map((error) => error.statusCode)).toEqual([429, 400]);
    expect(filtered.statusCode).toBe(200);
    expect(filteredBody.count).toBe(1);
    expect(filteredBody.errors[0]?.statusCode).toBe(400);
    expect(filteredBody.errors[0]?.errorType).toBe('invalid_request_error');
    expect(filteredBody.errors[0]?.errorMessage).not.toContain('sk-secret');
  });

  it('rejects invalid debug error filters', async () => {
    app = createApp(testConfig);

    const response = await app.inject({
      method: 'GET',
      url: '/debug/errors?status_code=nope',
      headers: { authorization: `Bearer ${testConfig.debugToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_query',
      message: 'status_code must be a three-digit HTTP status code.',
    });
  });
});
