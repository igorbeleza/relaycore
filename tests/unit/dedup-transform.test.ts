import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { dedupeRequestBody } from '../../src/dedup/transform.js';

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ DEDUP_ENABLED: 'true', DEDUP_KEEP_RECENT_TURNS: '0', ...overrides });
}

const BIG = 'x'.repeat(2_000);
const REF_PREFIX = '[conteúdo idêntico ao bloco anterior #dedup-';

type Message = { role: string; content: unknown };

function messagesOf(result: { body: unknown }): Message[] {
  return (result.body as { messages: Message[] }).messages;
}

describe('dedupeRequestBody', () => {
  it('keeps the first occurrence and references later identical tool_result blocks', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: BIG }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: BIG }] },
      ],
    };
    const result = dedupeRequestBody(body, makeConfig());
    const messages = messagesOf(result);

    const first = (messages[0].content as Array<Record<string, unknown>>)[0];
    const second = (messages[1].content as Array<Record<string, unknown>>)[0];
    const third = (messages[2].content as Array<Record<string, unknown>>)[0];

    expect(first.content).toBe(BIG);
    expect(second.content).toEqual(expect.stringContaining(REF_PREFIX));
    expect(third.content).toEqual(expect.stringContaining(REF_PREFIX));
    expect(second.tool_use_id).toBe('tu_2');
    expect(third.tool_use_id).toBe('tu_3');
    expect(result.stats.blocksDeduped).toBe(2);
    expect(result.stats.estTokensSaved).toBeGreaterThan(0);
  });

  it('does not mutate the original body', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: BIG }] },
        { role: 'user', content: [{ type: 'text', text: BIG }] },
      ],
    };
    dedupeRequestBody(body, makeConfig());
    expect((body.messages[1].content as Array<{ text: string }>)[0].text).toBe(BIG);
  });

  it('references duplicate plain text blocks and string content', () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        { role: 'user', content: [{ type: 'text', text: BIG }] },
      ],
    };
    const result = dedupeRequestBody(body, makeConfig());
    const messages = messagesOf(result);
    expect(messages[0].content).toBe(BIG);
    expect((messages[1].content as Array<{ text: string }>)[0].text).toEqual(
      expect.stringContaining(REF_PREFIX),
    );
    expect(result.stats.blocksDeduped).toBe(1);
  });

  it('treats CRLF and LF variants as identical', () => {
    const crlf = 'line\r\n'.repeat(200);
    const lf = 'line\n'.repeat(200);
    const body = {
      messages: [
        { role: 'user', content: crlf },
        { role: 'user', content: lf },
      ],
    };
    const result = dedupeRequestBody(body, makeConfig());
    const messages = messagesOf(result);
    expect(messages[0].content).toBe(crlf);
    expect(messages[1].content).toEqual(expect.stringContaining(REF_PREFIX));
    expect(result.stats.blocksDeduped).toBe(1);
  });

  it('does not dedup blocks below DEDUP_MIN_CHARS', () => {
    const small = 'y'.repeat(300);
    const body = {
      messages: [
        { role: 'user', content: small },
        { role: 'user', content: small },
      ],
    };
    const result = dedupeRequestBody(body, makeConfig());
    expect(result.body).toBe(body);
    expect(result.stats.blocksDeduped).toBe(0);
  });

  it('protects the most recent user turns', () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: BIG },
      ],
    };
    const result = dedupeRequestBody(body, makeConfig({ DEDUP_KEEP_RECENT_TURNS: '1' }));
    const messages = messagesOf(result);
    expect(messages[2].content).toBe(BIG);
    expect(result.stats.blocksDeduped).toBe(0);
  });

  it('skips plain text blocks when scope is tool_results_only', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: BIG }] },
        { role: 'user', content: [{ type: 'text', text: BIG }] },
      ],
    };
    const result = dedupeRequestBody(body, makeConfig({ DEDUP_SCOPE: 'tool_results_only' }));
    expect(result.stats.blocksDeduped).toBe(0);
  });

  it('still dedups tool_result blocks when scope is tool_results_only', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: BIG }] },
      ],
    };
    const result = dedupeRequestBody(body, makeConfig({ DEDUP_SCOPE: 'tool_results_only' }));
    expect(result.stats.blocksDeduped).toBe(1);
  });

  it('returns the body untouched when dedup is disabled', () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        { role: 'user', content: BIG },
      ],
    };
    const result = dedupeRequestBody(body, loadConfig({ DEDUP_ENABLED: 'false' }));
    expect(result.body).toBe(body);
    expect(result.stats.blocksDeduped).toBe(0);
  });

  it('is idempotent', () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        { role: 'user', content: BIG },
      ],
    };
    const once = dedupeRequestBody(body, makeConfig());
    const twice = dedupeRequestBody(once.body, makeConfig());
    expect(twice.stats.blocksDeduped).toBe(0);
    expect(twice.body).toBe(once.body);
  });
});
