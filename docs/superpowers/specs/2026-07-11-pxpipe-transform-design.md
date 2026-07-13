# pxpipe Transform — Design Spec

- **Date:** 2026-07-11
- **Status:** Approved (design review with project owner)
- **Requirements:** RF-016 (PRD) · REQ-F-100, REQ-F-101, REQ-F-102, REQ-F-103 (SRS)
- **Related docs:** [architecture-overview.md](../../architecture-overview.md), [ategora.md](../../ategora.md)

## 1. Problem

Claude Code resends the full conversation history on every turn. Large text blocks
(tool results, pasted logs, file dumps) are re-billed as input tokens each time.
Anthropic-compatible APIs bill images at roughly `(width × height) / 750` tokens,
which is significantly cheaper than the equivalent text for large blocks
(observed savings estimate: 59–70% for eligible blocks).

**Goal:** RelayCore transparently converts large, stable text blocks in inbound
`POST /v1/messages` requests into PNG image blocks before forwarding to the
upstream provider, reducing token cost without changing client behavior.

## 2. Decision: inline transform (approach A)

The transform runs **inside RelayCore's `/v1/messages` pipeline**, not as a
separate proxy process. Because Claude Code points `ANTHROPIC_BASE_URL` at
RelayCore (`http://127.0.0.1:47822`), an external pre-proxy would be bypassed;
an in-process stage cannot be.

```
Claude Code ($env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:47822')
  → RelayCore: POST /v1/messages
    → [PXPIPE_ENABLED] transform stage (this spec)
    → forward to UPSTREAM_BASE_URL (https://api.oneprovider.dev)
      with UPSTREAM_API_KEY
  → response (JSON or SSE) relayed back untouched
```

Rejected alternatives:

- **B) Standalone pxpipe proxy chained before RelayCore** — rejected: two
  processes to manage, and the `ANTHROPIC_BASE_URL` single-target constraint
  makes chaining fragile.
- **C) Client-side hook in Claude Code** — rejected: no supported extension
  point for request-body rewriting.

## 3. Transform rules

### 3.1 Scope

- Only **`user`-role messages** are eligible: `text` blocks and string/text
  content inside `tool_result` blocks.
- **Never** transformed: the `system` prompt, `assistant` turns, blocks already
  containing images, and the **N most recent turns** (`PXPIPE_KEEP_RECENT_TURNS`,
  default `3`) — the model must read the working context verbatim.

### 3.2 Eligibility gate (per block)

A block is converted only when **all** conditions hold:

1. `length ≥ PXPIPE_MIN_CHARS` (default `4000`).
2. Estimated pages ≤ `PXPIPE_MAX_PAGES_PER_BLOCK` (default `4`); oversized
   blocks are left as text rather than partially converted.
3. **Cost-compare gate:** `estImageTokens < estTextTokens × PXPIPE_SAVINGS_FACTOR`
   (default `0.7`). Estimators:
   - `estTextTokens ≈ chars / 4` (conservative for code/logs).
   - `estImageTokens ≈ pages × ceil((pageWidth × pageHeight) / 750)`.
4. The request `model` supports vision upstream (see §6).

#### 3.2.1 Line packing (join-pack reflow)

Real text (source code, logs, JSON) averages far fewer characters per line
than the page's column budget. A naive layout that maps one input line to one
page row wastes most of each page's column capacity, so the image ends up
*more* expensive per character than the text it replaces — the cost-compare
gate then rejects nearly every real block, even though it accepts synthetic
single-long-line fixtures.

To fix this, `layoutLines` packs consecutive short original lines onto a
single page row (joined by a single space) up to `COLUMNS_PER_LINE`, instead
of preserving a strict one-input-line-per-row mapping:

- Blank lines always flush any pending packed row and are emitted as their
  own empty row — paragraph/block structure (e.g. blank lines between
  functions or log entries) is never absorbed into a packed row.
- Lines already longer than `COLUMNS_PER_LINE` flush the pending row and are
  hard-wrapped exactly as before.
- This is a superset of the original behavior: text that is already dense
  (one line ≥ the column budget, or every line separated by blank lines)
  produces identical output to the pre-packing algorithm.

