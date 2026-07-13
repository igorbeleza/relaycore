import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '../config/env.js';

/**
 * A single optimized request, persisted as one JSON line in events.jsonl.
 * Contains only metadata — never prompt/response content.
 */
export type OptimizationEvent = Readonly<{
  ts: number;
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  model?: string;
  bytesIn: number;
  bytesOut: number;
  dedup: Readonly<{
    blocksDeduped: number;
    estTokensSaved: number;
  }>;
  pxpipe: Readonly<{
    blocksConverted: number;
    pagesRendered: number;
    estTokensSaved: number;
    cacheHits: number;
    renderFailures: number;
    upstreamRejected: boolean;
  }>;
  /** Stable session identifier derived from the request body. */
  sessionId?: string;
}>;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const DATA_FILE_NAME = 'events.jsonl';

export type EventStoreLogger = Readonly<{
  warn: (details: Record<string, unknown>, message: string) => void;
}>;

const NOOP_LOGGER: EventStoreLogger = { warn: () => {} };

/** Extract a stable session ID from a request body (hash of first 256 bytes). */
export function extractSessionId(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const raw = JSON.stringify(body);
  return createHash('sha256').update(raw.slice(0, 256)).digest('hex').slice(0, 8);
}

function resolveDataDir(config: AppConfig): string {
  return config.relaycoreDataDir ?? join(homedir(), '.relaycore');
}

function isOptimizationEvent(value: unknown): value is OptimizationEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.ts === 'number' &&
    typeof event.requestId === 'string' &&
    typeof event.statusCode === 'number' &&
    typeof event.durationMs === 'number' &&
    typeof event.dedup === 'object' &&
    event.dedup !== null &&
    typeof event.pxpipe === 'object' &&
    event.pxpipe !== null
  );
}

/**
 * Append-only, best-effort persistence of optimization events on disk.
 *
 * I/O failures never throw to the caller — they are logged and swallowed so a
 * failing disk can never take down or slow the request path. Appends are
 * serialized through an internal promise chain to avoid interleaved writes.
 */
export class EventStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly retentionDays: number;
  private readonly logger: EventStoreLogger;
  private writeChain: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  public constructor(config: AppConfig, logger: EventStoreLogger = NOOP_LOGGER) {
    this.dir = resolveDataDir(config);
    this.filePath = join(this.dir, DATA_FILE_NAME);
    this.retentionDays = config.dashboardRetentionDays;
    this.logger = logger;
  }

  public get path(): string {
    return this.filePath;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.dir, { recursive: true });
    this.dirEnsured = true;
  }

  /**
   * Queues a best-effort append of one event. Never rejects; I/O errors are
   * logged and swallowed. Returns the tail of the write chain so callers/tests
   * may await a flush if they want to.
   */
  public append(event: OptimizationEvent): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.ensureDir();
        await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
      } catch (error) {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'dashboard event store append failed (ignored)',
        );
      }
    });
    return this.writeChain;
  }

  /** Waits for all queued appends to settle. */
  public flush(): Promise<void> {
    return this.writeChain;
  }

  /**
   * Reads every event from disk with tolerant parsing: a missing file yields an
   * empty list, and any corrupted/unparseable line is skipped rather than
   * failing the whole load.
   */
  public async readAll(): Promise<OptimizationEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'dashboard event store read failed (treated as empty)',
      );
      return [];
    }

    const events: OptimizationEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isOptimizationEvent(parsed)) events.push(parsed);
      } catch {
        // Corrupted line — skip it, keep loading the rest.
      }
    }
    return events;
  }

  /**
   * Drops events older than the retention window and atomically rewrites the
   * file (tmp + rename). Best-effort: returns the surviving events it loaded
   * (whether or not the rewrite succeeded) so the aggregator can seed itself.
   */
  public async pruneExpired(now: number = Date.now()): Promise<OptimizationEvent[]> {
    const events = await this.readAll();
    const cutoff = now - this.retentionDays * MS_PER_DAY;
    const kept = events.filter((event) => event.ts >= cutoff);

    if (kept.length === events.length) return kept;

    try {
      await this.ensureDir();
      const tmpPath = `${this.filePath}.tmp`;
      const body = kept.map((event) => JSON.stringify(event)).join('\n');
      await writeFile(tmpPath, kept.length > 0 ? `${body}\n` : '', 'utf8');
      await rename(tmpPath, this.filePath);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'dashboard event store prune/rewrite failed (ignored)',
      );
    }

    return kept;
  }
}
