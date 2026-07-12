# Architecture Overview

RelayCore is organized as a modular Fastify application. It establishes the configuration boundary,
application factory, HTTP health surface, process entrypoint, and Anthropic-compatible message relay.
`/health/upstream` performs a lightweight upstream reachability check without sending prompt content
or making a model request.

The message route replaces client authentication with its locally held upstream key, forwards
Anthropic version headers, and preserves non-streaming JSON responses or SSE event bytes. Upstream
errors are converted into sanitized Anthropic-style diagnostics with request IDs and upstream status
metadata.

Metrics are exposed behind the same application factory at `/metrics`, including upstream error
counters grouped by HTTP status and sanitized error type. Protected debug routes read from an
in-memory diagnostics registry that stores only recent sanitized error records and is disabled unless
`DEBUG_TOKEN` is configured. `/debug/last-error` returns the newest record, while `/debug/errors`
returns recent records with optional `status_code` and `error_type` filters.

- **pxpipe transform** (`src/pxpipe/`): optional, opt-in stage inside
  `POST /v1/messages` that converts large text blocks in old user turns into
  base64 PNG image blocks before forwarding upstream. Eligibility is decided
  by a token cost-compare gate; rendering is deterministic (`pureimage` +
  vendored DejaVu Sans Mono) and cached in an in-memory LRU keyed by sha256.
  Fail-open: any error forwards the original body. Upstream `400` for a
  transformed request triggers a single retry with the original body.
