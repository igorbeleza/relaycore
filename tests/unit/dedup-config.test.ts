import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';

describe('dedup configuration', () => {
  it('is disabled by default with conservative values', () => {
    const config = loadConfig({});
    expect(config.dedupEnabled).toBe(false);
    expect(config.dedupMinChars).toBe(500);
    expect(config.dedupScope).toBe('user_and_tool_results');
    expect(config.dedupKeepRecentTurns).toBe(0);
  });

  it('parses explicit dedup values', () => {
    const config = loadConfig({
      DEDUP_ENABLED: 'true',
      DEDUP_MIN_CHARS: '1200',
      DEDUP_SCOPE: 'tool_results_only',
      DEDUP_KEEP_RECENT_TURNS: '4',
    });
    expect(config.dedupEnabled).toBe(true);
    expect(config.dedupMinChars).toBe(1200);
    expect(config.dedupScope).toBe('tool_results_only');
    expect(config.dedupKeepRecentTurns).toBe(4);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ DEDUP_ENABLED: 'yes' })).toThrow(/Invalid environment configuration/);
    expect(() => loadConfig({ DEDUP_MIN_CHARS: '50' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => loadConfig({ DEDUP_KEEP_RECENT_TURNS: '99' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
