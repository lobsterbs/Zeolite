# Performance audit (3.0 Diamond re-audit)

Facts from the codebase and CI run 36530935953 (artifact sizes
measured at the 2.5 cut; the 3.0 release changes only version
strings and docs on top, and every size gate re-runs in CI on each
push). No benchmarks are invented; where a number is stated it is
measured by CI.

## Streaming everywhere (preserved through 3.0)

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

## Measured sizes (CI job wasm, run 36530935953)

- rewriter_wasm_bg.wasm: 72,242 bytes (62,984 at the 2.0 cut; the
  +9,258 growth is the 2.3-2.5 feature set: the antiframe pass, the
  streaming CSS rewriter and the mirror scheme encode paths).
- wisp_wasm_bg.wasm: 26,454 bytes (unchanged since 2.0).
- bootstrap.js (built): 5,068 bytes minified (2.17 kB gzip), under
  the 5120-byte gate enforced in CI. The bootstrap is byte-budgeted:
  any change to bootstrap.ts must be checked against the gate.

## Bounded memory by design

All long-lived buffers are fixed-size rings:

- Network log: 256 entries (oldest evicted).
- Tracing ring: 512 decisions.
- Diagnostics: 512 events, 256 trace references.
- Recording slices are taken from these rings at zl:recordStop; a
  recording cannot grow unbounded.
- WebSocket bridge and worker-prelude state hold only live
  connections; the download tracker counts bytes through, it does
  not buffer them.

## Cleanup paths

- WebSocket bridge registry holds only live connections; close/error
  removes them, zl:teardown calls closeAll().
- zl:teardown unregisters, clears caches and cookie jars
  (jarClear), resets rings and closes bridges.
- Worker prelude routing adds no persistent state; swshim
  registrations are virtual records with no queued jobs.
- Download registry entries are removed on completion/cancel.

## Suite wall time

- The 2.0-audit wall-time facts (app job ~4 minutes hosted, vitest
  ~4 seconds, the 300-second wedged-vitest guard) were not
  re-measured for this release; the guards are unchanged in CI.
- The compat suite (probe, capability scoreboard, replay) runs only
  nightly; ordinary pushes pay nothing for it.

## Deliberate non-optimizations

- No speculative caching layer: every response streams through once.
- No per-session randomization in fingerprinting (consistency over
  novelty work).
- The scoreboard gates only proven-safe capabilities; report-only
  rows exist to surface reality, not to spend CI time pretending.


## Runtime performance work (cold starts, transport and page cache)

- Route-key restore and cookie-profile restore start concurrently. Legacy
  cache cleanup and the already-started worker/extension boot overlap with
  client-root recovery. Cookie identity is assigned only after both
  security-critical snapshots settle.
- The first request records one diagnostic with boot phase durations. It
  contains no URL, cookie, header or request-body values. Rule and policy
  fetches are awaited together.
- libcurl-transport 2.0.6 uses a bounded pool of 64 active connections,
  48 idle cached connections and 8 connections per host. Its defaults
  are 60/50/6. Transport diagnostics sample peak pending fetches and
  mean request-to-headers time every 32 successful Wisp fetches. The
  library does not expose internal queue wait separately, so this
  measure includes local pool wait and upstream time-to-headers.
- The page cache retains its 60-entry cap and 4 MiB per-entry cap, and
  adds a 32 MiB total byte budget. Unknown-length bodies are metered as
  they stream into the cache; an oversized cache write cannot consume
  the live response branch.
- A separate Vary-aware metadata cache stores byte counts and last-use
  timestamps, allowing LRU eviction without cloning or rewriting a
  response body on every cache hit. Missing or corrupt metadata falls
  back conservatively to the 4 MiB per-entry ceiling.
- Public static assets continue to use the existing shared cache path
  when origin cache headers and credential/Vary checks permit it; no
  separate cache path bypasses those rules.

These limits are bounded tuning choices, not proof that every workload
is faster. Compare cold/warm direct-Chromium and Zeolite runs on identical
networks and hardware before raising them.
