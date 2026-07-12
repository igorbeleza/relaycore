import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import { loadConfig } from '../../src/config/env.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';

const encoder = new TextEncoder();

function streamFrom(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
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

class FakeRenderer implements TextRenderer {
  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

const config = loadConfig({
  LOG_LEVEL: 'silent',
  DEDUP_ENABLED: 'true',
  DEDUP_KEEP_RECENT_TURNS: '0',
});

const BIG = 'x'.repeat(2_000);

function duplicatePayload() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: BIG }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: BIG }] },
    ],
    stream: false,
  };
}

describe('dedup integration', () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('keeps the first block, references the rest, and records metrics', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(config, {
      anthropicClient: { createMessage },
      textRenderer: new FakeRenderer(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: duplicatePayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(createMessage).toHaveBeenCalledTimes(1);
    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(sentBody.messages[0].content[0].content).toBe(BIG);
    expect(sentBody.messages[1].content[0].content).toEqual(
      expect.stringContaining('[conteúdo idêntico ao bloco anterior #dedup-'),
    );
    expect(sentBody.messages[1].content[0].tool_use_id).toBe('tu_2');

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('relaycore_dedup_blocks_deduped_total 2');
  });

  it('forwards the body untouched when dedup is disabled', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(loadConfig({ LOG_LEVEL: 'silent' }), {
      anthropicClient: { createMessage },
      textRenderer: new FakeRenderer(),
    });
    apps.push(app);

    await app.inject({ method: 'POST', url: '/v1/messages', payload: duplicatePayload() });

    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(sentBody.messages[1].content[0].content).toBe(BIG);
  });
});
