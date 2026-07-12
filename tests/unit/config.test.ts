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
      upstreamModeSource: 'inferred',
      upstreamTimeoutMs: 120000,
      maxRequestBodyBytes: 20971520,
      debugToken: undefined,
      pxpipeEnabled: false,
      pxpipeMinChars: 4000,
      pxpipeSavingsFactor: 0.7,
      pxpipeMaxPagesPerBlock: 4,
      pxpipeKeepRecentTurns: 3,
      pxpipeScope: 'user_and_tool_results',
      dedupEnabled: false,
      dedupMinChars: 500,
      dedupScope: 'user_and_tool_results',
      dedupKeepRecentTurns: 0,
      dashboardEnabled: true,
      relaycoreDataDir: undefined,
      dashboardRetentionDays: 30,
      dashboardRecentLimit: 50,
    });
  });

  it('disables the dashboard when DASHBOARD_ENABLED=false', () => {
    expect(loadConfig({ DASHBOARD_ENABLED: 'false' }).dashboardEnabled).toBe(false);
  });

  it('rejects an invalid DASHBOARD_ENABLED value', () => {
    expect(() => loadConfig({ DASHBOARD_ENABLED: 'yes' })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('accepts a custom RELAYCORE_DATA_DIR and trims it', () => {
    expect(loadConfig({ RELAYCORE_DATA_DIR: '  /var/relaycore  ' }).relaycoreDataDir).toBe(
      '/var/relaycore',
    );
  });

  it('treats an empty RELAYCORE_DATA_DIR as unset', () => {
    expect(loadConfig({ RELAYCORE_DATA_DIR: '   ' }).relaycoreDataDir).toBeUndefined();
  });

  it('accepts a custom DASHBOARD_RETENTION_DAYS', () => {
    expect(loadConfig({ DASHBOARD_RETENTION_DAYS: '7' }).dashboardRetentionDays).toBe(7);
  });

  it('rejects a DASHBOARD_RETENTION_DAYS above the 365 ceiling', () => {
    expect(() => loadConfig({ DASHBOARD_RETENTION_DAYS: '400' })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('rejects a DASHBOARD_RETENTION_DAYS below the 1 day floor', () => {
    expect(() => loadConfig({ DASHBOARD_RETENTION_DAYS: '0' })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('accepts a custom DASHBOARD_RECENT_LIMIT', () => {
    expect(loadConfig({ DASHBOARD_RECENT_LIMIT: '100' }).dashboardRecentLimit).toBe(100);
  });

  it('rejects a DASHBOARD_RECENT_LIMIT above the 500 ceiling', () => {
    expect(() => loadConfig({ DASHBOARD_RECENT_LIMIT: '999' })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow('Invalid environment configuration');
  });

  it('loads a configured debug token', () => {
    expect(loadConfig({ DEBUG_TOKEN: 'debug-token-at-least-16-chars' }).debugToken).toBe(
      'debug-token-at-least-16-chars',
    );
  });

  it('treats an empty DEBUG_TOKEN as unset rather than rejecting it', () => {
    expect(loadConfig({ DEBUG_TOKEN: '' }).debugToken).toBeUndefined();
  });

  it('rejects a DEBUG_TOKEN shorter than 16 characters', () => {
    expect(() => loadConfig({ DEBUG_TOKEN: 'short' })).toThrow('Invalid environment configuration');
  });

  it('accepts a custom MAX_REQUEST_BODY_BYTES', () => {
    expect(loadConfig({ MAX_REQUEST_BODY_BYTES: '5242880' }).maxRequestBodyBytes).toBe(5242880);
  });

  it('rejects a MAX_REQUEST_BODY_BYTES below the 1 MiB floor', () => {
    expect(() => loadConfig({ MAX_REQUEST_BODY_BYTES: '100' })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('infers provider mode when UPSTREAM_API_KEY is set', () => {
    const config = loadConfig({ UPSTREAM_API_KEY: 'sk-key' });
    expect(config.upstreamMode).toBe('provider');
    expect(config.upstreamModeSource).toBe('inferred');
    expect(config.upstreamBaseUrl).toBe('https://api.oneprovider.dev');
  });

  it('accepts explicit UPSTREAM_MODE=provider with a key', () => {
    const config = loadConfig({ UPSTREAM_MODE: 'provider', UPSTREAM_API_KEY: 'sk-key' });
    expect(config.upstreamMode).toBe('provider');
    expect(config.upstreamModeSource).toBe('explicit');
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
