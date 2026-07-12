import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';
import { EventStore, type OptimizationEvent } from '../../src/dashboard/event-store.js';

function makeEvent(overrides: Partial<OptimizationEvent> = {}): OptimizationEvent {
  return {
    ts: Date.now(),
    requestId: 'req-1',
    method: 'POST',
    route: '/v1/messages',
    statusCode: 200,
    durationMs: 42,
    model: 'claude-opus-4-8',
    bytesIn: 1_000,
    bytesOut: 400,
    dedup: { blocksDeduped: 1, estTokensSaved: 100 },
    pxpipe: {
      blocksConverted: 0,
      pagesRendered: 0,
      estTokensSaved: 0,
      cacheHits: 0,
      renderFailures: 0,
      upstreamRejected: false,
    },
    ...overrides,
  };
}

describe('EventStore', () => {
  let dir: string;

  function storeIn(subdir: string, retentionDays = 30): EventStore {
    const config = loadConfig({
      RELAYCORE_DATA_DIR: join(dir, subdir),
      DASHBOARD_RETENTION_DAYS: String(retentionDays),
    });
    return new EventStore(config);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relaycore-events-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty list when the file does not exist yet', async () => {
    const store = storeIn('missing');
    expect(await store.readAll()).toEqual([]);
  });

  it('creates the data directory and round-trips appended events', async () => {
    const store = storeIn('created');
    const a = makeEvent({ requestId: 'a' });
    const b = makeEvent({ requestId: 'b' });
    await store.append(a);
    await store.append(b);
    await store.flush();

    const events = await store.readAll();
    expect(events).toEqual([a, b]);
  });

  it('serializes concurrent appends without interleaving', async () => {
    const store = storeIn('concurrent');
    await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        store.append(makeEvent({ requestId: `r${index}` })),
      ),
    );
    await store.flush();

    const events = await store.readAll();
    expect(events).toHaveLength(10);
    expect(events.map((event) => event.requestId).sort()).toEqual(
      Array.from({ length: 10 }, (_value, index) => `r${index}`).sort(),
    );
  });

  it('skips corrupted lines instead of failing the whole load', async () => {
    const store = storeIn('corrupt');
    await store.append(makeEvent({ requestId: 'good-1' }));
    await store.flush();
    // Inject a broken line + a valid-JSON-but-wrong-shape line.
    writeFileSync(
      store.path,
      `${readFileSync(store.path, 'utf8')}not json at all\n{"foo":"bar"}\n${JSON.stringify(
        makeEvent({ requestId: 'good-2' }),
      )}\n`,
      'utf8',
    );

    const events = await store.readAll();
    expect(events.map((event) => event.requestId)).toEqual(['good-1', 'good-2']);
  });

  it('prunes events older than the retention window and keeps the rest', async () => {
    const store = storeIn('prune', 30);
    const now = Date.now();
    const fresh = makeEvent({ requestId: 'fresh', ts: now - 5 * 24 * 60 * 60 * 1_000 });
    const stale = makeEvent({ requestId: 'stale', ts: now - 40 * 24 * 60 * 60 * 1_000 });
    await store.append(stale);
    await store.append(fresh);
    await store.flush();

    const kept = await store.pruneExpired(now);
    expect(kept.map((event) => event.requestId)).toEqual(['fresh']);
    // The rewrite must have persisted the pruning.
    expect((await store.readAll()).map((event) => event.requestId)).toEqual(['fresh']);
  });

  it('leaves the file untouched when nothing is expired', async () => {
    const store = storeIn('noprune', 30);
    const now = Date.now();
    await store.append(makeEvent({ requestId: 'a', ts: now - 1_000 }));
    await store.flush();
    const before = readFileSync(store.path, 'utf8');

    await store.pruneExpired(now);
    expect(readFileSync(store.path, 'utf8')).toBe(before);
  });

  it('never throws on append when the data dir path is unwritable', async () => {
    // Point the data dir at a path whose parent is a file, forcing mkdir to fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const config = loadConfig({ RELAYCORE_DATA_DIR: join(blocker, 'nested') });
    const store = new EventStore(config);

    await expect(store.append(makeEvent())).resolves.toBeUndefined();
    expect(await store.readAll()).toEqual([]);
  });
});
