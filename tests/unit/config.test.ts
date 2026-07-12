import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 47822,
      environment: 'development',
      logLevel: 'info',
      upstreamBaseUrl: 'https://api.oneprovider.dev',
      upstreamApiKey: undefined,
      upstreamTimeoutMs: 120000,
      debugToken: undefined,
    });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow('Invalid environment configuration');
  });

  it('loads a configured debug token', () => {
    expect(loadConfig({ DEBUG_TOKEN: 'debug-token-at-least-16-chars' }).debugToken).toBe(
      'debug-token-at-least-16-chars',
    );
  });
});
