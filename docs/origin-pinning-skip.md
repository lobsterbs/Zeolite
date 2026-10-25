# Origin-pinning script literal skip (#449)

## The problem

Some loader scripts validate every URL they build against an anchored
origin-pinning regex before using it. The real gapi client.js
(apis.google.com/js/client.js) carries the literal:

    /^https?:\/\/[a-z0-9_.-]+\.google(rs)?\.com(:\d+)?\/[a-zA-Z0-9_.,!=\-\/]+$/

and builds its load URL from the string "https://apis.google.com".
A rewritten route token fails the pin and the loader throws
("Bad hint: failed sanity") before any fetch, so rewriting the URL
literals in that body breaks the loader outright (LobsterBrowse #154
class: the script loads 200 and then dies).

## The fix

`has_origin_pinning_regex(js)` in `crates/rewriter/src/js/literals.rs`
is a plain substring scan for the anchored needles `^https?:` and the
escaped-colon spelling. When it fires, `rewrite_script` skips the
URL-literal pass for the whole body and returns it verbatim. The scan
is deliberately whole-script: a per-literal skip would break
comparisons that work today.

The gate is exported as `hasOriginPinningRegex` from the wasm module
and surfaced to the app through the optional `scriptPinsOrigins`
seam in `app/src/transform.ts` (never throws; a wasm without the
export, or a failing detector, reports false and the literal pass
runs).

## Machine-readable telemetry

When the skip fires, the request engine records it three ways:

- netLog: the trace's row is re-annotated `rewritten: "js-pinned"`
  (`netLogAnnotateRewrite` in `app/src/netlog.ts`).
- trace ring: `traceDecision({ subsystem: "rewriter", rule:
  "origin-pinning", result: "literal-skip", ... })`.
- diag: a `PINNED_SCRIPT` stage event (DiagStage gained the member).

Both script-serve paths report it: the fresh upstream path and the
rewritable cache-hit path.

## Invariants

- The skip is literal-pass only. Frame-buster neutralization, the
  #235 globals pass, and every runtime seam (fetch/XHR shim, anchor
  nav guard, window.open guard) still run: no request escapes the
  engine because of this skip.
- A false positive only loses the literal pass for one script body;
  the runtime seams keep routing. A false negative is today's
  behavior. The failure direction is safe.
- Unpinned scripts rewrite exactly as before (regression-tested in
  `crates/rewriter/src/js/literals.rs`).

## Honest residual

The skip leaves ALL string literals in a pinned body verbatim,
including the gapi `jsl` config-block URLs. Those URLs reach the
runtime seams as authored and route through the engine there; the
literals themselves are simply not pre-rewritten. The e2e check
(suite/e2e/e2e.mjs, "pinned loader: literal skip, loader validates,
nothing escapes the engine") proves the loader validates, the fetch
canary rides the engine, and no browser-direct request escapes.

The gapi-native `policy.kdl` rule stays as the backstop for hosts
that must never be rewritten at the transport layer.
