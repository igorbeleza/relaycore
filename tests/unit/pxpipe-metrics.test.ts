import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from '../../src/metrics/metrics-registry.js';

describe('pxpipe metrics', () => {
  it('renders zeroed pxpipe counters by default', () => {
    const output = new MetricsRegistry().renderPrometheus();
    expect(output).toContain('relaycore_pxpipe_blocks_converted_total 0');
    expect(output).toContain('relaycore_pxpipe_tokens_saved_estimate_total 0');
    expect(output).toContain('relaycore_pxpipe_render_failures_total 0');
    expect(output).toContain('relaycore_pxpipe_upstream_rejected_total 0');
  });

  it('accumulates pxpipe counters', () => {
    const metrics = new MetricsRegistry();
    metrics.recordPxpipeConversion(2, 3_500);
    metrics.recordPxpipeConversion(1, 1_500);
    metrics.recordPxpipeRenderFailure();
    metrics.recordPxpipeUpstreamRejection();
    const output = metrics.renderPrometheus();
    expect(output).toContain('relaycore_pxpipe_blocks_converted_total 3');
    expect(output).toContain('relaycore_pxpipe_tokens_saved_estimate_total 5000');
    expect(output).toContain('relaycore_pxpipe_render_failures_total 1');
    expect(output).toContain('relaycore_pxpipe_upstream_rejected_total 1');
  });
});
