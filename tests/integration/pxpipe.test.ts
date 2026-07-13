import { ReadableStream } from 'node:stream/web';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import type { AppConfig } from '../../src/config/env.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';

const pxpipeConfig: AppConfig = {
  host: '127.0.0.1',
  port: 47822,
  environment: 'test',
  logLevel: 'silent',
  upstreamBaseUrl: 'https://provider.example.test',
  upstreamTimeoutMs: 120000,
  pxpipeEnabled: true,
  pxpipeMinChars: 4000,
  pxpipeSavingsFactor: 0.7,
  pxpipeMaxPagesPerBlock: 4,
  pxpipeKeepRecentTurns: 1,
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

function okUpstream() {
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: streamFrom(['{"type":"message","content":[]}']),
  };
}

function badRequestUpstream() {
  return {
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: streamFrom([
      '{"type":"error","error":{"type":"invalid_request_error","message":"images not supported"}}',
    ]),
  };
}

class FakeRenderer implements TextRenderer {
  public shouldFail = false;

  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    if (this.shouldFail) throw new Error('render failed');
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

const BIG = 'x'.repeat(20_000);

function bigPayload() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    messages: [
      { role: 'user', content: [{ type: 'text', text: BIG }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'latest question' },
    ],
    stream: false,
  };
}

describe('pxpipe integration', () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('converts old user turns and protects the most recent one', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(pxpipeConfig, {
      anthropicClient: { createMessage },
      textRenderer: new FakeRenderer(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: bigPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(createMessage).toHaveBeenCalledTimes(1);
    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    const firstContent = sentBody.messages[0].content as Array<Record<string, unknown>>;
    expect(firstContent[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    expect(sentBody.messages[2].content).toBe('latest question');

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('relaycore_pxpipe_blocks_converted_total 1');
  });

  it('converts realistic multi-line code-like text via line packing', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(pxpipeConfig, {
      anthropicClient: { createMessage },
      textRenderer: new FakeRenderer(),
    });
    apps.push(app);

    const codeLike = Array.from({ length: 700 }, () => 'a'.repeat(80)).join('\n');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-sonnet-4-6',
        max_tokens: 16,
        messages: [
          { role: 'user', content: [{ type: 'text', text: codeLike }] },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          { role: 'user', content: 'latest question' },
        ],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    const firstContent = sentBody.messages[0].content as Array<Record<string, unknown>>;
    expect(firstContent[0]).toMatchObject({ type: 'image' });
  });

  it('forwards the body untouched when pxpipe is disabled', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(
      { ...pxpipeConfig, pxpipeEnabled: false },
      { anthropicClient: { createMessage }, textRenderer: new FakeRenderer() },
    );
    apps.push(app);

    await app.inject({ method: 'POST', url: '/v1/messages', payload: bigPayload() });

    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(sentBody.messages[0].content).toEqual([{ type: 'text', text: BIG }]);
  });

  it('fails open and forwards the original body when rendering fails', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const renderer = new FakeRenderer();
    renderer.shouldFail = true;
    const app = createApp(pxpipeConfig, {
      anthropicClient: { createMessage },
      textRenderer: renderer,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: bigPayload(),
    });

    expect(response.statusCode).toBe(200);
    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(sentBody.messages[0].content).toEqual([{ type: 'text', text: BIG }]);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('relaycore_pxpipe_render_failures_total 1');
  });

  it('retries once with the original body when the upstream rejects with 400', async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(badRequestUpstream())
      .mockResolvedValueOnce(okUpstream());
    const app = createApp(pxpipeConfig, {
      anthropicClient: { createMessage },
      textRenderer: new FakeRenderer(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: bigPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(createMessage).toHaveBeenCalledTimes(2);
    const retriedBody = createMessage.mock.calls[1][0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(retriedBody.messages[0].content).toEqual([{ type: 'text', text: BIG }]);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('relaycore_pxpipe_upstream_rejected_total 1');
  });
});
