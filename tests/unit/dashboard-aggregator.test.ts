import { describe, expect, it } from 'vitest';

import { StatsAggregator } from '../../src/dashboard/aggregator.js';
import type { OptimizationEvent } from '../../src/dashboard/event-store.js';

function makeEvent(overrides: Partial<OptimizationEvent> = {}): OptimizationEvent {
  return {
    ts: Date.now(),
    requestId: 'req',
    method: 'POST',
    route: '/v1/messages',
    statusCode: 200,
    durationMs: 100,
    model: 'claude-opus-4-8',
    bytesIn: 4_000,
    bytesOut: 1_000,
    dedup: { blocksDeduped: 0, estTokensSaved: 0 },
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

describe('StatsAggregator', () => {
  it('reports an empty snapshot before any event', () => {
    const snap = new StatsAggregator().snapshot();
    expect(snap.totals.requests).toBe(0);
    expect(snap.totals.tokensSaved).toBe(0);
    expect(snap.totals.savingsPct).toBe(0);
    expect(snap.windowFrom).toBeNull();
    expect(snap.traffic.p95DurationMs).toBe(0);
    expect(snap.recent).toEqual([]);
    expect(snap.topSessions).toEqual([]);
    expect(snap.allSessions).toEqual([]);
  });

  it('sums dedup and pxpipe savings into lifetime totals', () => {
    const agg = new StatsAggregator();
    agg.record(makeEvent({ dedup: { blocksDeduped: 2, estTokensSaved: 300 } }));
    agg.record(
      makeEvent({
        pxpipe: {
          blocksConverted: 1,
          pagesRendered: 3,
          estTokensSaved: 500,
          cacheHits: 1,
          renderFailures: 0,
          upstreamRejected: false,
        },
      }),
    );

    const snap = agg.snapshot();
    expect(snap.totals.requests).toBe(2);
    expect(snap.totals.dedupTokensSaved).toBe(300);
    expect(snap.totals.pxpipeTokensSaved).toBe(500);
    expect(snap.totals.tokensSaved).toBe(800);
    expect(snap.totals.blocksDeduped).toBe(2);
    expect(snap.totals.blocksConverted).toBe(1);
    expect(snap.totals.pagesRendered).toBe(3);
    expect(snap.totals.cacheHits).toBe(1);
  });

  it('computes savings % against estimated input tokens (~4 chars/token)', () => {
    const agg = new StatsAggregator();
    // bytesIn 4000 → ~1000 est input tokens; saved 250 → 25%.
    agg.record(makeEvent({ bytesIn: 4_000, dedup: { blocksDeduped: 1, estTokensSaved: 250 } }));
    expect(agg.snapshot().totals.savingsPct).toBeCloseTo(25, 5);
  });

  it('tracks the earliest event timestamp as windowFrom', () => {
    const agg = new StatsAggregator();
    agg.record(makeEvent({ ts: 5_000 }));
    agg.record(makeEvent({ ts: 1_000 }));
    agg.record(makeEvent({ ts: 9_000 }));
    expect(agg.snapshot().windowFrom).toBe(1_000);
  });

  it('computes average and p95 latency', () => {
    const agg = new StatsAggregator();
    for (const durationMs of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      agg.record(makeEvent({ durationMs }));
    }
    const { traffic } = agg.snapshot();
    expect(traffic.avgDurationMs).toBeCloseTo(55, 5);
    // ceil(0.95 * 10) - 1 = 9 → the 100 sample.
    expect(traffic.p95DurationMs).toBe(100);
  });

  it('groups errors by status code, most frequent first', () => {
    const agg = new StatsAggregator();
    agg.record(makeEvent({ statusCode: 200 }));
    agg.record(makeEvent({ statusCode: 429 }));
    agg.record(makeEvent({ statusCode: 429 }));
    agg.record(makeEvent({ statusCode: 500 }));

    const { errorsByStatus } = agg.snapshot().traffic;
    expect(errorsByStatus).toEqual([
      { statusCode: 429, count: 2 },
      { statusCode: 500, count: 1 },
    ]);
  });

  it('produces 24 hourly buckets and 30 daily buckets ending at now', () => {
    const now = Date.parse('2026-07-12T12:30:00Z');
    const agg = new StatsAggregator();
    const hourAgo = now - 60 * 60 * 1_000;
    agg.record(makeEvent({ ts: hourAgo, dedup: { blocksDeduped: 1, estTokensSaved: 100 } }));

    const snap = agg.snapshot(now);
    expect(snap.hourly).toHaveLength(24);
    expect(snap.daily).toHaveLength(30);
    // The bucket one hour ago must carry the saved tokens.
    const bucket = snap.hourly.find((b) => b.tokensSaved === 100);
    expect(bucket).toBeDefined();
    expect(bucket?.requests).toBe(1);
    // Buckets are ordered ascending and the last one covers "now".
    const lastStart = snap.hourly[snap.hourly.length - 1].start;
    expect(lastStart).toBe(Math.floor(now / (60 * 60 * 1_000)) * (60 * 60 * 1_000));
  });

  it('keeps only the most recent N requests, newest first', () => {
    const agg = new StatsAggregator(3);
    for (let i = 0; i < 5; i += 1) {
      agg.record(makeEvent({ requestId: `r${i}`, ts: 1_000 + i }));
    }
    const recent = agg.snapshot().recent;
    expect(recent.map((r) => r.requestId)).toEqual(['r4', 'r3', 'r2']);
  });

  it('seed replays a batch of events equivalently to record', () => {
    const events = [
      makeEvent({ requestId: 'a', dedup: { blocksDeduped: 1, estTokensSaved: 100 } }),
      makeEvent({ requestId: 'b', dedup: { blocksDeduped: 2, estTokensSaved: 200 } }),
    ];
    const seeded = new StatsAggregator();
    seeded.seed(events);
    const recorded = new StatsAggregator();
    for (const event of events) recorded.record(event);

    expect(seeded.snapshot().totals).toEqual(recorded.snapshot().totals);
  });
});
