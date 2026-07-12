import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from '../../src/metrics/metrics-registry.js';

describe('dedup metrics', () => {
  it('renders zeroed dedup counters by default', () => {
    const output = new MetricsRegistry().renderPrometheus();
    expect(output).toContain('relaycore_dedup_blocks_deduped_total 0');
    expect(output).toContain('relaycore_dedup_tokens_saved_estimate_total 0');
  });

  it('accumulates dedup counters', () => {
    const metrics = new MetricsRegistry();
    metrics.recordDedup(2, 1_200);
    metrics.recordDedup(3, 800);
    const output = metrics.renderPrometheus();
    expect(output).toContain('relaycore_dedup_blocks_deduped_total 5');
    expect(output).toContain('relaycore_dedup_tokens_saved_estimate_total 2000');
  });
});
