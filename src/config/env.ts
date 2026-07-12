import 'dotenv/config';

import { z } from 'zod';

const environmentSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(47_822),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  UPSTREAM_BASE_URL: z.url().default('https://api.oneprovider.dev'),
  UPSTREAM_API_KEY: z.string().trim().optional(),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(120_000),
  DEBUG_TOKEN: z.string().trim().min(16).optional(),
});

export type AppConfig = Readonly<{
  host: string;
  port: number;
  environment: 'development' | 'test' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  upstreamTimeoutMs: number;
  debugToken?: string;
}>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }

  return Object.freeze({
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    environment: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    upstreamBaseUrl: parsed.data.UPSTREAM_BASE_URL.replace(/\/$/, ''),
    upstreamApiKey: parsed.data.UPSTREAM_API_KEY || undefined,
    upstreamTimeoutMs: parsed.data.UPSTREAM_TIMEOUT_MS,
    debugToken: parsed.data.DEBUG_TOKEN || undefined,
  });
}
