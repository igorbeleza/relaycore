/**
 * Token/heuristic helpers for the dedup module.
 *
 * Mirrors the pxpipe char→token heuristic (`estimateTextTokens`) so the two
 * optimizers report savings on the same scale, while keeping the modules
 * independent (no cross-import between src/dedup and src/pxpipe).
 */

const PREVIEW_MAX_CHARS = 48;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A short, single-line preview of a block used to help the model locate the
 * original occurrence a reference points back to. Whitespace is collapsed so
 * the preview stays on one line regardless of the source formatting.
 */
export function previewOf(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= PREVIEW_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, PREVIEW_MAX_CHARS)}…`;
}

/**
 * The placeholder that replaces a duplicate block. It:
 * - points strictly backwards ("bloco anterior") so it is always resolvable;
 * - carries a stable `#dedup-<refId>` so multiple placeholders sharing the same
 *   original are recognizably the same group;
 * - includes a short preview to disambiguate when several distinct blocks are
 *   deduplicated within one request.
 */
export function buildReference(refId: string, preview: string): string {
  return `[conteúdo idêntico ao bloco anterior #dedup-${refId} deste request (início: "${preview}") — omitido para economizar tokens de entrada]`;
}
