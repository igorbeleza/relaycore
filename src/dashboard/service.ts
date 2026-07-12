import type { AppConfig } from '../config/env.js';
import { StatsAggregator, type StatsSnapshot } from './aggregator.js';
import { EventStore, type EventStoreLogger, type OptimizationEvent } from './event-store.js';

/**
 * Coordinates the dashboard's two collaborators: the in-memory
 * {@link StatsAggregator} that answers the polling endpoint, and the on-disk
 * {@link EventStore} that survives restarts. Recording an event updates the
 * live aggregate synchronously and persists it best-effort in the background,
 * so the hot request path never blocks on disk I/O.
 */
export class DashboardService {
  private readonly aggregator: StatsAggregator;
  private readonly store: EventStore;

  public constructor(config: AppConfig, logger?: EventStoreLogger) {
    this.aggregator = new StatsAggregator(config.dashboardRecentLimit);
    this.store = new EventStore(config, logger);
  }

  /**
   * Prunes expired events on disk and seeds the aggregator from the survivors.
   * Best-effort: store failures resolve to an empty seed rather than throwing.
   */
  public async initialize(): Promise<void> {
    const events = await this.store.pruneExpired();
    this.aggregator.seed(events);
  }

  /** Updates the live aggregate and queues a best-effort persistent append. */
  public record(event: OptimizationEvent): void {
    this.aggregator.record(event);
    void this.store.append(event);
  }

  /** Materializes the current view served to the polling dashboard. */
  public snapshot(now?: number): StatsSnapshot {
    return this.aggregator.snapshot(now);
  }

  /** Waits for all queued persistent appends to settle (tests/shutdown). */
  public flush(): Promise<void> {
    return this.store.flush();
  }

  /** Absolute path of the backing event-store file. */
  public get storePath(): string {
    return this.store.path;
  }
}
