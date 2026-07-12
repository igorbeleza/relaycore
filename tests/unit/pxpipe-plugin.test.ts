import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { MetricsRegistry } from '../../src/metrics/metrics-registry.js';
import { createPxpipePlugin } from '../../src/plugins/builtin/pxpipe-plugin.js';
import type { PluginContext } from '../../src/plugins/types.js';
import { RenderCache } from '../../src/pxpipe/render-cache.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';

class FakeRenderer implements TextRenderer {
  public shouldFail = false;

  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    if (this.shouldFail) throw new Error('render failed');
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ PXPIPE_ENABLED: 'true', PXPIPE_KEEP_RECENT_TURNS: '0', ...overrides });
}

function makeLogger(): FastifyBaseLogger {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: 'info' };
  return { ...logger, child: () => logger } as unknown as FastifyBaseLogger;
}

function makeCtx(config: AppConfig, metrics: MetricsRegistry): PluginContext {
  return { config, requestId: 'req-1', logger: makeLogger(), metrics };
}

const BIG = 'x'.repeat(20_000);

function bodyWithBigBlock(): unknown {
  return { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }] };
}

describe('createPxpipePlugin', () => {
  it('is named "pxpipe" and reflects config.pxpipeEnabled', () => {
    const plugin = createPxpipePlugin(new FakeRenderer(), new RenderCache());
    expect(plugin.name).toBe('pxpipe');
    expect(plugin.isEnabled(makeConfig())).toBe(true);
    expect(plugin.isEnabled(makeConfig({ PXPIPE_ENABLED: 'false' }))).toBe(false);
  });

  it('reports changed with stats and records metrics when it converts a block', async () => {
    const metrics = new MetricsRegistry();
    const plugin = createPxpipePlugin(new FakeRenderer(), new RenderCache());
    const result = (await plugin.transformRequest!(bodyWithBigBlock(), makeCtx(makeConfig(), metrics))) as {
      changed: boolean;
      stats: Record<string, number>;
    };

    expect(result.changed).toBe(true);
    expect(result.stats.blocksConverted).toBe(1);
    expect(result.stats.pagesRendered).toBeGreaterThan(0);
    expect(result.stats.renderFailures).toBe(0);
    expect(metrics.renderPrometheus()).toContain('relaycore_pxpipe_blocks_converted_total 1');
  });

  it('fails open (changed:false) and records a render failure when the renderer throws', async () => {
    const metrics = new MetricsRegistry();
    const renderer = new FakeRenderer();
    renderer.shouldFail = true;
    const plugin = createPxpipePlugin(renderer, new RenderCache());
    const result = (await plugin.transformRequest!(bodyWithBigBlock(), makeCtx(makeConfig(), metrics))) as {
      changed: boolean;
      stats: Record<string, number>;
    };

    expect(result.changed).toBe(false);
    expect(result.stats.blocksConverted).toBe(0);
    expect(result.stats.renderFailures).toBeGreaterThan(0);
    expect(metrics.renderPrometheus()).toContain('relaycore_pxpipe_render_failures_total 1');
  });
});
