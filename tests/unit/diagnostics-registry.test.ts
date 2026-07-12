import { describe, expect, it } from 'vitest';

import { DiagnosticsRegistry } from '../../src/diagnostics/diagnostics-registry.js';

function recordError(
  diagnostics: DiagnosticsRegistry,
  requestId: string,
  statusCode: number,
  errorType: string,
): void {
  diagnostics.recordError({
    requestId,
    source: 'upstream_http_error',
    method: 'POST',
    route: '/v1/messages',
    statusCode,
    upstreamStatus: statusCode,
    errorType,
    errorMessage: 'Sanitized error.',
  });
}

describe('DiagnosticsRegistry', () => {
  it('keeps the latest error and lists recent errors newest-first', () => {
    const diagnostics = new DiagnosticsRegistry();
    recordError(diagnostics, 'req_1', 400, 'invalid_request_error');
    recordError(diagnostics, 'req_2', 429, 'rate_limit_error');

    expect(diagnostics.getLastError()?.requestId).toBe('req_2');
    expect(diagnostics.listErrors().map((error) => error.requestId)).toEqual(['req_2', 'req_1']);
  });

  it('keeps only the configured number of recent errors', () => {
    const diagnostics = new DiagnosticsRegistry(2);
    recordError(diagnostics, 'req_1', 400, 'invalid_request_error');
    recordError(diagnostics, 'req_2', 429, 'rate_limit_error');
    recordError(diagnostics, 'req_3', 500, 'api_error');

    expect(diagnostics.listErrors().map((error) => error.requestId)).toEqual(['req_3', 'req_2']);
  });

  it('filters by status code and error type', () => {
    const diagnostics = new DiagnosticsRegistry();
    recordError(diagnostics, 'req_1', 400, 'invalid_request_error');
    recordError(diagnostics, 'req_2', 429, 'rate_limit_error');
    recordError(diagnostics, 'req_3', 400, 'invalid_request_error');

    expect(diagnostics.listErrors({ statusCode: 400 }).map((error) => error.requestId)).toEqual([
      'req_3',
      'req_1',
    ]);
    expect(diagnostics.listErrors({ errorType: 'rate_limit_error' })).toHaveLength(1);
    expect(diagnostics.listErrors({ statusCode: 400, errorType: 'rate_limit_error' })).toEqual([]);
  });
});
