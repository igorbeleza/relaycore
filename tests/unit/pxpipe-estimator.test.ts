import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import {
  COLUMNS_PER_LINE,
  IMAGE_TOKENS_PER_PAGE,
  LINES_PER_PAGE,
  estimateTextTokens,
  evaluateBlock,
  layoutLines,
  paginate,
} from '../../src/pxpipe/estimator.js';

const config: AppConfig = loadConfig({ PXPIPE_ENABLED: 'true' });

describe('estimateTextTokens', () => {
  it('estimates one token per four characters, rounded up', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
  });
});

describe('layoutLines', () => {
  it('splits on newlines and wraps long lines at the column limit', () => {
    const text = `short\n${'x'.repeat(COLUMNS_PER_LINE + 10)}`;
    expect(layoutLines(text)).toEqual(['short', 'x'.repeat(COLUMNS_PER_LINE), 'x'.repeat(10)]);
  });

  it('preserves empty lines and expands tabs', () => {
    expect(layoutLines('a\n\n\tb')).toEqual(['a', '', '  b']);
  });
});

describe('paginate', () => {
  it('groups lines into pages of LINES_PER_PAGE', () => {
    const lines = Array.from({ length: LINES_PER_PAGE + 1 }, (_, index) => `line ${index}`);
    const pages = paginate(lines);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(LINES_PER_PAGE);
    expect(pages[1]).toHaveLength(1);
  });
});

describe('evaluateBlock', () => {
  it('rejects blocks below PXPIPE_MIN_CHARS', () => {
    expect(evaluateBlock('x'.repeat(3_999), config)).toEqual({
      eligible: false,
      reason: 'below_min_chars',
    });
  });

  it('rejects blocks that would exceed PXPIPE_MAX_PAGES_PER_BLOCK', () => {
    const text = `${'x'.repeat(10)}\n`.repeat(600);
    expect(evaluateBlock(text, config)).toEqual({ eligible: false, reason: 'too_many_pages' });
  });

  it('rejects blocks whose image cost is not clearly cheaper than text', () => {
    expect(evaluateBlock('x'.repeat(9_000), config)).toEqual({
      eligible: false,
      reason: 'insufficient_savings',
    });
  });

  it('accepts large dense blocks and reports token estimates', () => {
    const result = evaluateBlock('x'.repeat(20_000), config);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.pages).toHaveLength(1);
      expect(result.estTextTokens).toBe(5_000);
      expect(result.estImageTokens).toBe(IMAGE_TOKENS_PER_PAGE);
    }
  });
});
