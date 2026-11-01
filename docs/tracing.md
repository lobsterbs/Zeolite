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

Known limit: token-level decisions inside the wasm rewriter are not
surfaced; the seams above are the traced boundary.

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
the client), initiator type, redacted request and response headers, and
Set-Cookie names from the response (values are never stored). Click a
request row in the DevTools page to view it.

Initiator types use only observed evidence: page-side markers on
minted cross-origin Fetch/XHR and engine-routed sendBeacon, a worker
marker for worker fetch, the text/event-stream Accept header for
EventSource, Request.destination for resource kind (not parser versus
script provenance), and Request.mode for navigation. A proxied page can forge the marker and therefore spoof its own
inspector label; it is diagnostic only, never a trust or routing
signal. It is stripped before upstream forwarding and omitted from
inspector and extension-facing header views. No body or credential
values are stored.

Honest limits: same-origin requests that bypass the page re-emitter,
Request-object fetch inputs, and requests without verifiable evidence
remain UNKNOWN. The controlling-page initiator may be unavailable
after a worker restart or client lookup failure; WebSocket rows land
with 1.3.

## Status

Implemented (1.2 Halide).
