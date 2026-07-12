# pxpipe Transform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert large text blocks in inbound `POST /v1/messages` requests into PNG image blocks before forwarding upstream, cutting input-token cost (spec: `docs/superpowers/specs/2026-07-11-pxpipe-transform-design.md`).

**Architecture:** A transform stage inside the existing `/v1/messages` route (approach A). New `src/pxpipe/` module: estimator (eligibility gate), renderer (injectable `TextRenderer` + `pureimage` implementation), LRU render cache, and the transform walker. The route forwards the transformed body, retries once with the original body on upstream `400`, and reports `relaycore_pxpipe_*` metrics.

**Tech Stack:** TypeScript (strict, ESM — relative imports use `.js` suffix), Fastify 5, Zod 4, Vitest 3, `pureimage` (pure-JS PNG rasterizer), DejaVu Sans Mono (vendored TTF).

## Global Constraints

- `PXPIPE_ENABLED` defaults to **`false`** (opt-in). Other defaults: `PXPIPE_MIN_CHARS=4000`, `PXPIPE_SAVINGS_FACTOR=0.7`, `PXPIPE_MAX_PAGES_PER_BLOCK=4`, `PXPIPE_KEEP_RECENT_TURNS=3`, `PXPIPE_SCOPE=user_and_tool_results`.
- **Fail-open everywhere:** any pxpipe error must forward the original body; pxpipe must never turn a working request into a failing one.
- Never transform: `system` prompt, `assistant` turns, blocks containing images, the N most recent user turns.
- Page geometry (exact constants): width `1568`px, font `10`px, char width `6`px, line height `12`px, `258` columns/line, `130` lines/page, image tokens/page = `ceil((1568 × 130 × 12) / 750)` = `3262`.
- Text token estimate: `ceil(chars / 4)`.
- Replacement stub text (exact format): `[pxpipe: <N> chars rendered as <M> image page(s); read the image(s) as inline text]`.
- Image block shape: `{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: <base64> } }`.
- Cache: in-memory LRU keyed by `sha256(text)`; defaults `maxEntries=200`, `maxTotalBytes=64 MiB`, `ttlMs=3_600_000`. No disk persistence.
- On upstream `400` for a transformed request: retry **once** with the original body; count `relaycore_pxpipe_upstream_rejected_total`.
- Metric names (exact): `relaycore_pxpipe_blocks_converted_total`, `relaycore_pxpipe_tokens_saved_estimate_total`, `relaycore_pxpipe_render_failures_total`, `relaycore_pxpipe_upstream_rejected_total`.
- Logs never contain block text, image bytes, or keys — only counts/IDs.
- Rendering must be deterministic: identical input → byte-identical PNG (preserves upstream prompt-cache).
- Windows shell: use `npm.cmd` / `npx.cmd` in PowerShell.
- Every task ends with the full gate green: `npm.cmd run format` then `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`.

## File Map

| Path                                                                       | Responsibility                                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/config/env.ts`                                                        | Add the six `PXPIPE_*` variables (Task 1)                                        |
| `src/pxpipe/estimator.ts`                                                  | Geometry constants, token math, line layout, eligibility gate (Task 2)           |
| `src/pxpipe/renderer.ts`                                                   | `RenderedPage` / `TextRenderer` contract (Task 3) + `PureImageRenderer` (Task 4) |
| `src/pxpipe/render-cache.ts`                                               | LRU cache with TTL and byte budget (Task 3)                                      |
| `src/pxpipe/transform.ts`                                                  | Request-body walker, block replacement, fail-open (Task 5)                       |
| `src/metrics/metrics-registry.ts`                                          | pxpipe counters (Task 6)                                                         |
| `src/routes/messages.ts` + `src/app/create-app.ts`                         | Wiring, 400-retry, logging (Task 7)                                              |
| `assets/fonts/`                                                            | Vendored DejaVuSansMono.ttf + license (Task 4)                                   |
| `README.md`, `.env.example`, `docs/architecture-overview.md`, `Dockerfile` | Docs & packaging (Task 8)                                                        |

---

### Task 1: pxpipe configuration

**Files:**

- Modify: `src/config/env.ts`
- Create: `tests/unit/pxpipe-config.test.ts`
- Modify: every test file whose `AppConfig` object literal fails typecheck (at least `tests/integration/messages.test.ts:13-20`)

**Interfaces:**

- Consumes: existing `loadConfig(environment?)` / `AppConfig`.
- Produces: `AppConfig` gains `pxpipeEnabled: boolean`, `pxpipeMinChars: number`, `pxpipeSavingsFactor: number`, `pxpipeMaxPagesPerBlock: number`, `pxpipeKeepRecentTurns: number`, `pxpipeScope: 'user_and_tool_results' | 'tool_results_only'`. All later tasks read these fields.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pxpipe-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';

describe('pxpipe configuration', () => {
  it('is disabled by default with conservative values', () => {
    const config = loadConfig({});
    expect(config.pxpipeEnabled).toBe(false);
    expect(config.pxpipeMinChars).toBe(4000);
    expect(config.pxpipeSavingsFactor).toBe(0.7);
    expect(config.pxpipeMaxPagesPerBlock).toBe(4);
    expect(config.pxpipeKeepRecentTurns).toBe(3);
    expect(config.pxpipeScope).toBe('user_and_tool_results');
  });

  it('parses explicit pxpipe values', () => {
    const config = loadConfig({
      PXPIPE_ENABLED: 'true',
      PXPIPE_MIN_CHARS: '8000',
      PXPIPE_SAVINGS_FACTOR: '0.5',
      PXPIPE_MAX_PAGES_PER_BLOCK: '2',
      PXPIPE_KEEP_RECENT_TURNS: '5',
      PXPIPE_SCOPE: 'tool_results_only',
    });
    expect(config.pxpipeEnabled).toBe(true);
    expect(config.pxpipeMinChars).toBe(8000);
    expect(config.pxpipeSavingsFactor).toBe(0.5);
    expect(config.pxpipeMaxPagesPerBlock).toBe(2);
    expect(config.pxpipeKeepRecentTurns).toBe(5);
    expect(config.pxpipeScope).toBe('tool_results_only');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PXPIPE_ENABLED: 'yes' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => loadConfig({ PXPIPE_SAVINGS_FACTOR: '1.5' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/unit/pxpipe-config.test.ts`
Expected: FAIL — `pxpipeEnabled` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement**

In `src/config/env.ts`, add to `environmentSchema` (after the `DEBUG_TOKEN` line):

