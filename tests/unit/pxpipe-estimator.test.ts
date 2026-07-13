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

  it('packs consecutive short lines into a single row', () => {
    expect(layoutLines('aa\nbb\ncc')).toEqual(['aa bb cc']);
  });

  it('does not pack across a blank line', () => {
    expect(layoutLines('aa\n\nbb')).toEqual(['aa', '', 'bb']);
  });

  it('does not pack across an over-length line', () => {
    const longLine = 'x'.repeat(COLUMNS_PER_LINE + 5);
    expect(layoutLines(`aa\n${longLine}\nbb`)).toEqual([
      'aa',
      'x'.repeat(COLUMNS_PER_LINE),
      'x'.repeat(5),
      'bb',
    ]);
  });

  it('flushes the packed row exactly at the column boundary', () => {
    const fits = 'a'.repeat(COLUMNS_PER_LINE - 3);
    const overflowsByOne = 'bb';
    expect(layoutLines(`${fits}\n${overflowsByOne}`)).toEqual([`${fits} ${overflowsByOne}`]);

    const exact = 'a'.repeat(COLUMNS_PER_LINE - 2);
    expect(layoutLines(`${exact}\n${overflowsByOne}`)).toEqual([exact, overflowsByOne]);
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
    const text = `${'x'.repeat(10)}\n`.repeat(15_000);
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

  it('accepts realistic multi-line code-like text via line packing', () => {
    // Regression guard: short lines (average code line length, not one giant
    // dense line) must still become eligible once packed, or pxpipe silently
    // never activates on real traffic.
    const text = Array.from({ length: 700 }, () => 'a'.repeat(80)).join('\n');
    const result = evaluateBlock(text, config);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.pages).toHaveLength(3);
      expect(result.estTextTokens).toBe(14_175);
      expect(result.estImageTokens).toBe(3 * IMAGE_TOKENS_PER_PAGE);
      expect(result.estImageTokens).toBeLessThan(result.estTextTokens * config.pxpipeSavingsFactor);
    }
  });
});
