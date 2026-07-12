import type { AppConfig } from '../../config/env.js';
import { dedupeRequestBody } from '../../dedup/index.js';
import type { PluginContext, RelayPlugin, TransformResult } from '../types.js';

/**
 * Built-in reference plugin wrapping the byte-for-byte block deduplicator.
 * Collapses duplicated content blocks into short backreferences, records its own
 * metrics/logs, and reports savings so the request path (and dashboard) can pick
 * them up under the stable key `dedup`.
 */
export function createDedupPlugin(): RelayPlugin {
  return {
    name: 'dedup',
    isEnabled: (config: AppConfig): boolean => config.dedupEnabled === true,
    transformRequest(body: unknown, ctx: PluginContext): TransformResult {
      const { body: nextBody, stats } = dedupeRequestBody(body, ctx.config);
      const changed = stats.blocksDeduped > 0;

      if (changed) {
        ctx.metrics.recordDedup(stats.blocksDeduped, stats.estTokensSaved);
        ctx.logger.info(
          {
            requestId: ctx.requestId,
            blocksDeduped: stats.blocksDeduped,
            estTokensSaved: stats.estTokensSaved,
          },
          'dedup replaced duplicate request blocks with references',
        );
      }

      return {
        body: nextBody,
        changed,
        stats: { estTokensSaved: stats.estTokensSaved, blocksDeduped: stats.blocksDeduped },
      };
    },
  };
}