```ts
  PXPIPE_ENABLED: z.enum(['true', 'false']).default('false'),
  PXPIPE_MIN_CHARS: z.coerce.number().int().min(100).max(1_000_000).default(4_000),
  PXPIPE_SAVINGS_FACTOR: z.coerce.number().min(0.1).max(1).default(0.7),
  PXPIPE_MAX_PAGES_PER_BLOCK: z.coerce.number().int().min(1).max(20).default(4),
  PXPIPE_KEEP_RECENT_TURNS: z.coerce.number().int().min(0).max(50).default(3),
  PXPIPE_SCOPE: z
    .enum(['user_and_tool_results', 'tool_results_only'])
    .default('user_and_tool_results'),
```

Add to the `AppConfig` type (after `debugToken?: string;`):

```ts
pxpipeEnabled: boolean;
pxpipeMinChars: number;
pxpipeSavingsFactor: number;
pxpipeMaxPagesPerBlock: number;
pxpipeKeepRecentTurns: number;
pxpipeScope: 'user_and_tool_results' | 'tool_results_only';
```

Add to the returned `Object.freeze({ ... })` (after `debugToken: ...`):

```ts
    pxpipeEnabled: parsed.data.PXPIPE_ENABLED === 'true',
    pxpipeMinChars: parsed.data.PXPIPE_MIN_CHARS,
    pxpipeSavingsFactor: parsed.data.PXPIPE_SAVINGS_FACTOR,
    pxpipeMaxPagesPerBlock: parsed.data.PXPIPE_MAX_PAGES_PER_BLOCK,
    pxpipeKeepRecentTurns: parsed.data.PXPIPE_KEEP_RECENT_TURNS,
    pxpipeScope: parsed.data.PXPIPE_SCOPE,
```

- [ ] **Step 4: Fix `AppConfig` literals in existing tests**

Run: `npm.cmd run typecheck`
Expected: errors like `Property 'pxpipeEnabled' is missing in type ...` pointing at test files (`tests/integration/messages.test.ts` and possibly others). In **each** flagged object literal, append:

```ts
  pxpipeEnabled: false,
  pxpipeMinChars: 4000,
  pxpipeSavingsFactor: 0.7,
  pxpipeMaxPagesPerBlock: 4,
  pxpipeKeepRecentTurns: 3,
  pxpipeScope: 'user_and_tool_results',
```

Re-run `npm.cmd run typecheck` until clean.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx.cmd vitest run tests/unit/pxpipe-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "feat(pxpipe): add PXPIPE_* configuration (REQ-F-100)"
```

---

### Task 2: Estimator and eligibility gate

**Files:**

- Create: `src/pxpipe/estimator.ts`
- Create: `tests/unit/pxpipe-estimator.test.ts`

**Interfaces:**

- Consumes: `AppConfig` from Task 1.
- Produces (used by Tasks 4, 5):
  - Constants: `PAGE_WIDTH_PX = 1568`, `FONT_SIZE_PX = 10`, `CHAR_WIDTH_PX = 6`, `LINE_HEIGHT_PX = 12`, `COLUMNS_PER_LINE = 258`, `LINES_PER_PAGE = 130`, `PAGE_HEIGHT_PX`, `IMAGE_TOKENS_PER_PAGE = 3262`.
  - `estimateTextTokens(text: string): number`
  - `layoutLines(text: string): string[]`
  - `paginate(lines: readonly string[]): string[][]`
  - `evaluateBlock(text: string, config: AppConfig): BlockEvaluation` where `BlockEvaluation = { eligible: true; pages: string[][]; estTextTokens: number; estImageTokens: number } | { eligible: false; reason: 'below_min_chars' | 'too_many_pages' | 'insufficient_savings' }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pxpipe-estimator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import {
  COLUMNS_PER_LINE,
  IMAGE_TOKENS_PER_PAGE,
  LINES_PER_PAGE,
  estimateTextTokens,
  evaluateBlock,
  layoutLines,
  paginate,
} from '../../src/pxpipe/estimator.js';

const config: AppConfig = loadConfig({ PXPIPE_ENABLED: 'true' });

describe('estimateTextTokens', () => {
  it('estimates one token per four characters, rounded up', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
  });
});

describe('layoutLines', () => {
  it('splits on newlines and wraps long lines at the column limit', () => {
    const text = `short\n${'x'.repeat(COLUMNS_PER_LINE + 10)}`;
    expect(layoutLines(text)).toEqual(['short', 'x'.repeat(COLUMNS_PER_LINE), 'x'.repeat(10)]);
  });

  it('preserves empty lines and expands tabs', () => {
    expect(layoutLines('a\n\n\tb')).toEqual(['a', '', '  b']);
  });
});

describe('paginate', () => {
  it('groups lines into pages of LINES_PER_PAGE', () => {
    const lines = Array.from({ length: LINES_PER_PAGE + 1 }, (_, index) => `line ${index}`);
    const pages = paginate(lines);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(LINES_PER_PAGE);
    expect(pages[1]).toHaveLength(1);
  });
});

