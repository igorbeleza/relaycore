import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { MetricsRegistry } from '../../src/metrics/metrics-registry.js';
import { createDedupPlugin } from '../../src/plugins/builtin/dedup-plugin.js';
import type { PluginContext } from '../../src/plugins/types.js';

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ DEDUP_ENABLED: 'true', DEDUP_KEEP_RECENT_TURNS: '0', ...overrides });
}

function makeLogger(): FastifyBaseLogger {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: 'info' };
  return { ...logger, child: () => logger } as unknown as FastifyBaseLogger;
}

function makeCtx(config: AppConfig, metrics: MetricsRegistry): PluginContext {
  return { config, requestId: 'req-1', logger: makeLogger(), metrics };
}

const BIG = 'x'.repeat(2_000);

function bodyWithDuplicates(): unknown {
  return {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: BIG }] },
    ],
  };
}

describe('createDedupPlugin', () => {
  it('is named "dedup" and reflects config.dedupEnabled', () => {
    const plugin = createDedupPlugin();
    expect(plugin.name).toBe('dedup');
    expect(plugin.isEnabled(makeConfig())).toBe(true);
    expect(plugin.isEnabled(makeConfig({ DEDUP_ENABLED: 'false' }))).toBe(false);
  });

  it('reports changed with stats and records metrics when it dedupes', () => {
    const metrics = new MetricsRegistry();
    const ctx = makeCtx(makeConfig(), metrics);
    const result = createDedupPlugin().transformRequest!(bodyWithDuplicates(), ctx) as {
      changed: boolean;
      stats: Record<string, number>;
    };

    expect(result.changed).toBe(true);
    expect(result.stats.blocksDeduped).toBe(1);
    expect(result.stats.estTokensSaved).toBeGreaterThan(0);
    expect(metrics.renderPrometheus()).toContain('relaycore_dedup_blocks_deduped_total 1');
  });

  it('reports changed:false and records nothing when there is nothing to dedupe', () => {
    const metrics = new MetricsRegistry();
    const ctx = makeCtx(makeConfig(), metrics);
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'short' }] }] };
    const result = createDedupPlugin().transformRequest!(body, ctx) as { changed: boolean };

    expect(result.changed).toBe(false);
    expect(metrics.renderPrometheus()).toContain('relaycore_dedup_blocks_deduped_total 0');
  });
});
