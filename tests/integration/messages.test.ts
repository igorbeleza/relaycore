import { ReadableStream } from 'node:stream/web';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import type { AppConfig } from '../../src/config/env.js';
import {
  type AnthropicClient,
  MissingClientCredentialsError,
  UpstreamConfigurationError,
  UpstreamRequestError,
} from '../../src/providers/anthropic-client.js';

const testConfig: AppConfig = {
  host: '127.0.0.1',
  port: 47822,
  environment: 'test',
  logLevel: 'silent',
  upstreamBaseUrl: 'https://provider.example.test',
  upstreamMode: 'passthrough',
  upstreamTimeoutMs: 120000,
  pxpipeEnabled: false,
  pxpipeMinChars: 4000,
  pxpipeSavingsFactor: 0.7,
  pxpipeMaxPagesPerBlock: 4,
  pxpipeKeepRecentTurns: 3,
  pxpipeScope: 'user_and_tool_results',
};

const encoder = new TextEncoder();

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('messages endpoint', () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('forwards a non-streaming request and preserves the upstream response', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json', 'request-id': 'req_test' }),
      body: streamFrom(['{"type":"message","content":[]}']),
    });
    const app = createApp(testConfig, { anthropicClient: { createMessage } });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      payload: { model: 'claude-sonnet-4-6', max_tokens: 16, messages: [], stream: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['request-id']).toBe('req_test');
    expect(response.json()).toEqual({ type: 'message', content: [] });
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
      expect.any(Headers),
    );
  });

  it('relays streaming SSE without modifying its events', async () => {
    const client: AnthropicClient = {
      createMessage: async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: streamFrom(['event: message_start\n', 'data: {"type":"message_start"}\n\n']),
      }),
    };
    const app = createApp(testConfig, { anthropicClient: client });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-sonnet-4-6', max_tokens: 16, messages: [], stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toBe('event: message_start\ndata: {"type":"message_start"}\n\n');
  });

  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
  ])('returns a safe diagnostic response for upstream HTTP %i', async (status, errorType) => {
    const client: AnthropicClient = {
      createMessage: async () => ({
        status,
        headers: new Headers({
          'content-type': 'application/json',
          'request-id': `upstream_${status}`,
        }),
        body: streamFrom([
          JSON.stringify({
            error: {
              type: errorType,
              message: `Provider rejected the request with token sk-secret-${status}-should-redact`,
            },
          }),
        ]),
      }),
    };
    const app = createApp(testConfig, { anthropicClient: client });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-sonnet-4-6', max_tokens: 16, messages: [] },
    });
    const body = response.json() as {
      type: string;
      error: { type: string; message: string };
      request_id: string;
      upstream_request_id: string;
      upstream_status: number;
    };

    expect(response.statusCode).toBe(status);
    expect(response.headers['request-id']).toBe(`upstream_${status}`);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe(errorType);
    expect(body.error.message).toContain('[redacted]');
    expect(body.error.message).not.toContain('sk-secret');
    expect(body.request_id).toBeTruthy();
    expect(body.upstream_request_id).toBe(`upstream_${status}`);
    expect(body.upstream_status).toBe(status);
  });

  it('returns 401 with authentication_error when passthrough credentials are missing', async () => {
    const client: AnthropicClient = {
      createMessage: async () => {
        throw new MissingClientCredentialsError();
      },
    };
    const app = createApp(testConfig, { anthropicClient: client });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-sonnet-4-6', max_tokens: 16, messages: [] },
    });
    const body = response.json() as {
      type: string;
      error: { type: string; message: string };
      request_id: string;
    };

    expect(response.statusCode).toBe(401);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('authorization or x-api-key');
    expect(body.request_id).toBeTruthy();

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain(
      'relaycore_upstream_errors_total{status_code="401",error_type="authentication_error"} 1',
    );
  });

  it('includes request_id when upstream configuration is missing', async () => {
    const client: AnthropicClient = {
      createMessage: async () => {
        throw new UpstreamConfigurationError();
      },
    };
    const app = createApp(testConfig, { anthropicClient: client });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-sonnet-4-6', max_tokens: 16, messages: [] },
    });
    const body = response.json() as { request_id: string };

    expect(response.statusCode).toBe(503);
    expect(body.request_id).toBeTruthy();
  });

  it('includes request_id when the upstream provider cannot be reached', async () => {
    const client: AnthropicClient = {
      createMessage: async () => {
        throw new UpstreamRequestError('Unable to reach the upstream provider.');
      },
    };
    const app = createApp(testConfig, { anthropicClient: client });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-sonnet-4-6', max_tokens: 16, messages: [] },
    });
    const body = response.json() as { request_id: string };

    expect(response.statusCode).toBe(502);
    expect(body.request_id).toBeTruthy();
  });

  it('increments upstream error metrics for provider errors', async () => {
    const client: AnthropicClient = {
      createMessage: async () => ({
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: streamFrom([
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'Invalid model.',
            },
          }),
        ]),
      }),
    };
    const app = createApp(testConfig, { anthropicClient: client });
    apps.push(app);

    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-unknown-model', max_tokens: 16, messages: [] },
    });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain(
      'relaycore_upstream_errors_total{status_code="400",error_type="invalid_request_error"} 1',
    );
  });
});
