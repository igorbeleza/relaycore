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
    if (!this.config.upstreamApiKey) {
      throw new UpstreamConfigurationError();
    }

    const headers = new Headers({
      'content-type': 'application/json',
      'x-api-key': this.config.upstreamApiKey,
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
