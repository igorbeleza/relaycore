export type DiagnosticErrorSource =
  | 'upstream_http_error'
  | 'upstream_configuration_error'
  | 'upstream_request_error'
  | 'missing_client_credentials';

export type DiagnosticErrorRecord = Readonly<{
  requestId: string;
  occurredAt: string;
  source: DiagnosticErrorSource;
  method: string;
  route: string;
  model?: string;
  statusCode: number;
  upstreamStatus?: number;
  upstreamRequestId?: string;
  errorType: string;
  errorMessage: string;
}>;

export type DiagnosticErrorFilters = Readonly<{
  statusCode?: number;
  errorType?: string;
}>;

export class DiagnosticsRegistry {
  private readonly errors: DiagnosticErrorRecord[] = [];

  public constructor(private readonly maxErrors = 50) {}

  public recordError(error: Omit<DiagnosticErrorRecord, 'occurredAt'>): DiagnosticErrorRecord {
    const record = Object.freeze({
      ...error,
      occurredAt: new Date().toISOString(),
    });
    this.errors.push(record);

    if (this.errors.length > this.maxErrors) {
      this.errors.splice(0, this.errors.length - this.maxErrors);
    }

    return record;
  }

  public getLastError(): DiagnosticErrorRecord | undefined {
    return this.errors.at(-1);
  }

  public listErrors(filters: DiagnosticErrorFilters = {}): DiagnosticErrorRecord[] {
    return this.errors
      .filter(
        (error) => filters.statusCode === undefined || error.statusCode === filters.statusCode,
      )
      .filter((error) => filters.errorType === undefined || error.errorType === filters.errorType)
      .slice()
      .reverse();
  }
}
