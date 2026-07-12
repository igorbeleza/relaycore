# CLAUDE.md

RelayCore — a production-oriented gateway/proxy for AI coding agents, compatible with the
Anthropic Messages API. Proxies `POST /v1/messages` (including SSE streams) to a configured
Anthropic-compatible upstream, swapping the client's placeholder key for `UPSTREAM_API_KEY`.

## Commands

```bash
npm run dev           # tsx watch src/server.ts (port 47822)
npm test              # vitest run
npm run test:watch
npm run lint          # eslint .
npm run typecheck     # tsc --noEmit
npm run format:check  # prettier
npm run build         # tsc -> dist/
```

Full pre-PR gate (mirrors CI): `format:check && lint && typecheck && test && build`.
Requires Node >= 22. Smoke test: `curl http://127.0.0.1:47822/health`.

## Architecture

Modular Fastify 5 app built by a factory (`src/app/create-app.ts`) with injectable
dependencies (client, metrics, diagnostics) for testing.

- `src/server.ts` — process entrypoint
- `src/config/env.ts` — Zod-validated config; THE ONLY place allowed to touch `process.env`
- `src/routes/messages.ts` — `/v1/messages` relay: auth swap, SSE passthrough, sanitized errors, response-header allowlist
- `src/routes/debug.ts` — `/debug/last-error`, `/debug/errors` (only when `DEBUG_TOKEN` set, min 16 chars)
- `src/providers/` — upstream HTTP client + `/health/upstream` reachability check
- `src/metrics/` — Prometheus text at `/metrics`
- `src/diagnostics/` — in-memory registry of recent sanitized errors
- `tests/unit/`, `tests/integration/` — Vitest

## Docs Map

- `README.md` — run/config/observability reference (keep in sync when behavior changes)
- `docs/architecture-overview.md` — component overview
- `docs/PRD_Claude_Proxy_v0.1.md`, `docs/SRS_Claude_Proxy_v0.1.md` — requirements (in Portuguese; IDs RF-_/REQ-F-_ used for traceability to tests)
- `CONTRIBUTING.md` — PR checklist and rules

## Rules & Gotchas

- **Never** read `process.env` outside `src/config/env.ts`. Config is frozen; trailing slash is stripped from `UPSTREAM_BASE_URL`.
- **Never** log request bodies, model output, or provider keys. Error messages forwarded to clients are sanitized and truncated (500 chars).
- Zod **v4** API (`z.url()`, `z.prettifyError`) — do not use v3 idioms.
- Pure ESM (`"type": "module"`): relative imports in TS need `.js` extensions.
- Do not alter the Anthropic protocol contract; core must stay provider-agnostic (PRD constraint).
- New upstream response headers must be added to the `RESPONSE_HEADERS` allowlist in `src/routes/messages.ts` or they are dropped.
- Every behavior/config change requires a docs update (CONTRIBUTING rule).
- Keep changes covered by tests; requirements trace to at least one test (SRS).

## Roadmap (not yet implemented)

- **Token-saving text-to-image transform (pxpipe-like)**: automatically render long text
  blocks in proxied requests as images to reduce token usage. Specified as RF-016 (PRD)
  and REQ-F-100..103 (SRS); not implemented yet.
- Plugin mechanism (RF-009/REQ-F-060..062) and retry policy (RF-012) are specified but not built.

## Notes

- `docs/ategora.md` — project history imported from another platform (ChatGPT/Codex sessions): bootstrap PR-001, port move 47821→47822, OneProvider proxy, observability, debug routes. OneProvider-accepted model IDs: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001`.
- Git branch `master` currently has no commits.
