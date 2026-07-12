import type { FastifyBaseLogger } from 'fastify';

import type { AppConfig } from '../config/env.js';
import type { OptimizationEvent } from '../dashboard/event-store.js';
import type { MetricsRegistry } from '../metrics/metrics-registry.js';

/**
 * Per-plugin transform statistics. Always carries an `estTokensSaved` estimate;
 * built-in plugins add their own numeric detail fields (e.g. dedup's
 * `blocksDeduped`, pxpipe's `blocksConverted`). Values are plain numbers so the
 * whole record can be aggregated and — for the known built-ins — mapped onto the
 * dashboard's typed event fields by the messages route.
 */
export type PluginStats = Readonly<Record<string, number>>;

/** Result of a plugin's request-body transform. */
export type TransformResult = Readonly<{
  /** The (possibly) rewritten body. */
  body: unknown;
  /**
   * Whether `body` actually differs from the input. MUST be true only on a real
   * change: it drives the route's "retry once with the original body on upstream
   * 400" safety net, so a false positive would waste an upstream round-trip.
   */
  changed: boolean;
  /** Savings/telemetry for this plugin's contribution to the request. */
  stats: PluginStats;
}>;

/**
 * Read-only context handed to every plugin hook. Plugins observe it but never
 * mutate it. `metrics`/`logger` let a plugin own its observability (record its
 * own counters and structured logs), exactly as the built-ins do.
 */
export type PluginContext = Readonly<{
  config: AppConfig;
  requestId: string;
  logger: FastifyBaseLogger;
  metrics: MetricsRegistry;
}>;

/**
 * A RelayCore plugin. Both hooks are optional: a plugin may transform requests,
 * observe completions, or both. Plugins are constructed with their dependencies
 * at startup and registered in a fixed order (see {@link PluginRegistry}).
 *
 * Fault isolation is the registry's job — a plugin may throw from either hook
 * and the registry will skip it (fail-open) without failing the request.
 */
export interface RelayPlugin {
  /** Stable identifier; used as the key in metrics, logs and aggregated stats. */
  readonly name: string;
  /** Whether this plugin is active for the given config. Called per request. */
  isEnabled(config: AppConfig): boolean;
  /**
   * Ordered request-body transform, run before the request is forwarded upstream.
   * Omit for observe-only plugins.
   */
  transformRequest?(body: unknown, ctx: PluginContext): Promise<TransformResult> | TransformResult;
  /**
   * Read-only hook fired after every response (success or error). For streaming
   * responses it fires when the stream *starts*, and `event.bytesOut` is 0 —
   * a pre-existing limitation inherited from the dashboard recorder.
   */
  onComplete?(event: OptimizationEvent, ctx: PluginContext): void;
}
