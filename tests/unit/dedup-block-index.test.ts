import { describe, expect, it } from 'vitest';

import { DedupIndex, hashText, normalizeLineEndings } from '../../src/dedup/block-index.js';
import { previewOf } from '../../src/dedup/estimator.js';

describe('normalizeLineEndings', () => {
  it('collapses CRLF and lone CR to LF only', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('leaves everything else untouched', () => {
    expect(normalizeLineEndings('a  b\tC')).toBe('a  b\tC');
  });
});

describe('hashText', () => {
  it('treats CRLF and LF variants as identical', () => {
    expect(hashText('line one\r\nline two')).toBe(hashText('line one\nline two'));
  });

  it('treats any other difference as distinct', () => {
    expect(hashText('Hello world')).not.toBe(hashText('hello world'));
    expect(hashText('a b')).not.toBe(hashText('a  b'));
  });
});

describe('DedupIndex', () => {
  it('returns undefined for the first occurrence and a stable ref for repeats', () => {
    const index = new DedupIndex();
    expect(index.reference('same content')).toBeUndefined();
    const second = index.reference('same content');
    const third = index.reference('same content');
    expect(second).toBeDefined();
    expect(second).toBe(third);
  });

  it('uses line-ending-normalized equality', () => {
    const index = new DedupIndex();
    expect(index.reference('x\r\ny')).toBeUndefined();
    expect(index.reference('x\ny')).toBeDefined();
  });
});

describe('previewOf', () => {
  it('collapses whitespace to a single line', () => {
    expect(previewOf('  multi\n   line\ttext  ')).toBe('multi line text');
  });

  it('truncates long previews with an ellipsis', () => {
    const preview = previewOf('y'.repeat(200));
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBe(49);
  });
});
