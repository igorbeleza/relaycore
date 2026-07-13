import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import type { OptimizationEvent } from '../../src/dashboard/event-store.js';
import { MetricsRegistry } from '../../src/metrics/metrics-registry.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { PluginContext, RelayPlugin } from '../../src/plugins/types.js';

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ UPSTREAM_API_KEY: 'sk-test', ...overrides });
}

function makeLogger(): FastifyBaseLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  };
  // Fastify loggers are self-referential via child(); good enough for tests.
  return { ...logger, child: () => logger } as unknown as FastifyBaseLogger;
}

function makeCtx(config: AppConfig, metrics: MetricsRegistry): PluginContext {
  return { config, requestId: 'req-1', logger: makeLogger(), metrics };
}

/** A trivial always-enabled transform plugin that appends a marker to a string body. */
function markerPlugin(name: string, marker: string): RelayPlugin {
  return {
    name,
    isEnabled: () => true,
    transformRequest(body: unknown) {
      return { body: `${String(body)}${marker}`, changed: true, stats: { estTokensSaved: 1 } };
    },
  };
}

describe('PluginRegistry', () => {
  it('exposes plugin names in registration order', () => {
    const registry = new PluginRegistry([markerPlugin('a', 'A'), markerPlugin('b', 'B')]);
    expect(registry.names).toEqual(['a', 'b']);
  });

  it('threads the body through enabled transforms in order', async () => {
    const registry = new PluginRegistry([markerPlugin('a', '-A'), markerPlugin('b', '-B')]);
    const outcome = await registry.runTransforms(
      'start',
      makeCtx(makeConfig(), new MetricsRegistry()),
    );

    expect(outcome.body).toBe('start-A-B');
    expect(outcome.changed).toBe(true);
    expect(outcome.statsByPlugin).toEqual({ a: { estTokensSaved: 1 }, b: { estTokensSaved: 1 } });
  });

  it('skips disabled plugins for both hasEnabledTransforms and runTransforms', async () => {
    const disabled: RelayPlugin = { ...markerPlugin('off', '-X'), isEnabled: () => false };
    const registry = new PluginRegistry([disabled]);
    const config = makeConfig();

    expect(registry.hasEnabledTransforms(config)).toBe(false);
    const outcome = await registry.runTransforms('start', makeCtx(config, new MetricsRegistry()));
    expect(outcome.body).toBe('start');
    expect(outcome.changed).toBe(false);
    expect(outcome.statsByPlugin).toEqual({});
  });

  it('reports no enabled transforms when a plugin only observes', () => {
    const observer: RelayPlugin = { name: 'obs', isEnabled: () => true, onComplete: () => {} };
    expect(new PluginRegistry([observer]).hasEnabledTransforms(makeConfig())).toBe(false);
  });

  it('isolates a throwing transform (fail-open) and lets later plugins run', async () => {
    const boom: RelayPlugin = {
      name: 'boom',
      isEnabled: () => true,
      transformRequest() {
        throw new Error('kaboom');
      },
    };
    const metrics = new MetricsRegistry();
    const registry = new PluginRegistry([markerPlugin('a', '-A'), boom, markerPlugin('b', '-B')]);

    const outcome = await registry.runTransforms('start', makeCtx(makeConfig(), metrics));

    // 'boom' is skipped; body still carries a's and b's changes.
    expect(outcome.body).toBe('start-A-B');
    expect(outcome.changed).toBe(true);
    expect(outcome.statsByPlugin).not.toHaveProperty('boom');
    expect(metrics.renderPrometheus()).toContain(
      'relaycore_plugin_failures_total{plugin="boom"} 1',
    );
  });

  it('does not mark changed when a transform reports changed:false', async () => {
    const noop: RelayPlugin = {
      name: 'noop',
      isEnabled: () => true,
      transformRequest: (body: unknown) => ({ body, changed: false, stats: { estTokensSaved: 0 } }),
    };
    const outcome = await new PluginRegistry([noop]).runTransforms(
      'start',
      makeCtx(makeConfig(), new MetricsRegistry()),
    );
    expect(outcome.changed).toBe(false);
    expect(outcome.statsByPlugin).toEqual({ noop: { estTokensSaved: 0 } });
  });

  it('records a transform duration sample for each enabled plugin, including throwing ones', async () => {
    const boom: RelayPlugin = {
      name: 'boom',
      isEnabled: () => true,
      transformRequest() {
        throw new Error('kaboom');
      },
    };
    const metrics = new MetricsRegistry();
    const registry = new PluginRegistry([markerPlugin('a', '-A'), boom]);

    await registry.runTransforms('start', makeCtx(makeConfig(), metrics));

    const output = metrics.renderPrometheus();
    expect(output).toContain('relaycore_plugin_transform_duration_seconds_count{plugin="a"} 1');
    expect(output).toContain('relaycore_plugin_transform_duration_seconds_count{plugin="boom"} 1');
  });

  it('isolates a throwing onComplete hook and continues to later plugins', () => {
    const calls: string[] = [];
    const boom: RelayPlugin = {
      name: 'boom',
      isEnabled: () => true,
      onComplete() {
        throw new Error('kaboom');
      },
    };
    const observer: RelayPlugin = {
      name: 'obs',
      isEnabled: () => true,
      onComplete: () => calls.push('obs'),
    };
    const metrics = new MetricsRegistry();
    const registry = new PluginRegistry([boom, observer]);
    const event = { statusCode: 200 } as unknown as OptimizationEvent;

    expect(() => registry.runOnComplete(event, makeCtx(makeConfig(), metrics))).not.toThrow();
    expect(calls).toEqual(['obs']);
    expect(metrics.renderPrometheus()).toContain(
      'relaycore_plugin_failures_total{plugin="boom"} 1',
    );
  });
});
