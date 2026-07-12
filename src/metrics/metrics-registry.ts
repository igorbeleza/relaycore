type RequestMetric = Readonly<{
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}>;

type MetricKey = `${string}|${string}|${number}`;
type UpstreamErrorMetricKey = `${number}|${string}`;

type RequestAggregate = {
  count: number;
  durationSecondsTotal: number;
};

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export class MetricsRegistry {
  private readonly requests = new Map<MetricKey, RequestAggregate>();
  private readonly upstreamErrors = new Map<UpstreamErrorMetricKey, number>();
  private inFlight = 0;

  public startRequest(): void {
    this.inFlight += 1;
  }

  public completeRequest(metric: RequestMetric): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const key: MetricKey = `${metric.method}|${metric.route}|${metric.statusCode}`;
    const aggregate = this.requests.get(key) ?? { count: 0, durationSecondsTotal: 0 };
    aggregate.count += 1;
    aggregate.durationSecondsTotal += metric.durationMs / 1_000;
    this.requests.set(key, aggregate);
  }

  public recordUpstreamError(statusCode: number, errorType: string): void {
    const key: UpstreamErrorMetricKey = `${statusCode}|${errorType}`;
    this.upstreamErrors.set(key, (this.upstreamErrors.get(key) ?? 0) + 1);
  }

  public renderPrometheus(): string {
    const lines = [
      '# HELP relaycore_http_requests_in_flight Number of HTTP requests currently being handled.',
      '# TYPE relaycore_http_requests_in_flight gauge',
      `relaycore_http_requests_in_flight ${this.inFlight}`,
      '# HELP relaycore_http_requests_total Completed HTTP requests.',
      '# TYPE relaycore_http_requests_total counter',
      '# HELP relaycore_http_request_duration_seconds_total Total duration of completed HTTP requests.',
      '# TYPE relaycore_http_request_duration_seconds_total counter',
      '# HELP relaycore_upstream_errors_total Upstream provider errors grouped by status code and error type.',
      '# TYPE relaycore_upstream_errors_total counter',
    ];

    for (const [key, aggregate] of this.requests) {
      const [method, route, statusCode] = key.split('|');
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_code="${statusCode}"`;
      lines.push(`relaycore_http_requests_total{${labels}} ${aggregate.count}`);
      lines.push(
        `relaycore_http_request_duration_seconds_total{${labels}} ${aggregate.durationSecondsTotal}`,
      );
    }

    for (const [key, count] of this.upstreamErrors) {
      const [statusCode, errorType] = key.split('|');
      const labels = `status_code="${statusCode}",error_type="${escapeLabel(errorType)}"`;
      lines.push(`relaycore_upstream_errors_total{${labels}} ${count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}
