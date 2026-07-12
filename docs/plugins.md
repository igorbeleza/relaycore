# Plugin System

RelayCore's request optimizers are structured as an ordered set of **plugins**. Each plugin is a
small, self-contained unit that can rewrite the outgoing request body, observe completed requests, or
both. The registry runs them in a fixed order with per-plugin fault isolation, so one misbehaving
optimizer can never fail a request or block the others.

The two shipping optimizers — **dedup** and **pxpipe** — are themselves built-in plugins. Nothing in
the request path treats them specially; they use the same public `RelayPlugin` interface described
below.

## Concepts

The contract lives in `src/plugins/types.ts`:

- **`RelayPlugin`** — the interface every plugin implements.
  - `name` — stable identifier used as the key in metrics, logs, and aggregated stats.
  - `isEnabled(config)` — called per request; returns whether the plugin is active for the current
    configuration. A disabled plugin is skipped entirely.
  - `transformRequest?(body, ctx)` — optional ordered request-body transform, run before the request
    is forwarded upstream. Omit it for observe-only plugins.
  - `onComplete?(event, ctx)` — optional read-only hook fired after every response (success or
    error). For streaming responses it fires when the stream *starts*, so `event.bytesOut` is `0` — a
    pre-existing limitation inherited from the dashboard recorder.
- **`TransformResult`** — what `transformRequest` returns: `{ body, changed, stats }`.
  - `changed` MUST be `true` only on a real change. It drives the route's "retry once with the
    original body on upstream 400" safety net, so a false positive wastes an upstream round-trip.
  - `stats` is a `PluginStats` (`Readonly<Record<string, number>>`). It always carries an
    `estTokensSaved` estimate; built-ins add their own numeric detail fields.
- **`PluginContext`** — a read-only `{ config, requestId, logger, metrics }` handed to every hook.
  Plugins observe it but never mutate it; `metrics`/`logger` let a plugin own its observability
  exactly as the built-ins do.

## Registry

`src/plugins/registry.ts` holds the ordered plugins and runs their hooks (SRS REQ-F-062):

- `runTransforms(body, ctx)` runs every enabled `transformRequest` in registration order, threading
  the body through each, and returns a `TransformOutcome` — `{ body, changed, statsByPlugin }`.
- `runOnComplete(event, ctx)` runs every enabled `onComplete` hook.
- `names` and `hasEnabledTransforms(config)` are introspection helpers for diagnostics and for
  skipping the transform machinery when nothing is enabled.

**Fault isolation (fail-open).** A plugin may throw from either hook. The registry catches it,
*skips* that plugin (the request proceeds with the body it had before that plugin ran), records the
failure on the metrics registry, logs a warning, and continues with the remaining plugins. This
generalises pxpipe's original render-failure fail-open behaviour to every plugin.

## Execution order

`createBuiltinPlugins(renderer, cache)` in `src/plugins/index.ts` builds the default registry in the
required order:

1. **dedup** — collapses duplicate blocks into short references.
2. **pxpipe** — renders remaining large text blocks into images.

The order is fixed for correctness: pxpipe must not spend work rendering content that dedup already
removed. Each optimizer is a no-op when its own flag is disabled.

## Built-in plugins

| Plugin   | Enabled by         | `changed` when          | Stat fields (beyond `estTokensSaved`)                        |
| -------- | ------------------ | ----------------------- | ------------------------------------------------------------ |
| `dedup`  | `DEDUP_ENABLED`    | `blocksDeduped > 0`     | `blocksDeduped`                                              |
| `pxpipe` | `PXPIPE_ENABLED`   | `blocksConverted > 0`   | `blocksConverted`, `pagesRendered`, `cacheHits`, `renderFailures` |

Both built-ins record their own domain metrics (`recordDedup`, `recordPxpipeConversion`) inside the
hook, in addition to the `estTokensSaved` estimate they return in `stats`. pxpipe absorbs its own
render errors into `stats.renderFailures` rather than throwing, so it fails open internally as well.

## Metrics

Every skipped-on-throw hook is counted per plugin and exported at `/metrics`:

```
# TYPE relaycore_plugin_failures_total counter
relaycore_plugin_failures_total{plugin="dedup"} 0
relaycore_plugin_failures_total{plugin="pxpipe"} 2
```

This is emitted by `MetricsRegistry.recordPluginFailure(name)` / `renderPrometheus()` and is the
primary signal that a plugin is misbehaving in production.

## Writing a new plugin

1. Implement `RelayPlugin`. Give it a stable `name`, gate it behind a config flag in `isEnabled`, and
   implement whichever hooks you need.
2. In `transformRequest`, return `changed: true` **only** on a real body change, and always populate
   `stats.estTokensSaved`. Prefer recording your own domain metrics via `ctx.metrics` rather than
   overloading the stats record.
3. Add it to the registry order in `createBuiltinPlugins` (or construct a `PluginRegistry` with your
   own list). Place cheaper/reductive transforms before more expensive ones.
4. Let the registry handle failures — throw to fail-open, or absorb errors internally if you want to
   keep partial results.
