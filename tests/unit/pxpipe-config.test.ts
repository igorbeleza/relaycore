import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';

describe('pxpipe configuration', () => {
  it('is disabled by default with conservative values', () => {
    const config = loadConfig({});
    expect(config.pxpipeEnabled).toBe(false);
    expect(config.pxpipeMinChars).toBe(4000);
    expect(config.pxpipeSavingsFactor).toBe(0.7);
    expect(config.pxpipeMaxPagesPerBlock).toBe(4);
    expect(config.pxpipeKeepRecentTurns).toBe(3);
    expect(config.pxpipeScope).toBe('user_and_tool_results');
  });

  it('parses explicit pxpipe values', () => {
    const config = loadConfig({
      PXPIPE_ENABLED: 'true',
      PXPIPE_MIN_CHARS: '8000',
      PXPIPE_SAVINGS_FACTOR: '0.5',
      PXPIPE_MAX_PAGES_PER_BLOCK: '2',
      PXPIPE_KEEP_RECENT_TURNS: '5',
      PXPIPE_SCOPE: 'tool_results_only',
    });
    expect(config.pxpipeEnabled).toBe(true);
    expect(config.pxpipeMinChars).toBe(8000);
    expect(config.pxpipeSavingsFactor).toBe(0.5);
    expect(config.pxpipeMaxPagesPerBlock).toBe(2);
    expect(config.pxpipeKeepRecentTurns).toBe(5);
    expect(config.pxpipeScope).toBe('tool_results_only');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PXPIPE_ENABLED: 'yes' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => loadConfig({ PXPIPE_SAVINGS_FACTOR: '1.5' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
