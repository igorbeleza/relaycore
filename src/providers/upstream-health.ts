import type { AppConfig } from '../config/env.js';

export type UpstreamHealthStatus = 'ok' | 'unconfigured' | 'unreachable';

export type UpstreamHealthResult = Readonly<{
  status: UpstreamHealthStatus;
  configured: boolean;
  reachable: boolean;
  upstreamBaseUrl: string;
  checkedAt: string;
  responseStatus?: number;
  reason?: string;
}>;

export interface UpstreamHealthChecker {
  check(): Promise<UpstreamHealthResult>;
}

export class FetchUpstreamHealthChecker implements UpstreamHealthChecker {
  public constructor(private readonly config: AppConfig) {}

  public async check(): Promise<UpstreamHealthResult> {
    const checkedAt = new Date().toISOString();

    if (!this.config.upstreamApiKey) {
      return {
        status: 'unconfigured',
        configured: false,
        reachable: false,
        upstreamBaseUrl: this.config.upstreamBaseUrl,
        checkedAt,
        reason: 'missing_upstream_api_key',
      };
    }

    try {
      const response = await fetch(this.config.upstreamBaseUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(Math.min(this.config.upstreamTimeoutMs, 5_000)),
      });

      return {
        status: 'ok',
        configured: true,
        reachable: true,
        upstreamBaseUrl: this.config.upstreamBaseUrl,
        checkedAt,
        responseStatus: response.status,
      };
    } catch {
      return {
        status: 'unreachable',
        configured: true,
        reachable: false,
        upstreamBaseUrl: this.config.upstreamBaseUrl,
        checkedAt,
        reason: 'upstream_unreachable',
      };
    }
  }
}
