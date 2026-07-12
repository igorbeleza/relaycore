import { createHash } from 'node:crypto';

/**
 * Normalizes ONLY line-endings (`\r\n` and lone `\r` → `\n`) before hashing.
 *
 * This is deliberately the *only* normalization applied: it absorbs the
 * cross-platform CRLF/LF difference (which is never semantically meaningful)
 * while preserving the "byte-for-byte identical" guarantee for everything else
 * (whitespace, casing, punctuation all remain significant).
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function hashText(text: string): string {
  return createHash('sha256').update(normalizeLineEndings(text)).digest('hex');
}

/**
 * Tracks the first occurrence of each normalized block within a single request
 * and hands out a stable short reference id for it. Walked in document order so
 * references always point backwards to an already-seen block.
 */
export class DedupIndex {
  private readonly seen = new Map<string, string>();

  /**
   * Registers `text`. Returns:
   * - `undefined` if this is the first occurrence (caller keeps it verbatim);
   * - the existing block's `refId` if this is a repeat (caller may reference it).
   */
  public reference(text: string): string | undefined {
    const hash = hashText(text);
    const existing = this.seen.get(hash);
    if (existing !== undefined) return existing;
    this.seen.set(hash, hash.slice(0, 8));
    return undefined;
  }
}
