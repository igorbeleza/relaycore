import 'dotenv/config';

import { z } from 'zod';

const environmentSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(47_822),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  UPSTREAM_BASE_URL: z.url().optional(),
  UPSTREAM_MODE: z.enum(['provider', 'passthrough']).optional(),
  UPSTREAM_API_KEY: z.string().trim().optional(),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(120_000),
  MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(100_000_000)
    .default(20_971_520),
  DEBUG_TOKEN: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed === '' ? undefined : trimmed;
    })
    .pipe(z.string().min(16).optional()),
  PXPIPE_ENABLED: z.enum(['true', 'false']).default('false'),
  PXPIPE_MIN_CHARS: z.coerce.number().int().min(100).max(1_000_000).default(4_000),
  PXPIPE_SAVINGS_FACTOR: z.coerce.number().min(0.1).max(1).default(0.7),
  PXPIPE_MAX_PAGES_PER_BLOCK: z.coerce.number().int().min(1).max(20).default(4),
  PXPIPE_KEEP_RECENT_TURNS: z.coerce.number().int().min(0).max(50).default(3),
  PXPIPE_SCOPE: z
    .enum(['user_and_tool_results', 'tool_results_only'])
    .default('user_and_tool_results'),
  DEDUP_ENABLED: z.enum(['true', 'false']).default('false'),
  DEDUP_MIN_CHARS: z.coerce.number().int().min(100).max(1_000_000).default(500),
  DEDUP_SCOPE: z
    .enum(['user_and_tool_results', 'tool_results_only'])
    .default('user_and_tool_results'),
  DEDUP_KEEP_RECENT_TURNS: z.coerce.number().int().min(0).max(50).default(0),
});

export type UpstreamMode = 'provider' | 'passthrough';

export type UpstreamModeSource = 'explicit' | 'inferred';

export type AppConfig = Readonly<{
  host: string;
  port: number;
  environment: 'development' | 'test' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  upstreamBaseUrl: string;
  upstreamMode: UpstreamMode;
  upstreamModeSource: UpstreamModeSource;
  upstreamApiKey?: string;
  upstreamTimeoutMs: number;
  maxRequestBodyBytes: number;
  debugToken?: string;
  pxpipeEnabled: boolean;
  pxpipeMinChars: number;
  pxpipeSavingsFactor: number;
  pxpipeMaxPagesPerBlock: number;
  pxpipeKeepRecentTurns: number;
  pxpipeScope: 'user_and_tool_results' | 'tool_results_only';
  dedupEnabled: boolean;
  dedupMinChars: number;
  dedupScope: 'user_and_tool_results' | 'tool_results_only';
  dedupKeepRecentTurns: number;
}>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }

  const upstreamApiKey = parsed.data.UPSTREAM_API_KEY || undefined;
  const upstreamModeSource: UpstreamModeSource = parsed.data.UPSTREAM_MODE
    ? 'explicit'
    : 'inferred';
  const upstreamMode: UpstreamMode =
    parsed.data.UPSTREAM_MODE ?? (upstreamApiKey ? 'provider' : 'passthrough');

  if (upstreamMode === 'provider' && !upstreamApiKey) {
    throw new Error(
      'Invalid environment configuration: UPSTREAM_MODE=provider requires UPSTREAM_API_KEY to be set',
    );
  }

  if (upstreamMode === 'passthrough' && upstreamApiKey) {
    throw new Error(
      'Invalid environment configuration: UPSTREAM_MODE=passthrough must not be combined with UPSTREAM_API_KEY (remove the key or use UPSTREAM_MODE=provider)',
    );
  }

  const defaultBaseUrl =
    upstreamMode === 'provider' ? 'https://api.oneprovider.dev' : 'https://api.anthropic.com';

  return Object.freeze({
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    environment: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    upstreamBaseUrl: (parsed.data.UPSTREAM_BASE_URL ?? defaultBaseUrl).replace(/\/$/, ''),
    upstreamMode,
    upstreamModeSource,
    upstreamApiKey,
    upstreamTimeoutMs: parsed.data.UPSTREAM_TIMEOUT_MS,
    maxRequestBodyBytes: parsed.data.MAX_REQUEST_BODY_BYTES,
    debugToken: parsed.data.DEBUG_TOKEN || undefined,
    pxpipeEnabled: parsed.data.PXPIPE_ENABLED === 'true',
    pxpipeMinChars: parsed.data.PXPIPE_MIN_CHARS,
    pxpipeSavingsFactor: parsed.data.PXPIPE_SAVINGS_FACTOR,
    pxpipeMaxPagesPerBlock: parsed.data.PXPIPE_MAX_PAGES_PER_BLOCK,
    pxpipeKeepRecentTurns: parsed.data.PXPIPE_KEEP_RECENT_TURNS,
    pxpipeScope: parsed.data.PXPIPE_SCOPE,
    dedupEnabled: parsed.data.DEDUP_ENABLED === 'true',
    dedupMinChars: parsed.data.DEDUP_MIN_CHARS,
    dedupScope: parsed.data.DEDUP_SCOPE,
    dedupKeepRecentTurns: parsed.data.DEDUP_KEEP_RECENT_TURNS,
  });
}
