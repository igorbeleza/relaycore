import type { OptimizationEvent } from './event-store.js';

const MS_PER_HOUR = 60 * 60 * 1_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const HOURLY_WINDOW = 24;
const DAILY_WINDOW = 30;
const DURATION_SAMPLE_CAP = 10_000;
const DEFAULT_RECENT_LIMIT = 50;

/** Estimated input tokens for a body, mirroring the char→token heuristic (~4 chars/token). */
function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export type TimeBucket = Readonly<{
  start: number;
  requests: number;
  tokensSaved: number;
}>;

export type RecentRequest = Readonly<{
  ts: number;
  requestId: string;
  route: string;
  model?: string;
  statusCode: number;
  durationMs: number;
  tokensSaved: number;
}>;

export type StatsSnapshot = Readonly<{
  generatedAt: number;
  windowFrom: number | null;
  totals: Readonly<{
    requests: number;
    tokensSaved: number;
    dedupTokensSaved: number;
    pxpipeTokensSaved: number;
    blocksDeduped: number;
    blocksConverted: number;
    pagesRendered: number;
    cacheHits: number;
    renderFailures: number;
    upstreamRejections: number;
    estInputTokens: number;
    savingsPct: number;
    bytesIn: number;
    bytesOut: number;
  }>;
  traffic: Readonly<{
    requests: number;
    avgDurationMs: number;
    p95DurationMs: number;
    errorsByStatus: readonly Readonly<{ statusCode: number; count: number }>[];
  }>;
  hourly: readonly TimeBucket[];
  daily: readonly TimeBucket[];
  recent: readonly RecentRequest[];
}>;

type MutableBucket = { requests: number; tokensSaved: number };

/**
 * Incremental in-memory aggregation of optimization events. Seeded once from the
 * event store at startup, then updated per-request via `record` — it never
 * re-reads the file on the hot path. `snapshot` materializes the view served to
 * the dashboard's polling endpoint.
 */
export class StatsAggregator {
  private readonly recentLimit: number;

  private requests = 0;
  private dedupTokensSaved = 0;
  private pxpipeTokensSaved = 0;
  private blocksDeduped = 0;
  private blocksConverted = 0;
  private pagesRendered = 0;
  private cacheHits = 0;
  private renderFailures = 0;
  private upstreamRejections = 0;
  private estInputTokens = 0;
  private bytesIn = 0;
  private bytesOut = 0;
  private durationSumMs = 0;
  private windowFrom: number | null = null;

  private readonly durationSamples: number[] = [];
  private durationCursor = 0;
  private readonly errorsByStatus = new Map<number, number>();
  private readonly hourly = new Map<number, MutableBucket>();
  private readonly daily = new Map<number, MutableBucket>();
  private readonly recent: RecentRequest[] = [];

  public constructor(recentLimit: number = DEFAULT_RECENT_LIMIT) {
    this.recentLimit = Math.max(1, recentLimit);
  }

  /** Seeds the aggregator from a batch of persisted events (chronological order assumed). */
  public seed(events: readonly OptimizationEvent[]): void {
    for (const event of events) this.record(event);
  }

  public record(event: OptimizationEvent): void {
    const dedupSaved = event.dedup.estTokensSaved;
    const pxpipeSaved = event.pxpipe.estTokensSaved;

    this.requests += 1;
    this.dedupTokensSaved += dedupSaved;
    this.pxpipeTokensSaved += pxpipeSaved;
    this.blocksDeduped += event.dedup.blocksDeduped;
    this.blocksConverted += event.pxpipe.blocksConverted;
    this.pagesRendered += event.pxpipe.pagesRendered;
    this.cacheHits += event.pxpipe.cacheHits;
    this.renderFailures += event.pxpipe.renderFailures;
    if (event.pxpipe.upstreamRejected) this.upstreamRejections += 1;
    this.estInputTokens += estimateTokensFromBytes(event.bytesIn);
    this.bytesIn += event.bytesIn;
    this.bytesOut += event.bytesOut;
    this.durationSumMs += event.durationMs;

    this.windowFrom =
      this.windowFrom === null ? event.ts : Math.min(this.windowFrom, event.ts);

    this.sampleDuration(event.durationMs);

