import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 47822,
      environment: 'development',
      logLevel: 'info',
      upstreamBaseUrl: 'https://api.anthropic.com',
      upstreamApiKey: undefined,
      upstreamMode: 'passthrough',
      upstreamTimeoutMs: 120000,
      debugToken: undefined,
      pxpipeEnabled: false,
      pxpipeMinChars: 4000,
      pxpipeSavingsFactor: 0.7,
      pxpipeMaxPagesPerBlock: 4,
      pxpipeKeepRecentTurns: 3,
      pxpipeScope: 'user_and_tool_results',
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

  it('infers provider mode when UPSTREAM_API_KEY is set', () => {
    const config = loadConfig({ UPSTREAM_API_KEY: 'sk-key' });
    expect(config.upstreamMode).toBe('provider');
    expect(config.upstreamBaseUrl).toBe('https://api.oneprovider.dev');
  });

  it('accepts explicit UPSTREAM_MODE=provider with a key', () => {
    const config = loadConfig({ UPSTREAM_MODE: 'provider', UPSTREAM_API_KEY: 'sk-key' });
    expect(config.upstreamMode).toBe('provider');
  });

  it('accepts explicit UPSTREAM_MODE=passthrough without a key', () => {
    const config = loadConfig({ UPSTREAM_MODE: 'passthrough' });
    expect(config.upstreamMode).toBe('passthrough');
    expect(config.upstreamBaseUrl).toBe('https://api.anthropic.com');
  });

  it('rejects UPSTREAM_MODE=provider without UPSTREAM_API_KEY', () => {
    expect(() => loadConfig({ UPSTREAM_MODE: 'provider' })).toThrow(
      'UPSTREAM_MODE=provider requires UPSTREAM_API_KEY',
    );
  });

  it('rejects UPSTREAM_MODE=passthrough combined with UPSTREAM_API_KEY', () => {
    expect(() => loadConfig({ UPSTREAM_MODE: 'passthrough', UPSTREAM_API_KEY: 'sk-key' })).toThrow(
      'must not be combined with UPSTREAM_API_KEY',
    );
  });

  it('rejects an invalid UPSTREAM_MODE value', () => {
    expect(() => loadConfig({ UPSTREAM_MODE: 'proxy' })).toThrow(
      'Invalid environment configuration',
    );
  });
});
