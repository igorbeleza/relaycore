import { describe, expect, it } from 'vitest';

import { RenderCache } from '../../src/pxpipe/render-cache.js';
import type { RenderedPage } from '../../src/pxpipe/renderer.js';

function page(size: number): RenderedPage {
  return { png: Buffer.alloc(size, 1), width: 1568, height: 1560 };
}

describe('RenderCache', () => {
  it('returns undefined on miss and stored pages on hit', () => {
    const cache = new RenderCache();
    const key = cache.key('hello');
    expect(cache.get(key)).toBeUndefined();
    const pages = [page(10)];
    cache.set(key, pages);
    expect(cache.get(key)).toBe(pages);
  });

  it('derives stable sha256 keys from content', () => {
    const cache = new RenderCache();
    expect(cache.key('same')).toBe(cache.key('same'));
    expect(cache.key('same')).not.toBe(cache.key('different'));
    expect(cache.key('same')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = new RenderCache({ maxEntries: 2 });
    cache.set('a', [page(1)]);
    cache.set('b', [page(1)]);
    expect(cache.get('a')).toBeDefined();
    cache.set('c', [page(1)]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('evicts oldest entries when total bytes exceed the limit', () => {
    const cache = new RenderCache({ maxTotalBytes: 25 });
    cache.set('a', [page(10)]);
    cache.set('b', [page(10)]);
    cache.set('c', [page(10)]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('expires entries after the TTL', () => {
    let currentTime = 0;
    const cache = new RenderCache({ ttlMs: 1_000, now: () => currentTime });
    cache.set('a', [page(1)]);
    currentTime = 999;
    expect(cache.get('a')).toBeDefined();
    currentTime = 1_000;
    expect(cache.get('a')).toBeUndefined();
  });
});
