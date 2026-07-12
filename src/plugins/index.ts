import type { RenderCache } from '../pxpipe/render-cache.js';
import type { TextRenderer } from '../pxpipe/renderer.js';
import { createDedupPlugin } from './builtin/dedup-plugin.js';
import { createPxpipePlugin } from './builtin/pxpipe-plugin.js';
import { PluginRegistry } from './registry.js';

export { PluginRegistry } from './registry.js';
export type { TransformOutcome } from './registry.js';
export type { PluginContext, PluginStats, RelayPlugin, TransformResult } from './types.js';
export { createDedupPlugin } from './builtin/dedup-plugin.js';
export { createPxpipePlugin } from './builtin/pxpipe-plugin.js';

/**
 * Builds the default registry with the two built-in optimizers in the required
 * order: **dedup first** (collapses duplicate blocks into short references), then
 * **pxpipe** (renders remaining large blocks to images). Order is fixed here for
 * correctness — pxpipe must not spend work rendering content dedup already
 * removed. Each optimizer is a no-op when its own flag is disabled.
 */
export function createBuiltinPlugins(renderer: TextRenderer, cache: RenderCache): PluginRegistry {
  return new PluginRegistry([createDedupPlugin(), createPxpipePlugin(renderer, cache)]);
}
