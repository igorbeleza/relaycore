import type { AppConfig } from '../../config/env.js';
import type { RenderCache } from '../../pxpipe/render-cache.js';
import type { TextRenderer } from '../../pxpipe/renderer.js';
import { transformRequestBody } from '../../pxpipe/transform.js';
import type { PluginContext, RelayPlugin, TransformResult } from '../types.js';

/**
 * Built-in reference plugin wrapping the pxpipe text-to-image transform. Renders
 * large, stable text blocks to PNG image blocks (cheaper to bill) and records its
 * own metrics/logs. Its `renderer` and `cache` dependencies are captured here at
 * construction, so the hook signature stays dependency-free.
 *
 * Note: pxpipe's transform catches its own render errors internally and reports
 * them via `stats.renderFailures` (it does not throw), so this plugin fails open
 * on render errors without relying on the registry's catch.
 */
export function createPxpipePlugin(renderer: TextRenderer, cache: RenderCache): RelayPlugin {
  return {
    name: 'pxpipe',
    isEnabled: (config: AppConfig): boolean => config.pxpipeEnabled === true,
    async transformRequest(body: unknown, ctx: PluginContext): Promise<TransformResult> {
      const { body: nextBody, stats } = await transformRequestBody(
        body,
        ctx.config,
        renderer,
        cache,
      );

      if (stats.renderFailures > 0) {
        ctx.metrics.recordPxpipeRenderFailure();
        ctx.logger.warn(
          { requestId: ctx.requestId },
          'pxpipe rendering failed; forwarding request body without image conversion',
        );
      }

      const changed = stats.blocksConverted > 0;
      if (changed) {
        ctx.metrics.recordPxpipeConversion(stats.blocksConverted, stats.estTokensSaved);
        ctx.logger.info(
          {
            requestId: ctx.requestId,
            blocksConverted: stats.blocksConverted,
            pagesRendered: stats.pagesRendered,
            estTokensSaved: stats.estTokensSaved,
            cacheHits: stats.cacheHits,
          },
          'pxpipe converted request blocks to images',
        );
      }

      return {
        body: nextBody,
        changed,
        stats: {
          estTokensSaved: stats.estTokensSaved,
          blocksConverted: stats.blocksConverted,
          pagesRendered: stats.pagesRendered,
          cacheHits: stats.cacheHits,
          renderFailures: stats.renderFailures,
        },
      };
    },
  };
}
