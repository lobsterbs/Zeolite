# Performance audit (2.0 Graphene)

Facts from the 2.0 codebase and CI run 36349912927 (green, at commit
6da9bba). No benchmarks are invented; where a number is stated it is
measured by CI.

## Streaming everywhere (preserved through 2.0)

- HTML and CSS rewriting runs through a TransformStream chunk-by-
  chunk; responses are never fully buffered for rewriting.
- Standalone stylesheets stream the same way since 2.4 Bromide
  (JsCssRewriter): through 2.3 they were buffered whole for a one-shot
  url() pass, which delayed first paint on large CSS. The streaming
  rewriter retains only the incomplete url( token tail between
  chunks, so output is byte-identical to the one-shot pass.
- Interception request bodies are capped by BODY_LIMIT (intercept.ts);
  a body larger than the cap is not read into memory whole.
- Tracing and diagnostics are opt-in and zero-allocation while off:
  the enabled-flag gate comes first in every entry point.

## Measured sizes (CI job wasm, run 36349912927)

- rewriter_wasm_bg.wasm: 62,984 bytes
- wisp_wasm_bg.wasm: 26,454 bytes
- bootstrap.js (built): 5,093 bytes minified (2.18 kB gzip), under
  the 5120-byte gate enforced in CI. The bootstrap is byte-budgeted:
  any change to bootstrap.ts must be checked against the gate.

## Bounded memory by design

All long-lived buffers are fixed-size rings:

- Network log: 256 entries (oldest evicted).
- Tracing ring: 512 decisions.
- Diagnostics: 512 events, 256 trace references.
- Recording slices are taken from these rings at zl:recordStop; a
  recording cannot grow unbounded.

## Cleanup paths

- WebSocket bridge registry holds only live connections; close/error
  removes them, zl:teardown calls closeAll().
- zl:teardown unregisters, clears caches and cookie jars
  (jarClear), resets rings and closes bridges.
- Worker prelude routing adds no persistent state; swshim
  registrations are virtual records with no queued jobs.
- Download registry entries are removed on completion/cancel; the
  tracker counts bytes through, it does not buffer them.

## Suite wall time (CI facts)

- The app job (npm install + build + full vitest + gates) runs in
  roughly 4 minutes on the hosted runner; the vitest suite itself
  completes in ~4 seconds (28 test files: 12 app unit, 16 extension
  runtime).
- A 300-second timeout guard kills a wedged vitest instead of
  hanging the job for hours.
- The compat suite (probe, capability scoreboard, replay) runs only
  nightly; ordinary pushes pay nothing for it.

## Deliberate non-optimizations

- No speculative caching layer: every response streams through once.
- No per-session randomization in fingerprinting (consistency over
  novelty work).
- The scoreboard gates only proven-safe capabilities; report-only
  rows exist to surface reality, not to spend CI time pretending.
