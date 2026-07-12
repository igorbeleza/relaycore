import type { AppConfig } from '../config/env.js';
import { dedupeRequestBody, type DedupStats } from '../dedup/index.js';
import type { RenderCache } from '../pxpipe/render-cache.js';
import type { TextRenderer } from '../pxpipe/renderer.js';
import { transformRequestBody, type PxpipeStats } from '../pxpipe/transform.js';

export type OptimizationStats = Readonly<{
  dedup: DedupStats;
  pxpipe: PxpipeStats;
}>;

export type OptimizationResult = Readonly<{
  body: unknown;
  stats: OptimizationStats;
}>;

/**
 * Runs the request-body optimizers in a fixed order — dedup first, then pxpipe —
 * and returns the transformed body plus each stage's stats.
 *
 * Order matters: dedup collapses repeated blocks into short references *before*
 * pxpipe evaluates blocks for image rendering, so pxpipe never spends work
 * rendering content that dedup already removed. Each optimizer is an
 * independent no-op when its own flag is disabled, so this is safe to call
 * unconditionally. This is the single point from which aggregated savings are
 * read (e.g. by the metrics layer and the future dashboard).
 */
export async function optimizeRequestBody(
  body: unknown,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
): Promise<OptimizationResult> {
  const dedup = dedupeRequestBody(body, config);
  const pxpipe = await transformRequestBody(dedup.body, config, renderer, cache);
  return {
    body: pxpipe.body,
    stats: { dedup: dedup.stats, pxpipe: pxpipe.stats },
  };
}
