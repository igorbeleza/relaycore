import { performance } from 'node:perf_hooks';

import type { AppConfig } from '../config/env.js';
import type { OptimizationEvent } from '../dashboard/event-store.js';
import type { PluginContext, PluginStats, RelayPlugin } from './types.js';

export type TransformOutcome = Readonly<{
  /** The body after every enabled transform ran (unchanged input if none applied). */
  body: unknown;
  /** True if at least one transform reported a real change. */
  changed: boolean;
  /** Per-plugin stats, keyed by plugin name, for plugins that ran without throwing. */
  statsByPlugin: Readonly<Record<string, PluginStats>>;
}>;

/**
 * Holds the ordered set of plugins and runs their hooks with per-plugin fault
 * isolation (SRS REQ-F-062).
 *
 * A throwing plugin is *skipped* (fail-open): the request proceeds with the body
 * it had before that plugin ran, the failure is counted on the metrics registry
 * and logged, and later plugins still run. This mirrors pxpipe's existing
 * render-failure fail-open behaviour, generalised to every plugin.
 */
export class PluginRegistry {
  private readonly plugins: readonly RelayPlugin[];

  public constructor(plugins: readonly RelayPlugin[]) {
    this.plugins = plugins;
  }

  /** Plugin names in execution order (introspection / docs / diagnostics). */
  public get names(): readonly string[] {
    return this.plugins.map((plugin) => plugin.name);
  }

  /** True when at least one plugin with a transform hook is enabled for `config`. */
  public hasEnabledTransforms(config: AppConfig): boolean {
    return this.plugins.some(
      (plugin) => plugin.transformRequest !== undefined && plugin.isEnabled(config),
    );
  }

  /**
   * Runs every enabled `transformRequest` hook in registration order, threading
   * the body through each. Fail-open per plugin.
   */
  public async runTransforms(body: unknown, ctx: PluginContext): Promise<TransformOutcome> {
    let current = body;
    let changed = false;
    const statsByPlugin: Record<string, PluginStats> = {};

    for (const plugin of this.plugins) {
      if (plugin.transformRequest === undefined || !plugin.isEnabled(ctx.config)) continue;
      const startedAt = performance.now();
      try {
        const result = await plugin.transformRequest(current, ctx);
        ctx.metrics.recordPluginTransformDuration(plugin.name, performance.now() - startedAt);
        statsByPlugin[plugin.name] = result.stats;
        if (result.changed) {
          current = result.body;
          changed = true;
        }
      } catch (error) {
        ctx.metrics.recordPluginTransformDuration(plugin.name, performance.now() - startedAt);
        this.recordFailure(plugin.name, error, ctx);
      }
    }

    return { body: current, changed, statsByPlugin };
  }

  /** Runs every enabled `onComplete` hook. Read-only and fail-open. */
  public runOnComplete(event: OptimizationEvent, ctx: PluginContext): void {
    for (const plugin of this.plugins) {
      if (plugin.onComplete === undefined || !plugin.isEnabled(ctx.config)) continue;
      try {
        plugin.onComplete(event, ctx);
      } catch (error) {
        this.recordFailure(plugin.name, error, ctx);
      }
    }
  }

  private recordFailure(name: string, error: unknown, ctx: PluginContext): void {
    ctx.metrics.recordPluginFailure(name);
    ctx.logger.warn(
      {
        requestId: ctx.requestId,
        plugin: name,
        error: error instanceof Error ? error.message : String(error),
      },
      'plugin hook failed; skipping and continuing (fail-open)',
    );
  }
}
