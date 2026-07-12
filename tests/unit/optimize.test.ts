import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { optimizeRequestBody } from '../../src/optimize/optimize.js';
import { RenderCache } from '../../src/pxpipe/render-cache.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';

class FakeRenderer implements TextRenderer {
  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DEDUP_ENABLED: 'true',
    DEDUP_KEEP_RECENT_TURNS: '0',
    PXPIPE_ENABLED: 'true',
    PXPIPE_KEEP_RECENT_TURNS: '0',
    ...overrides,
  });
}

const BIG = 'x'.repeat(20_000);
const REF_PREFIX = '[conteúdo idêntico ao bloco anterior #dedup-';

describe('optimizeRequestBody', () => {
  it('runs dedup before pxpipe and aggregates both stats', async () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: BIG }] },
        { role: 'user', content: [{ type: 'text', text: BIG }] },
      ],
    };
    const result = await optimizeRequestBody(
      body,
      makeConfig(),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;

    // First occurrence survives dedup, then pxpipe renders it to an image.
    expect((messages[0].content as Array<{ type: string }>)[0].type).toBe('image');
    // Second occurrence was collapsed to a short reference before pxpipe saw it,
    // so it stays as text (too small for pxpipe to convert).
    const secondBlock = (messages[1].content as Array<{ type: string; text: string }>)[0];
    expect(secondBlock.type).toBe('text');
    expect(secondBlock.text).toEqual(expect.stringContaining(REF_PREFIX));

    expect(result.stats.dedup.blocksDeduped).toBe(1);
    expect(result.stats.pxpipe.blocksConverted).toBe(1);
  });

  it('is a no-op that preserves the body reference when both optimizers are disabled', async () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        { role: 'user', content: BIG },
      ],
    };
    const result = await optimizeRequestBody(
      body,
      loadConfig({}),
      new FakeRenderer(),
      new RenderCache(),
    );
    expect(result.body).toBe(body);
    expect(result.stats.dedup.blocksDeduped).toBe(0);
    expect(result.stats.pxpipe.blocksConverted).toBe(0);
  });

  it('applies dedup alone when pxpipe is disabled', async () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        { role: 'user', content: BIG },
      ],
    };
    const result = await optimizeRequestBody(
      body,
      makeConfig({ PXPIPE_ENABLED: 'false' }),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;
    expect(messages[0].content).toBe(BIG);
    expect(messages[1].content).toEqual(expect.stringContaining(REF_PREFIX));
    expect(result.stats.dedup.blocksDeduped).toBe(1);
    expect(result.stats.pxpipe.blocksConverted).toBe(0);
  });
});