Tradeoff: a packed row loses per-line visual alignment after its first
original line (indentation of joined lines isn't preserved). This is
accepted in exchange for making the cost-compare gate actually pass on
realistic multi-line text; block/paragraph structure via blank lines is
still preserved.

### 3.3 Replacement format

The original block is replaced by:

1. One or more `image` blocks (`source.type: "base64"`, `media_type: "image/png"`).
2. A short text stub, e.g.:
   `[pxpipe: N chars rendered as M image page(s); read the image(s) as inline text]`

Block order within the message is preserved so the model reads content in the
original sequence.

## 4. Rendering

- Monospace text rasterized to PNG pages: width `1568px`, `312` columns ×
  `91` lines per page (`COLUMNS_PER_LINE` / `LINES_PER_PAGE` in
  `src/pxpipe/estimator.ts`). Geometry is aligned with the
  [teamchong/pxpipe](https://github.com/teamchong/pxpipe) reference
  implementation's Claude profile, which is calibrated against real upstream
  token billing (N=391 production rows); page height is derived from this
  project's own font metrics (`LINE_HEIGHT_PX`) rather than the reference's
  `728px`, which assumes a denser bitmap font this renderer doesn't use.
  Deterministic output: same input → byte-identical PNG.
- **`TextRenderer` interface is injected** (same pattern as `upstream-health.ts`),
  so unit/integration tests use a fake renderer and never rasterize.
- Initial implementation: pure-JS rasterizer (e.g. `pureimage`) to avoid native
  build toolchains on Windows; `@napi-rs/canvas` (prebuilt binaries) is the
  upgrade path if render latency matters.

### 4.1 Cache

- In-memory LRU keyed by `sha256(blockText)` → rendered PNG pages.
- Rationale: Claude Code resends history each turn; caching makes repeated
  renders free **and** keeps image bytes identical across turns, which preserves
  upstream prompt-cache hits.
- Bounded by entry count and total bytes; TTL ~1h (aligned with provider
  prompt-cache lifetime). No disk persistence.

## 5. Configuration (`src/config/env.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PXPIPE_ENABLED` | `false` | Master switch (opt-in). |
| `PXPIPE_MIN_CHARS` | `4000` | Minimum block size to consider. |
| `PXPIPE_SAVINGS_FACTOR` | `0.7` | Convert only if image cost < text cost × factor. |
| `PXPIPE_MAX_PAGES_PER_BLOCK` | `4` | Skip blocks that would exceed this. |
| `PXPIPE_KEEP_RECENT_TURNS` | `3` | Most recent user turns always stay text. |
| `PXPIPE_SCOPE` | `user_and_tool_results` | Or `tool_results_only` (more conservative). |

All validated with Zod, same as existing config.

## 6. Upstream compatibility (OneProvider)

- OneProvider documents **vision/image input support**:
  <https://oneprovider.dev/docs/api/vision>
- Accepted models (7 total) are listed at:
  <https://oneprovider.dev/docs/api/models> — known-good IDs already used by
  this project: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`.
- Implementation must gate on vision-capable models. Since the docs pages are
  JS-rendered (not fetchable programmatically), the rollout plan includes a
  **manual smoke test**: send one image-bearing request per configured model
  through RelayCore before enabling `PXPIPE_ENABLED` in daily use.
- **Safety net:** if the upstream returns `400` for a transformed request,
  RelayCore retries **once** with the original untransformed payload and
  records a `pxpipe_upstream_rejected` diagnostic.

## 7. Failure handling — fail-open everywhere

Any renderer error, timeout, cache fault, or estimator exception →
the original text block is forwarded unchanged. pxpipe must never turn a
working request into a failing one. Failures are logged (safe fields only)
and counted in metrics.

## 8. Observability

Consistent with existing conventions (no prompt/response/key content in logs):

- `relaycore_pxpipe_blocks_converted_total`
- `relaycore_pxpipe_tokens_saved_estimate_total`
- `relaycore_pxpipe_render_failures_total`
- `relaycore_pxpipe_upstream_rejected_total`
- Log fields per request: `requestId`, `blocksConverted`, `pagesRendered`,
  `estTokensSaved`, `cacheHits`.

## 9. Security & privacy

- Rendered images exist only in memory (LRU cache); never written to disk.
- Logs and `/debug/*` never include block text or image bytes.
- No new network calls: rendering is local; the only egress remains the
  existing upstream forward.

## 10. Testing

- **Unit:** estimator math, eligibility gate, keep-recent-turns selection,
  LRU cache behavior, replacement-block assembly (fake renderer).
- **Integration:** fake upstream asserts the rewritten payload shape
  (image blocks + stub); fail-open path (renderer throws → original payload
  forwarded); `400`-retry path; `PXPIPE_ENABLED=false` → byte-identical
  passthrough; SSE responses untouched.

## 11. Non-goals

- Response-side transforms; PDF or multi-format rendering; persistence;
  providers other than the configured Anthropic-compatible upstream;
  transforming system prompts or assistant history.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Model misreads rendered text (fidelity loss on code) | Conservative defaults: min-chars, keep-recent-turns, opt-in flag |
| Upstream model without vision → `400` | Manual smoke test per model + one-shot retry with original payload |
| First activation invalidates upstream prompt cache | Documented; deterministic rendering + cache restore hits from turn 2 on |
| Render latency on large blocks | LRU cache; page cap; `@napi-rs/canvas` upgrade path |
