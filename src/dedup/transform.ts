import type { AppConfig } from '../config/env.js';
import { DedupIndex } from './block-index.js';
import { buildReference, estimateTextTokens, previewOf } from './estimator.js';

export type DedupStats = {
  blocksDeduped: number;
  estTokensSaved: number;
};

export type DedupResult = Readonly<{
  body: unknown;
  stats: DedupStats;
}>;

type ContentBlock = Record<string, unknown>;

function emptyStats(): DedupStats {
  return { blocksDeduped: 0, estTokensSaved: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Attempts to replace `text` with a backward reference.
 * Returns the reference string when the block is a repeat AND the reference is
 * genuinely shorter than the original; otherwise `undefined` (keep verbatim).
 */
function referenceFor(
  text: string,
  config: AppConfig,
  index: DedupIndex,
  stats: DedupStats,
): string | undefined {
  if (text.length < config.dedupMinChars) return undefined;
  const refId = index.reference(text);
  if (refId === undefined) return undefined; // first occurrence — keep as-is
  const reference = buildReference(refId, previewOf(text));
  if (reference.length >= text.length) return undefined; // would not save — keep
  stats.blocksDeduped += 1;
  stats.estTokensSaved += estimateTextTokens(text) - estimateTextTokens(reference);
  return reference;
}

function dedupeToolResult(
  block: ContentBlock,
  config: AppConfig,
  index: DedupIndex,
  stats: DedupStats,
): ContentBlock {
  const content = block.content;
  if (typeof content === 'string') {
    const reference = referenceFor(content, config, index, stats);
    return reference !== undefined ? { ...block, content: reference } : block;
  }
  if (Array.isArray(content)) {
    const allText = content.every(
      (inner) => isRecord(inner) && inner.type === 'text' && typeof inner.text === 'string',
    );
    if (!allText) return block;
    let changed = false;
    const nextContent = (content as ContentBlock[]).map((inner) => {
      const reference = referenceFor(inner.text as string, config, index, stats);
      if (reference === undefined) return inner;
      changed = true;
      return { ...inner, text: reference };
    });
    return changed ? { ...block, content: nextContent } : block;
  }
  return block;
}

function dedupeBlocks(
  blocks: readonly unknown[],
  config: AppConfig,
  index: DedupIndex,
  stats: DedupStats,
): unknown[] {
  return blocks.map((block) => {
    if (!isRecord(block)) return block;
    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      config.dedupScope === 'user_and_tool_results'
    ) {
      const reference = referenceFor(block.text, config, index, stats);
      return reference !== undefined ? { ...block, text: reference } : block;
    }
    if (block.type === 'tool_result') {
      return dedupeToolResult(block, config, index, stats);
    }
    return block;
  });
}

function dedupeUserMessage(
  message: ContentBlock,
  config: AppConfig,
  index: DedupIndex,
  stats: DedupStats,
): unknown {
  if (typeof message.content === 'string' && config.dedupScope === 'user_and_tool_results') {
    const reference = referenceFor(message.content, config, index, stats);
    return reference !== undefined ? { ...message, content: reference } : message;
  }
  if (Array.isArray(message.content)) {
    return { ...message, content: dedupeBlocks(message.content, config, index, stats) };
  }
  return message;
}

/**
 * Removes byte-for-byte duplicate content blocks from a Messages API request
 * body, keeping the first occurrence verbatim and replacing later occurrences
 * with a short backward reference.
 *
 * Runs BEFORE pxpipe. Preserves the cacheable prefix (never rewrites a first
 * occurrence). No-op when disabled, on malformed bodies, or when nothing is
 * duplicated. Never mutates the input body.
 */
export function dedupeRequestBody(body: unknown, config: AppConfig): DedupResult {
  const stats = emptyStats();
  if (!config.dedupEnabled) return { body, stats };
  if (!isRecord(body) || !Array.isArray(body.messages)) return { body, stats };

  const messages = body.messages as unknown[];
  const userIndexes = messages.flatMap((message, index) =>
    isRecord(message) && message.role === 'user' ? [index] : [],
  );
  const keep = config.dedupKeepRecentTurns;
  // The protected turns are always the most recent user turns, i.e. the tail of
  // the message array, so anything after them is safe to leave untouched.
  const protectedIndexes = new Set(keep === 0 ? [] : userIndexes.slice(-keep));

  const index = new DedupIndex();
  const nextMessages: unknown[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!isRecord(message) || message.role !== 'user' || protectedIndexes.has(messageIndex)) {
      nextMessages.push(message);
      continue;
    }
    nextMessages.push(dedupeUserMessage(message, config, index, stats));
  }

  if (stats.blocksDeduped === 0) return { body, stats };
  return { body: { ...body, messages: nextMessages }, stats };
}
