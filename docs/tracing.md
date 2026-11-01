# Zeolite rewrite tracing + inspector depth (Phase 2, 1.2 Halide)

Three opt-in observability surfaces, all served by the engine origin
and all zero-cost for the request path while unused.

## Rewrite tracing (app/src/tracing.ts)

A bounded ring (512 decisions) of per-decision records: original value,
result, subsystem, rule, resource type, timestamp and the diagnostics
trace id. The enabled-flag gate comes first: while tracing is off,
nothing is allocated. Secrets are redacted before storage.

Control plane:

- { type: "zl:tracing", enabled: boolean } toggles the ring. Off by
  default; resets to off on SW restart, so the host re-sends it.
- { type: "zl:getTracing", since: seq } delta poll, same cursor
  protocol as zl:getNetLog.

Recorded seams: rules engine decisions (block with the matched host,
URL rewrites), interception handler decisions (block, URL rewrite),
transport decisions (NativeTransit / RewriteFallback with the fallback
reason, redirect final destinations) and the html/css rewrite
boundaries.

Since #529 the token-level decisions inside the wasm rewriter are
surfaced through the same opt-in: rewriteStream enables the
per-instance wasm trace and drains the aggregated fixed-vocabulary
(pass, decision, count) pairs into the ring at stream end. No source
text, URL or host ever enters a trace entry. Standalone CSS streams
and the one-shot JS body rewrite stay untraced (those paths do not
carry a per-request rewriter instance).

## Diagnostics feed (app/src/diag.ts)

The zl:getDiag delta poll (same cursor protocol) returns structured
events with category, severity, cause, lifecycle stage, URL and
timestamp: SW failures, rewrite failures, blocked requests, upstream
errors and more. The DevTools page renders them severity-colored.
Bounds: 512 events, 256 trace references, secrets redacted on entry.

## Inspector detail view

Every network-log entry carries a detail record: the original target
URL (entry.dest), the internal engine URL, method, status, ttfb,
initiator (the controlling page destination, when the SW can resolve
the client), redacted request and response headers, and Set-Cookie
names from the response (values are never stored). Click a request row
in the DevTools page to view it.

Honest limits: cookie values are never stored (names only); the
initiator is unknown when the SW cannot resolve the client (for
instance right after a restart); WebSocket rows land with 1.3.

## Status

Implemented (1.2 Halide).
