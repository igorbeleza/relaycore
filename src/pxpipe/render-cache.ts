import { createHash } from 'node:crypto';

import type { RenderedPage } from './renderer.js';

export type RenderCacheOptions = Readonly<{
  maxEntries?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
  now?: () => number;
}>;

type CacheEntry = {
  pages: readonly RenderedPage[];
  bytes: number;
  expiresAt: number;
};

export class RenderCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: RenderCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.now = options.now ?? Date.now;
  }

  public key(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  public get(key: string): readonly RenderedPage[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.pages;
  }

  public set(key: string, pages: readonly RenderedPage[]): void {
    this.delete(key);
    const bytes = pages.reduce((sum, rendered) => sum + rendered.png.byteLength, 0);
    this.entries.set(key, { pages, bytes, expiresAt: this.now() + this.ttlMs });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldestKey = this.entries.keys().next().value;
      // A single oversized entry is kept; evicting it would defeat caching entirely.
      if (oldestKey === undefined || oldestKey === key) break;
      this.delete(oldestKey);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}
