import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { RenderCache } from '../../src/pxpipe/render-cache.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';
import { transformRequestBody } from '../../src/pxpipe/transform.js';

class FakeRenderer implements TextRenderer {
  public renderCalls = 0;
  public shouldFail = false;

  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    this.renderCalls += 1;
    if (this.shouldFail) throw new Error('render failed');
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ PXPIPE_ENABLED: 'true', PXPIPE_KEEP_RECENT_TURNS: '0', ...overrides });
}

const BIG = 'x'.repeat(20_000);
const FAKE_PNG_BASE64 = Buffer.from('fake-png').toString('base64');
const STUB_TEXT =
  '[pxpipe: 20000 chars rendered as 1 image page(s); read the image(s) as inline text]';

describe('transformRequestBody', () => {
  it('converts an eligible user text block into image blocks plus a stub', async () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(
      body,
      makeConfig(),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: FAKE_PNG_BASE64 },
    });
    expect(content.at(-1)).toEqual({ type: 'text', text: STUB_TEXT });
    expect(result.stats.blocksConverted).toBe(1);
    expect(result.stats.pagesRendered).toBe(1);
    expect(result.stats.estTokensSaved).toBe(5_000 - 3_262);
  });

  it('does not mutate the original body', async () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    await transformRequestBody(body, makeConfig(), new FakeRenderer(), new RenderCache());
    expect((body.messages[0].content as Array<{ type: string }>)[0].type).toBe('text');
  });

  it('protects the most recent user turns', async () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: BIG }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: BIG }] },
      ],
    };
    const result = await transformRequestBody(
      body,
      makeConfig({ PXPIPE_KEEP_RECENT_TURNS: '1' }),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;
    expect((messages[0].content as Array<{ type: string }>)[0].type).toBe('image');
    expect((messages[2].content as Array<{ type: string }>)[0].type).toBe('text');
    expect(result.stats.blocksConverted).toBe(1);
  });

  it('converts string content of user messages and of tool_result blocks', async () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG }],
        },
      ],
    };
    const result = await transformRequestBody(
      body,
      makeConfig(),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;
    expect((messages[0].content as Array<{ type: string }>)[0].type).toBe('image');
    const toolResult = (messages[1].content as Array<Record<string, unknown>>)[0];
    expect((toolResult.content as Array<{ type: string }>)[0].type).toBe('image');
    expect(toolResult.tool_use_id).toBe('tu_1');
    expect(result.stats.blocksConverted).toBe(2);
  });

  it('leaves tool_result blocks containing images untouched', async () => {
    const imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
    };
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_2',
              content: [{ type: 'text', text: BIG }, imageBlock],
            },
          ],
        },
      ],
    };
    const result = await transformRequestBody(
      body,
      makeConfig(),
      new FakeRenderer(),
      new RenderCache(),
    );
    expect(result.stats.blocksConverted).toBe(0);
  });

  it('reuses cached renders for repeated content', async () => {
    const renderer = new FakeRenderer();
    const cache = new RenderCache();
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const first = await transformRequestBody(body, makeConfig(), renderer, cache);
    const second = await transformRequestBody(body, makeConfig(), renderer, cache);
    expect(renderer.renderCalls).toBe(1);
    expect(first.stats.cacheHits).toBe(0);
    expect(second.stats.cacheHits).toBe(1);
    expect(second.stats.blocksConverted).toBe(1);
  });

  it('fails open when the renderer throws', async () => {
    const renderer = new FakeRenderer();
    renderer.shouldFail = true;
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(body, makeConfig(), renderer, new RenderCache());
    expect(result.body).toBe(body);
    expect(result.stats.renderFailures).toBe(1);
    expect(result.stats.blocksConverted).toBe(0);
  });

  it('returns the body untouched when pxpipe is disabled', async () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(
      body,
      loadConfig({ PXPIPE_ENABLED: 'false' }),
      new FakeRenderer(),
      new RenderCache(),
    );
    expect(result.body).toBe(body);
    expect(result.stats.blocksConverted).toBe(0);
  });

  it('skips plain text blocks when scope is tool_results_only', async () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(
      body,
      makeConfig({ PXPIPE_SCOPE: 'tool_results_only' }),
      new FakeRenderer(),
      new RenderCache(),
    );
    expect(result.stats.blocksConverted).toBe(0);
  });
});
