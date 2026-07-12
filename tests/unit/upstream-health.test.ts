import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config/env.js';
import { FetchUpstreamHealthChecker } from '../../src/providers/upstream-health.js';

const baseConfig: AppConfig = {
  host: '127.0.0.1',
  port: 47822,
  environment: 'test',
  logLevel: 'silent',
  upstreamBaseUrl: 'https://provider.example.test',
  upstreamTimeoutMs: 120000,
};

describe('FetchUpstreamHealthChecker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unconfigured when the upstream API key is missing', async () => {
    const checker = new FetchUpstreamHealthChecker(baseConfig);

    const result = await checker.check();

    expect(result).toMatchObject({
      status: 'unconfigured',
      configured: false,
      reachable: false,
      reason: 'missing_upstream_api_key',
    });
  });

  it('reports ok when the upstream base URL responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const checker = new FetchUpstreamHealthChecker({
      ...baseConfig,
      upstreamApiKey: 'test-key',
    });

    const result = await checker.check();

    expect(result).toMatchObject({
      status: 'ok',
      configured: true,
      reachable: true,
      responseStatus: 404,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://provider.example.test',
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('reports unreachable when the upstream base URL cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    const checker = new FetchUpstreamHealthChecker({
      ...baseConfig,
      upstreamApiKey: 'test-key',
    });

    const result = await checker.check();

    expect(result).toMatchObject({
      status: 'unreachable',
      configured: true,
      reachable: false,
      reason: 'upstream_unreachable',
    });
  });
});
