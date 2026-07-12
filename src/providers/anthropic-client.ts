import type { AppConfig } from '../config/env.js';

export type UpstreamResponse = Readonly<{
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}>;

export interface AnthropicClient {
  createMessage(requestBody: unknown, headers: Headers): Promise<UpstreamResponse>;
}

export class UpstreamConfigurationError extends Error {
  public constructor() {
    super('UPSTREAM_API_KEY is not configured.');
    this.name = 'UpstreamConfigurationError';
  }
}

export class MissingClientCredentialsError extends Error {
  public constructor() {
    super(
      'Passthrough mode requires client credentials: send an authorization or x-api-key header.',
    );
    this.name = 'MissingClientCredentialsError';
  }
}

/**
 * Resolves the auth headers to send upstream.
 *
 * - Provider mode (UPSTREAM_API_KEY configured): the configured key replaces
 *   whatever credentials the client sent; client credentials never leak upstream.
 * - Passthrough mode (no UPSTREAM_API_KEY): the client's own credentials are
 *   forwarded verbatim — `authorization` (e.g. OAuth bearer tokens from Claude
 *   subscription accounts) and/or `x-api-key`.
 */
export function resolveUpstreamAuthHeaders(
  config: AppConfig,
  inboundHeaders: Headers,
): Record<string, string> {
  if (config.upstreamApiKey) {
    return { 'x-api-key': config.upstreamApiKey };
  }

  const auth: Record<string, string> = {};
  const authorization = inboundHeaders.get('authorization');
  const apiKey = inboundHeaders.get('x-api-key');
  if (authorization) auth['authorization'] = authorization;
  if (apiKey) auth['x-api-key'] = apiKey;
  if (!authorization && !apiKey) throw new MissingClientCredentialsError();
  return auth;
}

export class UpstreamRequestError extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'UpstreamRequestError';
  }
}

export class FetchAnthropicClient implements AnthropicClient {
  public constructor(private readonly config: AppConfig) {}

  public async createMessage(
    requestBody: unknown,
    inboundHeaders: Headers,
  ): Promise<UpstreamResponse> {
    const headers = new Headers({
      'content-type': 'application/json',
      ...resolveUpstreamAuthHeaders(this.config, inboundHeaders),
    });

    for (const headerName of ['anthropic-version', 'anthropic-beta']) {
      const value = inboundHeaders.get(headerName);
      if (value) headers.set(headerName, value);
    }

    try {
      const response = await fetch(`${this.config.upstreamBaseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
      });

      return { status: response.status, headers: response.headers, body: response.body };
    } catch (error) {
      throw new UpstreamRequestError('Unable to reach the upstream provider.', error);
    }
  }
}
