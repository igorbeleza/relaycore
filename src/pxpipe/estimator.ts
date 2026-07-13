import type { AppConfig } from '../config/env.js';

export const PAGE_WIDTH_PX = 1568;
export const FONT_SIZE_PX = 10;
export const CHAR_WIDTH_PX = 6;
export const LINE_HEIGHT_PX = 12;
// Geometry aligned with the teamchong/pxpipe reference implementation's Claude
// profile (312 columns x 91 lines/page), which is calibrated against real
// upstream token billing. Page height stays derived from this renderer's own
// font metrics rather than copying the reference's 728px (which assumes a
// denser bitmap font), so IMAGE_TOKENS_PER_PAGE reflects what we actually draw.
export const COLUMNS_PER_LINE = 312;
export const LINES_PER_PAGE = 91;
export const PAGE_HEIGHT_PX = LINES_PER_PAGE * LINE_HEIGHT_PX;
export const IMAGE_TOKENS_PER_PAGE = Math.ceil((PAGE_WIDTH_PX * PAGE_HEIGHT_PX) / 750);

export type BlockEvaluation =
  | Readonly<{
      eligible: true;
      pages: string[][];
      estTextTokens: number;
      estImageTokens: number;
    }>
  | Readonly<{
      eligible: false;
      reason: 'below_min_chars' | 'too_many_pages' | 'insufficient_savings';
    }>;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LINE_JOIN_SEPARATOR = ' ';

/**
 * Splits text into page rows, packing consecutive short original lines onto a
 * single row (joined by a space) up to COLUMNS_PER_LINE. Real text (code,
 * logs, JSON) averages far fewer characters per line than the column budget,
 * so preserving a strict one-input-line-per-row mapping (as a naive wrap
 * would) wastes most of each page's capacity and makes the image nearly
 * always more expensive than the text it replaces. Blank lines and
 * already-overlong lines still force a row break, preserving paragraph/block
 * structure and existing hard-wrap behavior.
 */
export function layoutLines(text: string): string[] {
  const lines: string[] = [];
  let pendingRow = '';

  const flushPendingRow = () => {
    if (pendingRow.length > 0) {
      lines.push(pendingRow);
      pendingRow = '';
    }
  };

  for (const rawLine of text.replaceAll('\t', '  ').split('\n')) {
    if (rawLine.length === 0) {
      flushPendingRow();
      lines.push('');
      continue;
    }
    if (rawLine.length > COLUMNS_PER_LINE) {
      flushPendingRow();
      for (let offset = 0; offset < rawLine.length; offset += COLUMNS_PER_LINE) {
        lines.push(rawLine.slice(offset, offset + COLUMNS_PER_LINE));
      }
      continue;
    }
    const candidate =
      pendingRow.length === 0 ? rawLine : pendingRow + LINE_JOIN_SEPARATOR + rawLine;
    if (candidate.length > COLUMNS_PER_LINE) {
      flushPendingRow();
      pendingRow = rawLine;
    } else {
      pendingRow = candidate;
    }
  }
  flushPendingRow();
  return lines;
}

export function paginate(lines: readonly string[]): string[][] {
  const pages: string[][] = [];
  for (let offset = 0; offset < lines.length; offset += LINES_PER_PAGE) {
    pages.push([...lines.slice(offset, offset + LINES_PER_PAGE)]);
  }
  return pages;
}

export function evaluateBlock(text: string, config: AppConfig): BlockEvaluation {
  if (text.length < config.pxpipeMinChars) {
    return { eligible: false, reason: 'below_min_chars' };
  }
  const pages = paginate(layoutLines(text));
  if (pages.length > config.pxpipeMaxPagesPerBlock) {
    return { eligible: false, reason: 'too_many_pages' };
  }
  const estTextTokens = estimateTextTokens(text);
  const estImageTokens = pages.length * IMAGE_TOKENS_PER_PAGE;
  if (estImageTokens >= estTextTokens * config.pxpipeSavingsFactor) {
    return { eligible: false, reason: 'insufficient_savings' };
  }
  return { eligible: true, pages, estTextTokens, estImageTokens };
}
