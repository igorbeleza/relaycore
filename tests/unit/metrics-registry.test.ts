import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from '../../src/metrics/metrics-registry.js';

describe('MetricsRegistry', () => {
  it('exports Prometheus metrics without request contents', () => {
    const metrics = new MetricsRegistry();
    metrics.startRequest();
    metrics.completeRequest({
      method: 'POST',
      route: '/v1/messages',
      statusCode: 200,
      durationMs: 125,
    });

    const output = metrics.renderPrometheus();

    expect(output).toContain('relaycore_http_requests_in_flight 0');
    expect(output).toContain(
      'relaycore_http_requests_total{method="POST",route="/v1/messages",status_code="200"} 1',
    );
    expect(output).toContain(
      'relaycore_http_request_duration_seconds_total{method="POST",route="/v1/messages",status_code="200"} 0.125',
    );
  });

  it('exports upstream error counters grouped by status code and error type', () => {
    const metrics = new MetricsRegistry();
    metrics.recordUpstreamError(400, 'invalid_request_error');
    metrics.recordUpstreamError(400, 'invalid_request_error');
    metrics.recordUpstreamError(429, 'rate_limit_error');

    const output = metrics.renderPrometheus();

    expect(output).toContain(
      '# HELP relaycore_upstream_errors_total Upstream provider errors grouped by status code and error type.',
    );
    expect(output).toContain(
      'relaycore_upstream_errors_total{status_code="400",error_type="invalid_request_error"} 2',
    );
    expect(output).toContain(
      'relaycore_upstream_errors_total{status_code="429",error_type="rate_limit_error"} 1',
    );
  });

  it('exports plugin failure counters keyed by plugin name', () => {
    const metrics = new MetricsRegistry();
    metrics.recordPluginFailure('dedup');
    metrics.recordPluginFailure('pxpipe');
    metrics.recordPluginFailure('pxpipe');

    const output = metrics.renderPrometheus();

    expect(output).toContain(
      '# TYPE relaycore_plugin_failures_total counter',
    );
    expect(output).toContain('relaycore_plugin_failures_total{plugin="dedup"} 1');
    expect(output).toContain('relaycore_plugin_failures_total{plugin="pxpipe"} 2');
  });
});
