import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import type { AppConfig } from '../../src/config/env.js';
import { DashboardService } from '../../src/dashboard/service.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';

const baseConfig: AppConfig = {
  host: '127.0.0.1',
  port: 47822,
  environment: 'test',
  logLevel: 'silent',
  upstreamBaseUrl: 'https://provider.example.test',
  upstreamMode: 'passthrough',
  upstreamTimeoutMs: 120000,
  pxpipeEnabled: true,
  pxpipeMinChars: 4000,
  pxpipeSavingsFactor: 0.7,
  pxpipeMaxPagesPerBlock: 4,
  pxpipeKeepRecentTurns: 1,
  pxpipeScope: 'user_and_tool_results',
  dedupEnabled: false,
  dedupScope: 'user_and_tool_results',
  dedupKeepRecentTurns: 3,
  dashboardEnabled: true,
  dashboardRetentionDays: 30,
  dashboardRecentLimit: 50,
};

const encoder = new TextEncoder();

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function okUpstream() {
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json', 'content-length': '31' }),
    body: streamFrom(['{"type":"message","content":[]}']),
  };
}

class FakeRenderer implements TextRenderer {
  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

const BIG = 'x'.repeat(20_000);

function bigPayload() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    messages: [
      { role: 'user', content: [{ type: 'text', text: BIG }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'latest question' },
    ],
    stream: false,
  };
}

describe('dashboard integration', () => {
  const apps: ReturnType<typeof createApp>[] = [];
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'relaycore-dashboard-'));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serves the HTML shell and a live JSON feed reflecting recorded optimizations', async () => {
    const dashboard = new DashboardService({ ...baseConfig, relaycoreDataDir: dataDir });
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(
      { ...baseConfig, relaycoreDataDir: dataDir },
      { anthropicClient: { createMessage }, textRenderer: new FakeRenderer(), dashboard },
    );
    apps.push(app);

    const shell = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain('/dashboard/stats.json');

    const before = await app.inject({ method: 'GET', url: '/dashboard/stats.json' });
    expect(before.json().totals.requests).toBe(0);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: bigPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(createMessage).toHaveBeenCalledTimes(1);

    const after = await app.inject({ method: 'GET', url: '/dashboard/stats.json' });
    expect(after.headers['cache-control']).toBe('no-store');
    const stats = after.json();
    expect(stats.totals.requests).toBe(1);
    expect(stats.totals.blocksConverted).toBe(1);
    expect(stats.totals.pxpipeTokensSaved).toBeGreaterThan(0);
    expect(stats.totals.tokensSaved).toBeGreaterThan(0);
    expect(stats.recent).toHaveLength(1);
    expect(stats.recent[0]).toMatchObject({ route: '/v1/messages', statusCode: 200 });
  });

  it('persists events across a restart by seeding the aggregator from disk', async () => {
    const firstDashboard = new DashboardService({ ...baseConfig, relaycoreDataDir: dataDir });
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const firstApp = createApp(
      { ...baseConfig, relaycoreDataDir: dataDir },
      { anthropicClient: { createMessage }, textRenderer: new FakeRenderer(), dashboard: firstDashboard },
    );
    apps.push(firstApp);

    await firstApp.inject({ method: 'POST', url: '/v1/messages', payload: bigPayload() });
    // Wait for the best-effort background append to settle before "restarting".
    await firstDashboard.flush();

    // Simulate a restart: a brand-new service pointed at the same data dir.
    const secondDashboard = new DashboardService({ ...baseConfig, relaycoreDataDir: dataDir });
    await secondDashboard.initialize();
    const secondApp = createApp(
      { ...baseConfig, relaycoreDataDir: dataDir },
      { anthropicClient: { createMessage }, textRenderer: new FakeRenderer(), dashboard: secondDashboard },
    );
    apps.push(secondApp);

    const stats = (await secondApp.inject({ method: 'GET', url: '/dashboard/stats.json' })).json();
    expect(stats.totals.requests).toBe(1);
    expect(stats.totals.blocksConverted).toBe(1);
    expect(stats.recent[0]).toMatchObject({ route: '/v1/messages', statusCode: 200 });
  });

  it('does not expose dashboard endpoints when disabled', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(
      { ...baseConfig, dashboardEnabled: false, relaycoreDataDir: dataDir },
      { anthropicClient: { createMessage }, textRenderer: new FakeRenderer() },
    );
    apps.push(app);

    const shell = await app.inject({ method: 'GET', url: '/dashboard' });
    const feed = await app.inject({ method: 'GET', url: '/dashboard/stats.json' });
    expect(shell.statusCode).toBe(404);
    expect(feed.statusCode).toBe(404);
  });
});
