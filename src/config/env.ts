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
  PXPIPE_ENABLED: z.enum(['true', 'false']).default('false'),
  PXPIPE_MIN_CHARS: z.coerce.number().int().min(100).max(1_000_000).default(4_000),
  PXPIPE_SAVINGS_FACTOR: z.coerce.number().min(0.1).max(1).default(0.7),
  PXPIPE_MAX_PAGES_PER_BLOCK: z.coerce.number().int().min(1).max(20).default(4),
  PXPIPE_KEEP_RECENT_TURNS: z.coerce.number().int().min(0).max(50).default(3),
  PXPIPE_SCOPE: z
    .enum(['user_and_tool_results', 'tool_results_only'])
    .default('user_and_tool_results'),
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
  pxpipeEnabled: boolean;
  pxpipeMinChars: number;
  pxpipeSavingsFactor: number;
  pxpipeMaxPagesPerBlock: number;
  pxpipeKeepRecentTurns: number;
  pxpipeScope: 'user_and_tool_results' | 'tool_results_only';
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
    pxpipeEnabled: parsed.data.PXPIPE_ENABLED === 'true',
    pxpipeMinChars: parsed.data.PXPIPE_MIN_CHARS,
    pxpipeSavingsFactor: parsed.data.PXPIPE_SAVINGS_FACTOR,
    pxpipeMaxPagesPerBlock: parsed.data.PXPIPE_MAX_PAGES_PER_BLOCK,
    pxpipeKeepRecentTurns: parsed.data.PXPIPE_KEEP_RECENT_TURNS,
    pxpipeScope: parsed.data.PXPIPE_SCOPE,
  });
}
