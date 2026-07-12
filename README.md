# RelayCore

RelayCore is a production-oriented gateway for AI coding agents. The first release targets
compatibility with the Anthropic Messages API and providers that implement it.

> Status: early development. RelayCore proxies `POST /v1/messages` to a configured
> Anthropic-compatible upstream, including SSE streams.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer

## Run locally

```bash
npm install
copy .env.example .env
npm run dev
```

On macOS or Linux, replace `copy` with `cp`.

Verify the service:

```bash
curl http://127.0.0.1:47822/health
```

```json
{ "status": "ok", "version": "0.1.0" }
```

Check upstream configuration and reachability:

```bash
curl http://127.0.0.1:47822/health/upstream
```

This endpoint verifies that `UPSTREAM_API_KEY` is configured and that the upstream base URL responds
at the HTTP level. It does not send prompts or perform a model request.

## Commands

| Command                | Purpose                               |
| ---------------------- | ------------------------------------- |
| `npm run dev`          | Run the server with file watching.    |
| `npm run build`        | Compile TypeScript into `dist/`.      |
| `npm start`            | Run the compiled service.             |
| `npm test`             | Run unit and integration tests.       |
| `npm run lint`         | Check source code with ESLint.        |
| `npm run format:check` | Verify Prettier formatting.           |
| `npm run typecheck`    | Run TypeScript checks without output. |

## Run with Docker

```bash
docker compose up --build
```

The service will listen on `http://127.0.0.1:47822`.

## Configuration

| Variable              | Default                       | Description                               |
| --------------------- | ----------------------------- | ----------------------------------------- |
| `HOST`                | `127.0.0.1`                   | HTTP listener address.                    |
| `PORT`                | `47822`                       | HTTP listener port.                       |
| `NODE_ENV`            | `development`                 | `development`, `test`, or `production`.   |
| `LOG_LEVEL`           | `info`                        | Pino/Fastify log verbosity.               |
| `UPSTREAM_BASE_URL`   | `https://api.oneprovider.dev` | Base URL of the compatible provider.      |
| `UPSTREAM_API_KEY`    | _(required for proxying)_     | API key held only by RelayCore.           |
| `UPSTREAM_TIMEOUT_MS` | `120000`                      | Upstream request timeout in milliseconds. |
| `DEBUG_TOKEN`         | _(disabled)_                  | Enables protected local debug endpoints.  |

## Configure Claude Code

Set Claude Code to use RelayCore and a non-secret placeholder key: RelayCore replaces it with
`UPSTREAM_API_KEY` before sending to the provider.

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:47822'
$env:ANTHROPIC_API_KEY = 'relaycore-local'
claude
```

Add your real OneProvider key to `UPSTREAM_API_KEY` in `.env` before running `claude`.

## Observability

Every response contains an `x-request-id`. RelayCore logs safe request metadata such as request ID,
HTTP method, route, status, duration, selected model, and upstream status. It never logs request
bodies, model output, or provider keys.

Prometheus-compatible metrics are available locally at `GET /metrics`.

Upstream failures are counted by HTTP status and sanitized error type:

```text
relaycore_upstream_errors_total{status_code="400",error_type="invalid_request_error"} 1
```

When the upstream provider returns an error, RelayCore responds with a sanitized Anthropic-style
error payload containing the local `request_id`, upstream request ID when available, and upstream
HTTP status. This makes Claude Code failures easier to diagnose without exposing prompts or secrets.

Set `DEBUG_TOKEN` in `.env` to enable the protected local diagnostic endpoint:

```powershell
$headers = @{ Authorization = 'Bearer your-debug-token' }
Invoke-RestMethod -Uri 'http://127.0.0.1:47822/debug/last-error' -Headers $headers
```

RelayCore also keeps a small in-memory history of recent sanitized errors:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:47822/debug/errors' -Headers $headers
Invoke-RestMethod -Uri 'http://127.0.0.1:47822/debug/errors?status_code=400' -Headers $headers
Invoke-RestMethod -Uri 'http://127.0.0.1:47822/debug/errors?error_type=invalid_request_error' -Headers $headers
```

Without `DEBUG_TOKEN`, debug endpoints respond as not found.

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

## License

MIT. See [LICENSE](LICENSE).
