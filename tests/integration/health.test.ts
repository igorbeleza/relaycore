import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import type { AppConfig } from '../../src/config/env.js';
import type { UpstreamHealthChecker } from '../../src/providers/upstream-health.js';

const testConfig: AppConfig = {
  host: '127.0.0.1',
  port: 47822,
  environment: 'test',
  logLevel: 'silent',
  upstreamBaseUrl: 'https://provider.example.test',
  upstreamTimeoutMs: 120000,
};

describe('health endpoint', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(testConfig);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the service status and version', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: '0.1.0' });
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('exposes Prometheus-compatible metrics', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('relaycore_http_requests_total');
  });

  it('returns upstream health when the provider is reachable', async () => {
    const upstreamHealthChecker: UpstreamHealthChecker = {
      check: async () => ({
        status: 'ok',
        configured: true,
        reachable: true,
        upstreamBaseUrl: 'https://provider.example.test',
        checkedAt: '2026-07-11T00:00:00.000Z',
        responseStatus: 404,
      }),
    };
    await app.close();
    app = createApp(testConfig, { upstreamHealthChecker });

    const response = await app.inject({ method: 'GET', url: '/health/upstream' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      configured: true,
      reachable: true,
      upstreamBaseUrl: 'https://provider.example.test',
      checkedAt: '2026-07-11T00:00:00.000Z',
      responseStatus: 404,
    });
  });

  it('returns service unavailable when upstream health fails', async () => {
    const upstreamHealthChecker: UpstreamHealthChecker = {
      check: async () => ({
        status: 'unreachable',
        configured: true,
        reachable: false,
        upstreamBaseUrl: 'https://provider.example.test',
        checkedAt: '2026-07-11T00:00:00.000Z',
        reason: 'upstream_unreachable',
      }),
    };
    await app.close();
    app = createApp(testConfig, { upstreamHealthChecker });

    const response = await app.inject({ method: 'GET', url: '/health/upstream' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unreachable',
      configured: true,
      reachable: false,
      upstreamBaseUrl: 'https://provider.example.test',
      checkedAt: '2026-07-11T00:00:00.000Z',
      reason: 'upstream_unreachable',
    });
  });
});
