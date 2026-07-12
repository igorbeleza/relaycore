import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/config/env.js';
import {
  MissingClientCredentialsError,
  resolveUpstreamAuthHeaders,
} from '../../src/providers/anthropic-client.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 47822,
    environment: 'test',
    logLevel: 'silent',
    upstreamBaseUrl: 'https://provider.example.test',
    upstreamMode: 'passthrough',
    upstreamTimeoutMs: 120000,
    pxpipeEnabled: false,
    pxpipeMinChars: 4000,
    pxpipeSavingsFactor: 0.7,
    pxpipeMaxPagesPerBlock: 4,
    pxpipeKeepRecentTurns: 3,
    pxpipeScope: 'user_and_tool_results',
    ...overrides,
  };
}

describe('resolveUpstreamAuthHeaders', () => {
  describe('provider mode (UPSTREAM_API_KEY configured)', () => {
    it('uses the configured key and never leaks client credentials upstream', () => {
      const config = makeConfig({ upstreamMode: 'provider', upstreamApiKey: 'server-key' });
      const inbound = new Headers({
        authorization: 'Bearer client-oauth-token',
        'x-api-key': 'client-api-key',
      });

      const headers = resolveUpstreamAuthHeaders(config, inbound);

      // toEqual garante a ausência de qualquer outra chave — em especial
      // 'authorization': credenciais do cliente não podem vazar upstream.
      expect(headers).toEqual({ 'x-api-key': 'server-key' });
    });

    it('uses the configured key even when the client sends no credentials', () => {
      const config = makeConfig({ upstreamMode: 'provider', upstreamApiKey: 'server-key' });

      expect(resolveUpstreamAuthHeaders(config, new Headers())).toEqual({
        'x-api-key': 'server-key',
      });
    });
  });

  describe('passthrough mode (no UPSTREAM_API_KEY)', () => {
    it('forwards the client authorization header verbatim', () => {
      const inbound = new Headers({ authorization: 'Bearer client-oauth-token' });

      expect(resolveUpstreamAuthHeaders(makeConfig(), inbound)).toEqual({
        authorization: 'Bearer client-oauth-token',
      });
    });

    it('forwards the client x-api-key header verbatim', () => {
      const inbound = new Headers({ 'x-api-key': 'client-api-key' });

      expect(resolveUpstreamAuthHeaders(makeConfig(), inbound)).toEqual({
        'x-api-key': 'client-api-key',
      });
    });

    it('forwards both credential headers when the client sends both', () => {
      const inbound = new Headers({
        authorization: 'Bearer client-oauth-token',
        'x-api-key': 'client-api-key',
      });

      expect(resolveUpstreamAuthHeaders(makeConfig(), inbound)).toEqual({
        authorization: 'Bearer client-oauth-token',
        'x-api-key': 'client-api-key',
      });
    });

    it('throws MissingClientCredentialsError when the client sends no credentials', () => {
      expect(() => resolveUpstreamAuthHeaders(makeConfig(), new Headers())).toThrow(
        MissingClientCredentialsError,
      );
    });
  });
});
