import type { AppConfig } from '../config/env.js';

export const PAGE_WIDTH_PX = 1568;
export const FONT_SIZE_PX = 10;
export const CHAR_WIDTH_PX = 6;
export const LINE_HEIGHT_PX = 12;
export const COLUMNS_PER_LINE = 258;
export const LINES_PER_PAGE = 130;
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

export function layoutLines(text: string): string[] {
  const lines: string[] = [];
  for (const rawLine of text.replaceAll('\t', '  ').split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    for (let offset = 0; offset < rawLine.length; offset += COLUMNS_PER_LINE) {
      lines.push(rawLine.slice(offset, offset + COLUMNS_PER_LINE));
    }
  }
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