    if (event.statusCode >= 400) {
      this.errorsByStatus.set(event.statusCode, (this.errorsByStatus.get(event.statusCode) ?? 0) + 1);
    }

    const tokensSaved = dedupSaved + pxpipeSaved;
    this.addToBucket(this.hourly, Math.floor(event.ts / MS_PER_HOUR) * MS_PER_HOUR, tokensSaved);
    this.addToBucket(this.daily, Math.floor(event.ts / MS_PER_DAY) * MS_PER_DAY, tokensSaved);

    this.recent.unshift({
      ts: event.ts,
      requestId: event.requestId,
      route: event.route,
      model: event.model,
      statusCode: event.statusCode,
      durationMs: event.durationMs,
      tokensSaved,
    });
    if (this.recent.length > this.recentLimit) this.recent.length = this.recentLimit;
  }

  private sampleDuration(durationMs: number): void {
    if (this.durationSamples.length < DURATION_SAMPLE_CAP) {
      this.durationSamples.push(durationMs);
      return;
    }
    // Ring buffer: overwrite oldest sample once the cap is reached.
    this.durationSamples[this.durationCursor] = durationMs;
    this.durationCursor = (this.durationCursor + 1) % DURATION_SAMPLE_CAP;
  }

  private addToBucket(map: Map<number, MutableBucket>, start: number, tokensSaved: number): void {
    const bucket = map.get(start) ?? { requests: 0, tokensSaved: 0 };
    bucket.requests += 1;
    bucket.tokensSaved += tokensSaved;
    map.set(start, bucket);
  }

  private percentile(pct: number): number {
    if (this.durationSamples.length === 0) return 0;
    const sorted = [...this.durationSamples].sort((a, b) => a - b);
    const rank = Math.ceil((pct / 100) * sorted.length) - 1;
    const index = Math.min(sorted.length - 1, Math.max(0, rank));
    return sorted[index];
  }

  private materializeSeries(
    map: Map<number, MutableBucket>,
    step: number,
    count: number,
    now: number,
  ): TimeBucket[] {
    const latest = Math.floor(now / step) * step;
    const oldest = latest - (count - 1) * step;
    // Prune buckets that have fallen out of the window to keep memory bounded.
    for (const start of map.keys()) {
      if (start < oldest) map.delete(start);
    }
    const series: TimeBucket[] = [];
    for (let start = oldest; start <= latest; start += step) {
      const bucket = map.get(start);
      series.push({
        start,
        requests: bucket?.requests ?? 0,
        tokensSaved: bucket?.tokensSaved ?? 0,
      });
    }
    return series;
  }

  public snapshot(now: number = Date.now()): StatsSnapshot {
    const tokensSaved = this.dedupTokensSaved + this.pxpipeTokensSaved;
    const savingsPct =
      this.estInputTokens > 0 ? (tokensSaved / this.estInputTokens) * 100 : 0;

    const errorsByStatus = [...this.errorsByStatus.entries()]
      .map(([statusCode, count]) => ({ statusCode, count }))
      .sort((a, b) => b.count - a.count || a.statusCode - b.statusCode);

    return {
      generatedAt: now,
      windowFrom: this.windowFrom,
      totals: {
        requests: this.requests,
        tokensSaved,
        dedupTokensSaved: this.dedupTokensSaved,
        pxpipeTokensSaved: this.pxpipeTokensSaved,
        blocksDeduped: this.blocksDeduped,
        blocksConverted: this.blocksConverted,
        pagesRendered: this.pagesRendered,
        cacheHits: this.cacheHits,
        renderFailures: this.renderFailures,
        upstreamRejections: this.upstreamRejections,
        estInputTokens: this.estInputTokens,
        savingsPct,
        bytesIn: this.bytesIn,
        bytesOut: this.bytesOut,
      },
      traffic: {
        requests: this.requests,
        avgDurationMs: this.requests > 0 ? this.durationSumMs / this.requests : 0,
        p95DurationMs: this.percentile(95),
        errorsByStatus,
      },
      hourly: this.materializeSeries(this.hourly, MS_PER_HOUR, HOURLY_WINDOW, now),
      daily: this.materializeSeries(this.daily, MS_PER_DAY, DAILY_WINDOW, now),
      recent: [...this.recent],
    };
  }
}
