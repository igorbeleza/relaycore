import type { AppConfig } from '../config/env.js';
import { evaluateBlock } from './estimator.js';
import type { RenderCache } from './render-cache.js';
import type { RenderedPage, TextRenderer } from './renderer.js';

export type PxpipeStats = {
  blocksConverted: number;
  pagesRendered: number;
  estTokensSaved: number;
  cacheHits: number;
  renderFailures: number;
};

export type PxpipeResult = Readonly<{
  body: unknown;
  stats: PxpipeStats;
}>;

type ContentBlock = Record<string, unknown>;

function emptyStats(): PxpipeStats {
  return {
    blocksConverted: 0,
    pagesRendered: 0,
    estTokensSaved: 0,
    cacheHits: 0,
    renderFailures: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildReplacementBlocks(text: string, pages: readonly RenderedPage[]): ContentBlock[] {
  const blocks: ContentBlock[] = pages.map((page) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: page.png.toString('base64') },
  }));
  blocks.push({
    type: 'text',
    text: `[pxpipe: ${text.length} chars rendered as ${pages.length} image page(s); read the image(s) as inline text]`,
  });
  return blocks;
}

async function convertText(
  text: string,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
  stats: PxpipeStats,
): Promise<ContentBlock[] | undefined> {
  const evaluation = evaluateBlock(text, config);
  if (!evaluation.eligible) return undefined;
  const key = cache.key(text);
  let pages = cache.get(key);
  if (pages) {
    stats.cacheHits += 1;
  } else {
    pages = await renderer.renderPages(evaluation.pages);
    cache.set(key, pages);
    stats.pagesRendered += pages.length;
  }
  stats.blocksConverted += 1;
  stats.estTokensSaved += evaluation.estTextTokens - evaluation.estImageTokens;
  return buildReplacementBlocks(text, pages);
}

async function transformToolResult(
  block: ContentBlock,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
  stats: PxpipeStats,
): Promise<ContentBlock> {
  const content = block.content;
  if (typeof content === 'string') {
    const converted = await convertText(content, config, renderer, cache, stats);
    return converted ? { ...block, content: converted } : block;
  }
  if (Array.isArray(content)) {
    const allText = content.every(
      (inner) => isRecord(inner) && inner.type === 'text' && typeof inner.text === 'string',
    );
    if (!allText) return block;
    const nextContent: ContentBlock[] = [];
    let changed = false;
    for (const inner of content as ContentBlock[]) {
      const converted = await convertText(inner.text as string, config, renderer, cache, stats);
      if (converted) {
        nextContent.push(...converted);
        changed = true;
      } else {
        nextContent.push(inner);
      }
    }
    return changed ? { ...block, content: nextContent } : block;
  }
  return block;
}

async function transformBlocks(
  blocks: readonly unknown[],
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
  stats: PxpipeStats,
): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      result.push(block);
      continue;
    }
    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      config.pxpipeScope === 'user_and_tool_results'
    ) {
      const converted = await convertText(block.text, config, renderer, cache, stats);
      if (converted) {
        result.push(...converted);
        continue;
      }
    }
    if (block.type === 'tool_result') {
      result.push(await transformToolResult(block, config, renderer, cache, stats));
      continue;
    }
    result.push(block);
  }
  return result;
}

export async function transformRequestBody(
  body: unknown,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
): Promise<PxpipeResult> {
  const stats = emptyStats();
  if (!config.pxpipeEnabled) return { body, stats };
  try {
    if (!isRecord(body) || !Array.isArray(body.messages)) return { body, stats };
    const messages = body.messages as unknown[];
    const userIndexes = messages.flatMap((message, index) =>
      isRecord(message) && message.role === 'user' ? [index] : [],
    );
    const keep = config.pxpipeKeepRecentTurns;
    const protectedIndexes = new Set(keep === 0 ? [] : userIndexes.slice(-keep));

    const nextMessages: unknown[] = [];
    for (const [index, message] of messages.entries()) {
      if (!isRecord(message) || message.role !== 'user' || protectedIndexes.has(index)) {
        nextMessages.push(message);
        continue;
      }
      if (typeof message.content === 'string' && config.pxpipeScope === 'user_and_tool_results') {
        const converted = await convertText(message.content, config, renderer, cache, stats);
        nextMessages.push(converted ? { ...message, content: converted } : message);
        continue;
      }
      if (Array.isArray(message.content)) {
        nextMessages.push({
          ...message,
          content: await transformBlocks(message.content, config, renderer, cache, stats),
        });
        continue;
      }
      nextMessages.push(message);
    }

    if (stats.blocksConverted === 0) return { body, stats };
    return { body: { ...body, messages: nextMessages }, stats };
  } catch {
    return { body, stats: { ...emptyStats(), renderFailures: 1 } };
  }
}