describe('evaluateBlock', () => {
  it('rejects blocks below PXPIPE_MIN_CHARS', () => {
    expect(evaluateBlock('x'.repeat(3_999), config)).toEqual({
      eligible: false,
      reason: 'below_min_chars',
    });
  });

  it('rejects blocks that would exceed PXPIPE_MAX_PAGES_PER_BLOCK', () => {
    const text = `${'x'.repeat(10)}\n`.repeat(600);
    expect(evaluateBlock(text, config)).toEqual({ eligible: false, reason: 'too_many_pages' });
  });

  it('rejects blocks whose image cost is not clearly cheaper than text', () => {
    expect(evaluateBlock('x'.repeat(9_000), config)).toEqual({
      eligible: false,
      reason: 'insufficient_savings',
    });
  });

  it('accepts large dense blocks and reports token estimates', () => {
    const result = evaluateBlock('x'.repeat(20_000), config);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.pages).toHaveLength(1);
      expect(result.estTextTokens).toBe(5_000);
      expect(result.estImageTokens).toBe(IMAGE_TOKENS_PER_PAGE);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/unit/pxpipe-estimator.test.ts`
Expected: FAIL — cannot resolve `../../src/pxpipe/estimator.js`.

- [ ] **Step 3: Implement**

Create `src/pxpipe/estimator.ts`:

```ts
import type { AppConfig } from '../config/env.js';

export const PAGE_WIDTH_PX = 1568;
export const FONT_SIZE_PX = 10;
export const CHAR_WIDTH_PX = 6;
export const LINE_HEIGHT_PX = 12;
export const COLUMNS_PER_LINE = 258;
export const LINES_PER_PAGE = 130;
export const PAGE_HEIGHT_PX = LINES_PER_PAGE * LINE_HEIGHT_PX;
export const IMAGE_TOKENS_PER_PAGE = Math.ceil((PAGE_WIDTH_PX * PAGE_HEIGHT_PX) / 750);

export type BlockEvaluation =
  | Readonly<{
      eligible: true;
      pages: string[][];
      estTextTokens: number;
      estImageTokens: number;
    }>
  | Readonly<{
      eligible: false;
      reason: 'below_min_chars' | 'too_many_pages' | 'insufficient_savings';
    }>;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function layoutLines(text: string): string[] {
  const lines: string[] = [];
  for (const rawLine of text.replaceAll('\t', '  ').split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    for (let offset = 0; offset < rawLine.length; offset += COLUMNS_PER_LINE) {
      lines.push(rawLine.slice(offset, offset + COLUMNS_PER_LINE));
    }
  }
  return lines;
}

export function paginate(lines: readonly string[]): string[][] {
  const pages: string[][] = [];
  for (let offset = 0; offset < lines.length; offset += LINES_PER_PAGE) {
    pages.push([...lines.slice(offset, offset + LINES_PER_PAGE)]);
  }
  return pages;
}

export function evaluateBlock(text: string, config: AppConfig): BlockEvaluation {
  if (text.length < config.pxpipeMinChars) {
    return { eligible: false, reason: 'below_min_chars' };
  }
  const pages = paginate(layoutLines(text));
  if (pages.length > config.pxpipeMaxPagesPerBlock) {
    return { eligible: false, reason: 'too_many_pages' };
  }
  const estTextTokens = estimateTextTokens(text);
  const estImageTokens = pages.length * IMAGE_TOKENS_PER_PAGE;
  if (estImageTokens >= estTextTokens * config.pxpipeSavingsFactor) {
    return { eligible: false, reason: 'insufficient_savings' };
  }
  return { eligible: true, pages, estTextTokens, estImageTokens };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/unit/pxpipe-estimator.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "feat(pxpipe): token estimator and eligibility gate"
```

---

### Task 3: Renderer contract and LRU render cache

**Files:**

- Create: `src/pxpipe/renderer.ts` (types only in this task)
- Create: `src/pxpipe/render-cache.ts`
- Create: `tests/unit/pxpipe-render-cache.test.ts`

**Interfaces:**

- Produces (used by Tasks 4, 5, 7):

```ts
// src/pxpipe/renderer.ts
export type RenderedPage = Readonly<{ png: Buffer; width: number; height: number }>;
export interface TextRenderer {
  renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]>;
}

// src/pxpipe/render-cache.ts
export class RenderCache {
  constructor(options?: {
    maxEntries?: number; // default 200
    maxTotalBytes?: number; // default 64 MiB
    ttlMs?: number; // default 3_600_000
    now?: () => number; // injectable clock for tests
  });
  key(text: string): string; // sha256 hex
  get(key: string): readonly RenderedPage[] | undefined;
  set(key: string, pages: readonly RenderedPage[]): void;
}
```

- [ ] **Step 1: Create the renderer contract file**

Create `src/pxpipe/renderer.ts`:

```ts
export type RenderedPage = Readonly<{
  png: Buffer;
  width: number;
  height: number;
}>;

export interface TextRenderer {
  renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]>;
}
```

- [ ] **Step 2: Write the failing cache test**

Create `tests/unit/pxpipe-render-cache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { RenderCache } from '../../src/pxpipe/render-cache.js';
import type { RenderedPage } from '../../src/pxpipe/renderer.js';

function page(size: number): RenderedPage {
  return { png: Buffer.alloc(size, 1), width: 1568, height: 1560 };
}

describe('RenderCache', () => {
  it('returns undefined on miss and stored pages on hit', () => {
    const cache = new RenderCache();
    const key = cache.key('hello');
    expect(cache.get(key)).toBeUndefined();
    const pages = [page(10)];
    cache.set(key, pages);
    expect(cache.get(key)).toBe(pages);
  });

  it('derives stable sha256 keys from content', () => {
    const cache = new RenderCache();
    expect(cache.key('same')).toBe(cache.key('same'));
    expect(cache.key('same')).not.toBe(cache.key('different'));
    expect(cache.key('same')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = new RenderCache({ maxEntries: 2 });
    cache.set('a', [page(1)]);
    cache.set('b', [page(1)]);
    expect(cache.get('a')).toBeDefined();
    cache.set('c', [page(1)]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('evicts oldest entries when total bytes exceed the limit', () => {
    const cache = new RenderCache({ maxTotalBytes: 25 });
    cache.set('a', [page(10)]);
    cache.set('b', [page(10)]);
    cache.set('c', [page(10)]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('expires entries after the TTL', () => {
    let currentTime = 0;
    const cache = new RenderCache({ ttlMs: 1_000, now: () => currentTime });
    cache.set('a', [page(1)]);
    currentTime = 999;
    expect(cache.get('a')).toBeDefined();
    currentTime = 1_000;
    expect(cache.get('a')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx.cmd vitest run tests/unit/pxpipe-render-cache.test.ts`
Expected: FAIL — cannot resolve `../../src/pxpipe/render-cache.js`.

- [ ] **Step 4: Implement the cache**

Create `src/pxpipe/render-cache.ts`:

```ts
import { createHash } from 'node:crypto';

import type { RenderedPage } from './renderer.js';

export type RenderCacheOptions = Readonly<{
  maxEntries?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
  now?: () => number;
}>;

type CacheEntry = {
  pages: readonly RenderedPage[];
  bytes: number;
  expiresAt: number;
};

export class RenderCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: RenderCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.now = options.now ?? Date.now;
  }

  public key(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  public get(key: string): readonly RenderedPage[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.pages;
  }

  public set(key: string, pages: readonly RenderedPage[]): void {
    this.delete(key);
    const bytes = pages.reduce((sum, rendered) => sum + rendered.png.byteLength, 0);
    this.entries.set(key, { pages, bytes, expiresAt: this.now() + this.ttlMs });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldestKey = this.entries.keys().next().value;
      // A single oversized entry is kept; evicting it would defeat caching entirely.
      if (oldestKey === undefined || oldestKey === key) break;
      this.delete(oldestKey);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx.cmd vitest run tests/unit/pxpipe-render-cache.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "feat(pxpipe): renderer contract and LRU render cache"
```

---

### Task 4: PureImageRenderer (real PNG rasterizer)

**Files:**

- Modify: `src/pxpipe/renderer.ts` (add implementation below the interface)
- Create: `assets/fonts/DejaVuSansMono.ttf`, `assets/fonts/DejaVuSansMono-LICENSE.txt` (vendored)
- Create: `tests/unit/pxpipe-renderer.test.ts`
- Modify: `package.json` (dependency `pureimage`)

**Interfaces:**

- Consumes: `PAGE_WIDTH_PX`, `LINE_HEIGHT_PX`, `FONT_SIZE_PX` from Task 2; `TextRenderer` / `RenderedPage` from Task 3.
- Produces: `class PureImageRenderer implements TextRenderer` (constructed by `create-app.ts` in Task 7).

- [ ] **Step 1: Install dependency and vendor the font**

```powershell
npm.cmd install pureimage@^0.4.13
New-Item -ItemType Directory -Force -Path assets/fonts | Out-Null
Invoke-WebRequest -Uri 'https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip' -OutFile dejavu.zip
Expand-Archive dejavu.zip -DestinationPath dejavu-tmp
Copy-Item dejavu-tmp/dejavu-fonts-ttf-2.37/ttf/DejaVuSansMono.ttf assets/fonts/
Copy-Item dejavu-tmp/dejavu-fonts-ttf-2.37/LICENSE assets/fonts/DejaVuSansMono-LICENSE.txt
Remove-Item -Recurse -Force dejavu-tmp, dejavu.zip
```

Verify: `Test-Path assets/fonts/DejaVuSansMono.ttf` prints `True`.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/pxpipe-renderer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { LINE_HEIGHT_PX, PAGE_WIDTH_PX } from '../../src/pxpipe/estimator.js';
import { PureImageRenderer } from '../../src/pxpipe/renderer.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('PureImageRenderer', () => {
  it('renders lines to a PNG page with the expected geometry', async () => {
    const renderer = new PureImageRenderer();
    const [rendered] = await renderer.renderPages([['const answer = 42;', 'export {};']]);
    expect(rendered.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(rendered.width).toBe(PAGE_WIDTH_PX);
    expect(rendered.height).toBe(2 * LINE_HEIGHT_PX);
  }, 30_000);

  it('produces byte-identical output for identical input', async () => {
    const renderer = new PureImageRenderer();
    const [first] = await renderer.renderPages([['deterministic output']]);
    const [second] = await renderer.renderPages([['deterministic output']]);
    expect(first.png.equals(second.png)).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx.cmd vitest run tests/unit/pxpipe-renderer.test.ts`
Expected: FAIL — `PureImageRenderer` is not exported.

- [ ] **Step 4: Implement**

Append to `src/pxpipe/renderer.ts`:

```ts
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import * as PImage from 'pureimage';

import { FONT_SIZE_PX, LINE_HEIGHT_PX, PAGE_WIDTH_PX } from './estimator.js';

const FONT_FAMILY = 'DejaVuSansMono';
const FONT_PATH = fileURLToPath(new URL('../../assets/fonts/DejaVuSansMono.ttf', import.meta.url));

export class PureImageRenderer implements TextRenderer {
  private fontLoaded: Promise<void> | undefined;

  private ensureFont(): Promise<void> {
    if (!this.fontLoaded) {
      const font = PImage.registerFont(FONT_PATH, FONT_FAMILY);
      this.fontLoaded = font.load().then(() => undefined);
    }
    return this.fontLoaded;
  }

  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    await this.ensureFont();
    const rendered: RenderedPage[] = [];
    for (const lines of pages) {
      const height = Math.max(LINE_HEIGHT_PX, lines.length * LINE_HEIGHT_PX);
      const bitmap = PImage.make(PAGE_WIDTH_PX, height);
      const context = bitmap.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, PAGE_WIDTH_PX, height);
      context.fillStyle = '#000000';
      context.font = `${FONT_SIZE_PX}px ${FONT_FAMILY}`;
      lines.forEach((line, index) => {
        if (line.length > 0) {
          context.fillText(line, 2, (index + 1) * LINE_HEIGHT_PX - 3);
        }
      });
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      await PImage.encodePNGToStream(bitmap, stream);
      rendered.push({ png: Buffer.concat(chunks), width: PAGE_WIDTH_PX, height });
    }
    return rendered;
  }
}
```

Move all `import` statements to the top of the file (imports must precede the existing type declarations). If the installed `pureimage` version types `font.load()` as callback-based instead of Promise-based, use:
`this.fontLoaded = new Promise<void>((resolve) => { font.load(() => resolve()); });`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx.cmd vitest run tests/unit/pxpipe-renderer.test.ts`
Expected: PASS (2 tests). Rendering a 1568px-wide bitmap in pure JS may take a few seconds — that is why the tests carry a 30s timeout.

- [ ] **Step 6: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "feat(pxpipe): pureimage PNG renderer with vendored DejaVu Sans Mono"
```

---

### Task 5: Transform stage

**Files:**

- Create: `src/pxpipe/transform.ts`
- Create: `tests/unit/pxpipe-transform.test.ts`

**Interfaces:**

- Consumes: `evaluateBlock` (Task 2), `RenderCache` (Task 3), `TextRenderer`/`RenderedPage` (Task 3), `AppConfig` (Task 1).
- Produces (used by Task 7):

```ts
export type PxpipeStats = {
  blocksConverted: number;
  pagesRendered: number;
  estTokensSaved: number;
  cacheHits: number;
  renderFailures: number;
};
export type PxpipeResult = Readonly<{ body: unknown; stats: PxpipeStats }>;
export async function transformRequestBody(
  body: unknown,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
): Promise<PxpipeResult>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pxpipe-transform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { RenderCache } from '../../src/pxpipe/render-cache.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';
import { transformRequestBody } from '../../src/pxpipe/transform.js';

class FakeRenderer implements TextRenderer {
  public renderCalls = 0;
  public shouldFail = false;

  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    this.renderCalls += 1;
    if (this.shouldFail) throw new Error('render failed');
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ PXPIPE_ENABLED: 'true', PXPIPE_KEEP_RECENT_TURNS: '0', ...overrides });
}

const BIG = 'x'.repeat(20_000);
const FAKE_PNG_BASE64 = Buffer.from('fake-png').toString('base64');
const STUB_TEXT =
  '[pxpipe: 20000 chars rendered as 1 image page(s); read the image(s) as inline text]';

describe('transformRequestBody', () => {
  it('converts an eligible user text block into image blocks plus a stub', async () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(
      body,
      makeConfig(),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: FAKE_PNG_BASE64 },
    });
    expect(content.at(-1)).toEqual({ type: 'text', text: STUB_TEXT });
    expect(result.stats.blocksConverted).toBe(1);
    expect(result.stats.pagesRendered).toBe(1);
    expect(result.stats.estTokensSaved).toBe(5_000 - 3_262);
  });

  it('does not mutate the original body', async () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    await transformRequestBody(body, makeConfig(), new FakeRenderer(), new RenderCache());
    expect((body.messages[0].content as Array<{ type: string }>)[0].type).toBe('text');
  });

  it('protects the most recent user turns', async () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: BIG }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: BIG }] },
      ],
    };
    const result = await transformRequestBody(
      body,
      makeConfig({ PXPIPE_KEEP_RECENT_TURNS: '1' }),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;
    expect((messages[0].content as Array<{ type: string }>)[0].type).toBe('image');
    expect((messages[2].content as Array<{ type: string }>)[0].type).toBe('text');
    expect(result.stats.blocksConverted).toBe(1);
  });

  it('converts string content of user messages and of tool_result blocks', async () => {
    const body = {
      messages: [
        { role: 'user', content: BIG },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG }],
        },
      ],
    };
    const result = await transformRequestBody(
      body,
      makeConfig(),
      new FakeRenderer(),
      new RenderCache(),
    );
    const messages = (result.body as { messages: Array<{ content: unknown }> }).messages;
    expect((messages[0].content as Array<{ type: string }>)[0].type).toBe('image');
    const toolResult = (messages[1].content as Array<Record<string, unknown>>)[0];
    expect((toolResult.content as Array<{ type: string }>)[0].type).toBe('image');
    expect(toolResult.tool_use_id).toBe('tu_1');
    expect(result.stats.blocksConverted).toBe(2);
  });

  it('leaves tool_result blocks containing images untouched', async () => {
    const imageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aaaa' },
    };
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_2',
              content: [{ type: 'text', text: BIG }, imageBlock],
            },
          ],
        },
      ],
    };
    const result = await transformRequestBody(
      body,
      makeConfig(),
      new FakeRenderer(),
      new RenderCache(),
    );
    expect(result.stats.blocksConverted).toBe(0);
  });

  it('reuses cached renders for repeated content', async () => {
    const renderer = new FakeRenderer();
    const cache = new RenderCache();
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const first = await transformRequestBody(body, makeConfig(), renderer, cache);
    const second = await transformRequestBody(body, makeConfig(), renderer, cache);
    expect(renderer.renderCalls).toBe(1);
    expect(first.stats.cacheHits).toBe(0);
    expect(second.stats.cacheHits).toBe(1);
    expect(second.stats.blocksConverted).toBe(1);
  });

  it('fails open when the renderer throws', async () => {
    const renderer = new FakeRenderer();
    renderer.shouldFail = true;
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(body, makeConfig(), renderer, new RenderCache());
    expect(result.body).toBe(body);
    expect(result.stats.renderFailures).toBe(1);
    expect(result.stats.blocksConverted).toBe(0);
  });

  it('returns the body untouched when pxpipe is disabled', async () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(
      body,
      loadConfig({ PXPIPE_ENABLED: 'false' }),
      new FakeRenderer(),
      new RenderCache(),
    );
    expect(result.body).toBe(body);
    expect(result.stats.blocksConverted).toBe(0);
  });

  it('skips plain text blocks when scope is tool_results_only', async () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: BIG }] }],
    };
    const result = await transformRequestBody(
      body,
      makeConfig({ PXPIPE_SCOPE: 'tool_results_only' }),
      new FakeRenderer(),
      new RenderCache(),
    );
    expect(result.stats.blocksConverted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/unit/pxpipe-transform.test.ts`
Expected: FAIL — cannot resolve `../../src/pxpipe/transform.js`.

- [ ] **Step 3: Implement**

Create `src/pxpipe/transform.ts`:

```ts
import type { AppConfig } from '../config/env.js';
import { evaluateBlock } from './estimator.js';
import type { RenderCache } from './render-cache.js';
import type { RenderedPage, TextRenderer } from './renderer.js';

export type PxpipeStats = {
  blocksConverted: number;
  pagesRendered: number;
  estTokensSaved: number;
  cacheHits: number;
  renderFailures: number;
};

export type PxpipeResult = Readonly<{
  body: unknown;
  stats: PxpipeStats;
}>;

type ContentBlock = Record<string, unknown>;

function emptyStats(): PxpipeStats {
  return {
    blocksConverted: 0,
    pagesRendered: 0,
    estTokensSaved: 0,
    cacheHits: 0,
    renderFailures: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildReplacementBlocks(text: string, pages: readonly RenderedPage[]): ContentBlock[] {
  const blocks: ContentBlock[] = pages.map((page) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: page.png.toString('base64') },
  }));
  blocks.push({
    type: 'text',
    text: `[pxpipe: ${text.length} chars rendered as ${pages.length} image page(s); read the image(s) as inline text]`,
  });
  return blocks;
}

async function convertText(
  text: string,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
  stats: PxpipeStats,
): Promise<ContentBlock[] | undefined> {
  const evaluation = evaluateBlock(text, config);
  if (!evaluation.eligible) return undefined;
  const key = cache.key(text);
  let pages = cache.get(key);
  if (pages) {
    stats.cacheHits += 1;
  } else {
    pages = await renderer.renderPages(evaluation.pages);
    cache.set(key, pages);
    stats.pagesRendered += pages.length;
  }
  stats.blocksConverted += 1;
  stats.estTokensSaved += evaluation.estTextTokens - evaluation.estImageTokens;
  return buildReplacementBlocks(text, pages);
}

async function transformToolResult(
  block: ContentBlock,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
  stats: PxpipeStats,
): Promise<ContentBlock> {
  const content = block.content;
  if (typeof content === 'string') {
    const converted = await convertText(content, config, renderer, cache, stats);
    return converted ? { ...block, content: converted } : block;
  }
  if (Array.isArray(content)) {
    const allText = content.every(
      (inner) => isRecord(inner) && inner.type === 'text' && typeof inner.text === 'string',
    );
    if (!allText) return block;
    const nextContent: ContentBlock[] = [];
    let changed = false;
    for (const inner of content as ContentBlock[]) {
      const converted = await convertText(inner.text as string, config, renderer, cache, stats);
      if (converted) {
        nextContent.push(...converted);
        changed = true;
      } else {
        nextContent.push(inner);
      }
    }
    return changed ? { ...block, content: nextContent } : block;
  }
  return block;
}

async function transformBlocks(
  blocks: readonly unknown[],
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
  stats: PxpipeStats,
): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      result.push(block);
      continue;
    }
    if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      config.pxpipeScope === 'user_and_tool_results'
    ) {
      const converted = await convertText(block.text, config, renderer, cache, stats);
      if (converted) {
        result.push(...converted);
        continue;
      }
    }
    if (block.type === 'tool_result') {
      result.push(await transformToolResult(block, config, renderer, cache, stats));
      continue;
    }
    result.push(block);
  }
  return result;
}

export async function transformRequestBody(
  body: unknown,
  config: AppConfig,
  renderer: TextRenderer,
  cache: RenderCache,
): Promise<PxpipeResult> {
  const stats = emptyStats();
  if (!config.pxpipeEnabled) return { body, stats };
  try {
    if (!isRecord(body) || !Array.isArray(body.messages)) return { body, stats };
    const messages = body.messages as unknown[];
    const userIndexes = messages.flatMap((message, index) =>
      isRecord(message) && message.role === 'user' ? [index] : [],
    );
    const keep = config.pxpipeKeepRecentTurns;
    const protectedIndexes = new Set(keep === 0 ? [] : userIndexes.slice(-keep));

    const nextMessages: unknown[] = [];
    for (const [index, message] of messages.entries()) {
      if (!isRecord(message) || message.role !== 'user' || protectedIndexes.has(index)) {
        nextMessages.push(message);
        continue;
      }
      if (typeof message.content === 'string' && config.pxpipeScope === 'user_and_tool_results') {
        const converted = await convertText(message.content, config, renderer, cache, stats);
        nextMessages.push(converted ? { ...message, content: converted } : message);
        continue;
      }
      if (Array.isArray(message.content)) {
        nextMessages.push({
          ...message,
          content: await transformBlocks(message.content, config, renderer, cache, stats),
        });
        continue;
      }
      nextMessages.push(message);
    }

    if (stats.blocksConverted === 0) return { body, stats };
    return { body: { ...body, messages: nextMessages }, stats };
  } catch {
    return { body, stats: { ...emptyStats(), renderFailures: 1 } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/unit/pxpipe-transform.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "feat(pxpipe): request-body transform with fail-open and cache (REQ-F-101)"
```

---

### Task 6: pxpipe metrics counters

**Files:**

- Modify: `src/metrics/metrics-registry.ts`
- Create: `tests/unit/pxpipe-metrics.test.ts`

**Interfaces:**

- Produces (used by Task 7): on `MetricsRegistry` —
  - `recordPxpipeConversion(blocksConverted: number, tokensSavedEstimate: number): void`
  - `recordPxpipeRenderFailure(): void`
  - `recordPxpipeUpstreamRejection(): void`
  - `renderPrometheus()` additionally emits the four `relaycore_pxpipe_*` counters (always, even at 0).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pxpipe-metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from '../../src/metrics/metrics-registry.js';

describe('pxpipe metrics', () => {
  it('renders zeroed pxpipe counters by default', () => {
    const output = new MetricsRegistry().renderPrometheus();
    expect(output).toContain('relaycore_pxpipe_blocks_converted_total 0');
    expect(output).toContain('relaycore_pxpipe_tokens_saved_estimate_total 0');
    expect(output).toContain('relaycore_pxpipe_render_failures_total 0');
    expect(output).toContain('relaycore_pxpipe_upstream_rejected_total 0');
  });

  it('accumulates pxpipe counters', () => {
    const metrics = new MetricsRegistry();
    metrics.recordPxpipeConversion(2, 3_500);
    metrics.recordPxpipeConversion(1, 1_500);
    metrics.recordPxpipeRenderFailure();
    metrics.recordPxpipeUpstreamRejection();
    const output = metrics.renderPrometheus();
    expect(output).toContain('relaycore_pxpipe_blocks_converted_total 3');
    expect(output).toContain('relaycore_pxpipe_tokens_saved_estimate_total 5000');
    expect(output).toContain('relaycore_pxpipe_render_failures_total 1');
    expect(output).toContain('relaycore_pxpipe_upstream_rejected_total 1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/unit/pxpipe-metrics.test.ts`
Expected: FAIL — `recordPxpipeConversion is not a function`.

- [ ] **Step 3: Implement**

In `src/metrics/metrics-registry.ts`, add private fields after `private inFlight = 0;`:

```ts
  private pxpipeBlocksConverted = 0;
  private pxpipeTokensSavedEstimate = 0;
  private pxpipeRenderFailures = 0;
  private pxpipeUpstreamRejected = 0;
```

Add public methods after `recordUpstreamError`:

```ts
  public recordPxpipeConversion(blocksConverted: number, tokensSavedEstimate: number): void {
    this.pxpipeBlocksConverted += blocksConverted;
    this.pxpipeTokensSavedEstimate += tokensSavedEstimate;
  }

  public recordPxpipeRenderFailure(): void {
    this.pxpipeRenderFailures += 1;
  }

  public recordPxpipeUpstreamRejection(): void {
    this.pxpipeUpstreamRejected += 1;
  }
```

In `renderPrometheus()`, append to the initial `lines` array literal (after the `relaycore_upstream_errors_total` TYPE line):

```ts
      '# HELP relaycore_pxpipe_blocks_converted_total Text blocks converted to images by pxpipe.',
      '# TYPE relaycore_pxpipe_blocks_converted_total counter',
      `relaycore_pxpipe_blocks_converted_total ${this.pxpipeBlocksConverted}`,
      '# HELP relaycore_pxpipe_tokens_saved_estimate_total Estimated input tokens saved by pxpipe.',
      '# TYPE relaycore_pxpipe_tokens_saved_estimate_total counter',
      `relaycore_pxpipe_tokens_saved_estimate_total ${this.pxpipeTokensSavedEstimate}`,
      '# HELP relaycore_pxpipe_render_failures_total pxpipe rendering failures (requests fell back to original text).',
      '# TYPE relaycore_pxpipe_render_failures_total counter',
      `relaycore_pxpipe_render_failures_total ${this.pxpipeRenderFailures}`,
      '# HELP relaycore_pxpipe_upstream_rejected_total Transformed requests rejected upstream and retried as text.',
      '# TYPE relaycore_pxpipe_upstream_rejected_total counter',
      `relaycore_pxpipe_upstream_rejected_total ${this.pxpipeUpstreamRejected}`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/unit/pxpipe-metrics.test.ts`
Expected: PASS (2 tests). Also run `npx.cmd vitest run tests/unit/metrics-registry.test.ts` — must still pass.

- [ ] **Step 5: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "feat(pxpipe): prometheus counters for conversions, failures, rejections"
```

---

### Task 7: Route wiring and 400-retry

**Files:**

- Modify: `src/routes/messages.ts`
- Modify: `src/app/create-app.ts`
- Create: `tests/integration/pxpipe.test.ts`

**Interfaces:**

- Consumes: `transformRequestBody` (Task 5), `RenderCache` (Task 3), `PureImageRenderer`/`TextRenderer` (Tasks 3-4), metrics methods (Task 6).
- Produces:
  - `registerMessagesRoute(app, client, diagnostics, metrics, pxpipe?)` — new optional 5th parameter `PxpipeIntegration = Readonly<{ config: AppConfig; renderer: TextRenderer; cache: RenderCache }>`.
  - `CreateAppOptions` gains `textRenderer?: TextRenderer` and `renderCache?: RenderCache`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/pxpipe.test.ts`:

```ts
import { ReadableStream } from 'node:stream/web';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import type { AppConfig } from '../../src/config/env.js';
import type { RenderedPage, TextRenderer } from '../../src/pxpipe/renderer.js';

const pxpipeConfig: AppConfig = {
  host: '127.0.0.1',
  port: 47822,
  environment: 'test',
  logLevel: 'silent',
  upstreamBaseUrl: 'https://provider.example.test',
  upstreamTimeoutMs: 120000,
  pxpipeEnabled: true,
  pxpipeMinChars: 4000,
  pxpipeSavingsFactor: 0.7,
  pxpipeMaxPagesPerBlock: 4,
  pxpipeKeepRecentTurns: 1,
  pxpipeScope: 'user_and_tool_results',
};

const encoder = new TextEncoder();

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function okUpstream() {
  return {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: streamFrom(['{"type":"message","content":[]}']),
  };
}

function badRequestUpstream() {
  return {
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: streamFrom([
      '{"type":"error","error":{"type":"invalid_request_error","message":"images not supported"}}',
    ]),
  };
}

class FakeRenderer implements TextRenderer {
  public shouldFail = false;

  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    if (this.shouldFail) throw new Error('render failed');
    return pages.map(() => ({ png: Buffer.from('fake-png'), width: 1568, height: 1560 }));
  }
}

const BIG = 'x'.repeat(20_000);

function bigPayload() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    messages: [
      { role: 'user', content: [{ type: 'text', text: BIG }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'latest question' },
    ],
    stream: false,
  };
}

describe('pxpipe integration', () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('converts old user turns and protects the most recent one', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(pxpipeConfig, {
      anthropicClient: { createMessage },
      textRenderer: new FakeRenderer(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: bigPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(createMessage).toHaveBeenCalledTimes(1);
    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    const firstContent = sentBody.messages[0].content as Array<Record<string, unknown>>;
    expect(firstContent[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    expect(sentBody.messages[2].content).toBe('latest question');

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('relaycore_pxpipe_blocks_converted_total 1');
  });

  it('forwards the body untouched when pxpipe is disabled', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const app = createApp(
      { ...pxpipeConfig, pxpipeEnabled: false },
      { anthropicClient: { createMessage }, textRenderer: new FakeRenderer() },
    );
    apps.push(app);

    await app.inject({ method: 'POST', url: '/v1/messages', payload: bigPayload() });

    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(sentBody.messages[0].content).toEqual([{ type: 'text', text: BIG }]);
  });

  it('fails open and forwards the original body when rendering fails', async () => {
    const createMessage = vi.fn().mockResolvedValue(okUpstream());
    const renderer = new FakeRenderer();
    renderer.shouldFail = true;
    const app = createApp(pxpipeConfig, {
      anthropicClient: { createMessage },
      textRenderer: renderer,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: bigPayload(),
    });

    expect(response.statusCode).toBe(200);
    const sentBody = createMessage.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(sentBody.messages[0].content).toEqual([{ type: 'text', text: BIG }]);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('relaycore_pxpipe_render_failures_total 1');
  });

  it('retries once with the original body when the upstream rejects with 400', async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(badRequestUpstream())
      .mockResolvedValueOnce(okUpstream());
    const app = createApp(pxpipeConfig, {
      anthropicClient: { createMessage },
      textRenderer: new FakeRenderer(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: bigPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(createMessage).toHaveBeenCalledTimes(2);
    const retriedBody = createMessage.mock.calls[1][0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(retriedBody.messages[0].content).toEqual([{ type: 'text', text: BIG }]);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('relaycore_pxpipe_upstream_rejected_total 1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/integration/pxpipe.test.ts`
Expected: FAIL — `textRenderer` is not a known option / transformed body assertions fail (first message still text).

- [ ] **Step 3: Modify `src/routes/messages.ts`**

Add imports (below the existing imports):

```ts
import type { AppConfig } from '../config/env.js';
import type { RenderCache } from '../pxpipe/render-cache.js';
import type { TextRenderer } from '../pxpipe/renderer.js';
import { transformRequestBody } from '../pxpipe/transform.js';
```

Add the exported type (above `registerMessagesRoute`):

```ts
export type PxpipeIntegration = Readonly<{
  config: AppConfig;
  renderer: TextRenderer;
  cache: RenderCache;
}>;
```

Change the signature and the start of the handler — replace:

```ts
export function registerMessagesRoute(
  app: FastifyInstance,
  client: AnthropicClient,
  diagnostics: DiagnosticsRegistry,
  metrics: MetricsRegistry,
): void {
  app.post('/v1/messages', async (request, reply) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }

      const upstream = await client.createMessage(request.body, headers);
      if (upstream.status >= 400) {
```

with:

```ts
export function registerMessagesRoute(
  app: FastifyInstance,
  client: AnthropicClient,
  diagnostics: DiagnosticsRegistry,
  metrics: MetricsRegistry,
  pxpipe?: PxpipeIntegration,
): void {
  app.post('/v1/messages', async (request, reply) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }

      let outboundBody = request.body;
      let pxpipeConverted = false;
      if (pxpipe?.config.pxpipeEnabled) {
        const transformed = await transformRequestBody(
          request.body,
          pxpipe.config,
          pxpipe.renderer,
          pxpipe.cache,
        );
        if (transformed.stats.renderFailures > 0) {
          metrics.recordPxpipeRenderFailure();
          request.log.warn(
            { requestId: request.id },
            'pxpipe rendering failed; forwarding original request body',
          );
        }
        if (transformed.stats.blocksConverted > 0) {
          metrics.recordPxpipeConversion(
            transformed.stats.blocksConverted,
            transformed.stats.estTokensSaved,
          );
          outboundBody = transformed.body;
          pxpipeConverted = true;
          request.log.info(
            {
              requestId: request.id,
              blocksConverted: transformed.stats.blocksConverted,
              pagesRendered: transformed.stats.pagesRendered,
              estTokensSaved: transformed.stats.estTokensSaved,
              cacheHits: transformed.stats.cacheHits,
            },
            'pxpipe converted request blocks to images',
          );
        }
      }

      let upstream = await client.createMessage(outboundBody, headers);
      if (upstream.status === 400 && pxpipeConverted) {
        metrics.recordPxpipeUpstreamRejection();
        request.log.warn(
          { requestId: request.id, upstreamStatus: upstream.status },
          'Upstream rejected pxpipe payload; retrying once with the original body',
        );
        upstream = await client.createMessage(request.body, headers);
      }

      if (upstream.status >= 400) {
```

The rest of the handler (error relay, catch blocks) stays unchanged.

- [ ] **Step 4: Modify `src/app/create-app.ts`**

Add imports:

```ts
import { RenderCache } from '../pxpipe/render-cache.js';
import { PureImageRenderer, type TextRenderer } from '../pxpipe/renderer.js';
```

Extend `CreateAppOptions`:

```ts
export type CreateAppOptions = Readonly<{
  anthropicClient?: AnthropicClient;
  diagnostics?: DiagnosticsRegistry;
  metrics?: MetricsRegistry;
  upstreamHealthChecker?: UpstreamHealthChecker;
  textRenderer?: TextRenderer;
  renderCache?: RenderCache;
}>;
```

Replace the `registerMessagesRoute(...)` call with:

```ts
const pxpipe = config.pxpipeEnabled
  ? {
      config,
      renderer: options.textRenderer ?? new PureImageRenderer(),
      cache: options.renderCache ?? new RenderCache(),
    }
  : undefined;
registerMessagesRoute(
  app,
  options.anthropicClient ?? new FetchAnthropicClient(config),
  diagnostics,
  metrics,
  pxpipe,
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx.cmd vitest run tests/integration/pxpipe.test.ts`
Expected: PASS (4 tests). Also run `npx.cmd vitest run tests/integration/messages.test.ts` — must still pass (pxpipe disabled in its config).

- [ ] **Step 6: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "feat(pxpipe): wire transform into /v1/messages with 400-retry (REQ-F-102)"
```

---

### Task 8: Docs, packaging, and manual smoke checklist

**Files:**

- Modify: `.env.example`, `README.md`, `docs/architecture-overview.md`, `Dockerfile`

**Interfaces:**

- Consumes: everything shipped in Tasks 1-7. No code produced.

- [ ] **Step 1: Append to `.env.example`**

```env

# pxpipe: convert large text blocks to PNG images before forwarding (see README)
PXPIPE_ENABLED=false
PXPIPE_MIN_CHARS=4000
PXPIPE_SAVINGS_FACTOR=0.7
PXPIPE_MAX_PAGES_PER_BLOCK=4
PXPIPE_KEEP_RECENT_TURNS=3
PXPIPE_SCOPE=user_and_tool_results
```

- [ ] **Step 2: Add a README section**

Append to `README.md`:

```markdown
## pxpipe: text-to-image request transform

When `PXPIPE_ENABLED=true`, RelayCore converts large text blocks in old user
turns of `POST /v1/messages` into PNG image blocks before forwarding upstream.
Anthropic-compatible APIs bill images at roughly `(width × height) / 750`
tokens, which is cheaper than the equivalent text for large blocks. Responses
are never modified.

- Opt-in: `PXPIPE_ENABLED=false` by default.
- Fail-open: any rendering problem forwards the original request unchanged.
- If the upstream rejects a transformed request with HTTP 400, RelayCore
  retries once with the original body.
- Metrics: `relaycore_pxpipe_*` counters on `GET /metrics`.

| Variable                     | Default                 | Meaning                                          |
| ---------------------------- | ----------------------- | ------------------------------------------------ |
| `PXPIPE_ENABLED`             | `false`                 | Master switch.                                   |
| `PXPIPE_MIN_CHARS`           | `4000`                  | Minimum block size considered.                   |
| `PXPIPE_SAVINGS_FACTOR`      | `0.7`                   | Convert only if image cost < text cost × factor. |
| `PXPIPE_MAX_PAGES_PER_BLOCK` | `4`                     | Blocks needing more pages stay as text.          |
| `PXPIPE_KEEP_RECENT_TURNS`   | `3`                     | Most recent user turns always stay text.         |
| `PXPIPE_SCOPE`               | `user_and_tool_results` | Or `tool_results_only`.                          |

Design details: `docs/superpowers/specs/2026-07-11-pxpipe-transform-design.md`.
Before enabling in daily use, run the manual smoke test below once per model
you use (OneProvider models: <https://oneprovider.dev/docs/api/models>; vision
docs: <https://oneprovider.dev/docs/api/vision>).
```

- [ ] **Step 3: Update `docs/architecture-overview.md`**

Append this bullet/section (adapt placement to the file's existing list style, keep the text):

```markdown
- **pxpipe transform** (`src/pxpipe/`): optional, opt-in stage inside
  `POST /v1/messages` that converts large text blocks in old user turns into
  base64 PNG image blocks before forwarding upstream. Eligibility is decided
  by a token cost-compare gate; rendering is deterministic (`pureimage` +
  vendored DejaVu Sans Mono) and cached in an in-memory LRU keyed by sha256.
  Fail-open: any error forwards the original body. Upstream `400` for a
  transformed request triggers a single retry with the original body.
```

- [ ] **Step 4: Update `Dockerfile` for the font asset**

After the line `COPY --from=build /app/dist ./dist` add:

```dockerfile
COPY assets ./assets
```

- [ ] **Step 5: Validate and commit**

```powershell
npm.cmd run format; npm.cmd run lint; npm.cmd run typecheck; npm.cmd test; npm.cmd run build
git add -A
git commit -m "docs(pxpipe): document configuration, packaging and smoke test"
```

- [ ] **Step 6: Manual smoke test (requires the real OneProvider key — run with the user)**

1. Generate a sample PNG using the project renderer:

```powershell
npx.cmd tsx -e "import('./src/pxpipe/renderer.js').then(async ({ PureImageRenderer }) => { const { writeFileSync } = await import('node:fs'); const [page] = await new PureImageRenderer().renderPages([['pxpipe smoke test']]); writeFileSync('smoke.png', page.png); })"
```

2. Start RelayCore (`npm.cmd run dev`) and send one image-bearing request **per model** listed at <https://oneprovider.dev/docs/api/models> (7 models — replace the `model` value each run):

```powershell
$headers = @{ 'x-api-key' = 'relaycore-local'; 'anthropic-version' = '2023-06-01'; 'content-type' = 'application/json' }
$png = [Convert]::ToBase64String([IO.File]::ReadAllBytes('smoke.png'))
$body = @{
  model = 'claude-sonnet-4-6'
  max_tokens = 64
  messages = @(@{
    role = 'user'
    content = @(
      @{ type = 'image'; source = @{ type = 'base64'; media_type = 'image/png'; data = $png } },
      @{ type = 'text'; text = 'What text appears in this image? Answer with the text only.' }
    )
  })
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47822/v1/messages' -Headers $headers -Body $body
```

Expected per model: HTTP 200 and the answer contains `pxpipe smoke test`. Record any model that returns `400`/`invalid_request_error` — those models must not be used with `PXPIPE_ENABLED=true` (or rely on the automatic 400-retry).

3. Delete `smoke.png` afterwards: `Remove-Item smoke.png`.

4. Only after all models pass, set `PXPIPE_ENABLED=true` in `.env` and restart.

---

## Self-Review Notes

- Spec §3 scope/gate → Tasks 2, 5. Spec §4 rendering/cache → Tasks 3, 4. Spec §5 config → Task 1. Spec §6 vision gate → Task 8 smoke test + Task 7 retry. Spec §7 fail-open → Tasks 5, 7. Spec §8 metrics/logs → Tasks 6, 7. Spec §9 privacy → no disk writes anywhere; logs carry counts only. Spec §10 tests → each task. Model-allowlist gating (spec §3.2 item 4) is implemented operationally via the smoke checklist plus the 400-retry safety net rather than a hardcoded list — the OneProvider matrix is not machine-readable.
- Type names cross-checked: `RenderedPage`, `TextRenderer`, `RenderCache`, `PxpipeStats.estTokensSaved`, `transformRequestBody`, `PxpipeIntegration`, `recordPxpipeConversion` are used identically across Tasks 3-7.
- `estTokensSaved` example math: 20 000 chars → 5 000 text tokens; 1 page → 3 262 image tokens; saved 1 738.
