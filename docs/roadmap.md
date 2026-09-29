# Zeolite roadmap

This is the execution plan for the Zeolite feature program. Each phase is
one version milestone (see docs/versioning.md) and lands through CI
(cargo fmt/clippy/test, wasm build, tsc, vite build, compat probes) before
the next phase starts. No phase starts while the previous one is red.

## Shipped: the 1.x/2.0 program

The original 23-item program is complete. History, one line per release:

- 1.0 Nitride: rename to Zeolite, version system (docs/versioning.md).
- 1.1 Oxide: interception API, rules engine, header/response modification,
  LobsterBrowse ad/tracker blocking migrated onto it.
- 1.2 Halide: rewrite tracing ring (zl:tracing), DIAG diagnostics feed,
  inspector detail view.
- 1.3 Carbide: WebSocket over raw Wisp TCP streams, inspector rows,
  connection cleanup.
- 1.4 Boride: virtual origins + per-origin RFC 6265 cookie jars
  (app/src/cookies.ts, docs/cookies.md).
- 1.5 Silicide: storage virtualization (zl:<sitehash>: prefixing for
  localStorage/sessionStorage/IndexedDB/Cache API), document.cookie
  virtualization, blob:/data:/about: passthrough (docs/storage.md).
- 1.6 Hydride: worker virtualization (worker-prelude.ts, classic workers,
  dedicated-worker WS bridge), navigator.serviceWorker shim (docs in
  phase notes).
- 1.7 Sulfide: download registry (streamed, cancellable), encrypted
  session export/import (AES-256-GCM + PBKDF2).
- 1.8 Telluride: fingerprint profiles as data, deterministic document
  init script, UA/Accept-Language mirroring (docs/fingerprint.md).
- 1.9 Fullerene: capability scoreboard against a fixture origin
  (suite/capabilities.mjs), deterministic session recording + replay
  (zlRecord, suite/replay.mjs), nightly compat job.
- 2.0 Graphene: docs matrix, security audit (docs/security.md),
  performance audit (docs/performance.md), full regression pass.
- 2.1 Halogen: load-path gates (subpath-alias CI build variant,
  SW-scope import() lint, transport-init self-report, zl:ping version
  handshake). Landed without a version-string bump; no 2.1 release
  was cut.
- 2.2 Arsenide: cookie/session limit closure (SW-followed redirect-hop
  Set-Cookie capture, SameSite opt-in knob, session import merge with
  per-cookie conflict rules, download ring persistence to site-scoped
  IndexedDB, IDBFactory.cmp wrap).
- 2.3 Selenide: worker virtualization completion (module-worker import
  specifier pass, SharedWorker WebSocket through the engine bridge,
  worker + OffscreenCanvas fingerprint patches), plus the issue-tab
  fixes: engine-route CORS response-header surgery (#2) and the
  engine-owned navigation error page (#3). It also carried the
  rewriter's frame-buster neutralization pass (js::antiframe), landed
  just before the cut, closing what this roadmap first listed as a
  Phase 14 item.
- 2.4 Bromide: rewriter parity (standalone CSS streams chunk by chunk
  through the wasm CSS rewriter, byte-identical to the one-shot pass)
  and deep adapter integration: session export/import and the
  downloads registry UIs consume the engine control plane instead of
  parallel implementations. The antiframe port turned out already
  shipped in 2.3; the zeolite-server arena-reuse item was resolved by
  audit (the server relays opaque bytes, there are no server-side
  rewrite paths to pool).

Post-2.0 stabilization commits (2026-09-27/28) fixed three bugs that
broke every proxied request after the 2.0 push: dynamic import() on
ServiceWorkerGlobalScope (now fetch + Function constructor), the module's
own exported fetch shadowing globalThis.fetch in loadBundle, and
wasm/worker-prelude asset URLs frozen to the origin root 404ing under the
subpath alias. All verified live in the real service worker; each one
escaped CI because no gate exercised the full SW load path. That gap is
the first item of the new program.

## New program: the 2.x line

Each phase below closes honest limits the 1.x releases wrote down, or
adds a gate that would have caught a shipped break. Same rules as
before: one phase per release, CI green before the next, nothing claimed
without a gate or test.

## Phase 11 - 2.1 Halogen: load-path gates + stale-worker defense (shipped)

The three network-failure bugs all shared one property: the code built,
tested, and shipped green while the engine could not load a single page.
This phase makes that class of failure loud.

- CI subpath-alias build variant: build the app bundle with the dist
  assets aliased under a subpath (as LobsterBrowse's /zlsw/ does), then
  statically assert every asset URL referenced by sw.js resolves
  relative to self.location.href, not to the origin root. Gate fails on
  any frozen absolute asset path.
- SW-scope loading lint: forbid dynamic import() in any file reachable
  from sw.ts (CI grep gate), since Chromium forbids it on
  ServiceWorkerGlobalScope and the failure only shows at runtime.
- Transport-init self-report: if the transport bundle or the rewriter
  wasm fails to initialize, emit a DIAG event with the concrete error
  before any request is attempted, and answer every zl:* control
  message with a degraded-mode flag so devtools and the host can see a
  dead engine instead of diagnosing 502s.
- Version handshake: sw answers a zl:ping with its version string; the
  devtools page warns when the installed worker version differs from
  the served bundle version (the stale-worker failure mode users hit
  after a dist republish).

## Phase 12 - 2.2 Arsenide: cookie/session limit closure (shipped)

Closes the honest limits recorded in 1.4/1.5/1.7.

- Set-Cookie capture on intermediate redirect hops followed inside the
  transport, not only on final responses.
- SameSite: parsed since 1.4 but never enforced. Add an opt-in policy
  knob on the jar (off by default, honest about site-context
  approximation for engine-initiated requests).
- Session import currently replaces cookie jars wholesale; add a merge
  mode with per-jar conflict rules.
- Download registry: persist the ring to site-scoped IndexedDB so entries
  survive a SW restart; keep no-resume honest until resume is actually
  built.
- Wrap IDBFactory.cmp in the storage partition.

## Phase 13 - 2.3 Selenide: worker virtualization completion (shipped)

Closes the 1.6/1.8 limits.

- Module workers get the prelude treatment (route import specifiers in
  the prelude, not only via rewriter passes).
- SharedWorker WebSocket through the engine bridge (single relay parent
  rule stays: the engine is the relay, not a page).
- Fingerprint patches for workers and OffscreenCanvas (currently
  documents only).
- Keep the honest boundary: no virtual SW script is ever fetched or
  executed; the engine owns the only real scope.

## Phase 14 - 2.4 Bromide: rewriter parity + deep LobsterBrowse integration (shipped)

- Port LobsterBrowse's js_antiframe pass into the wasm rewriter:
  DONE - shipped inside 2.3 Selenide (see the history line above);
  the row is in docs/matrix.md.
- CSS stream size gate: DONE - standalone stylesheets stream through
  the wasm CSS rewriter chunk by chunk (JsCssRewriter, crates/rewriter
  html/css.rs). No whole-body buffering, so large CSS no longer delays
  first paint; the rewriter retains only the incomplete url( tail
  between chunks and output is byte-identical to the one-shot pass
  (Rust test: every char-boundary split). No window.__ZL init is
  injected for the non-document CSS response: CSS is not a document,
  the bootstrap never runs in a stylesheet context. The planned size
  threshold turned out unnecessary: streaming unconditionally is
  simpler and strictly better.
- Deep LobsterBrowse integration: the /zlsw/ embed stops being an
  afterthought. The subpath alias is a first-class build target (the 2.1
  CI variant becomes the LB-consumed artifact), the zl: control plane is
  bridged into LB's DevTools surfaces (net log and diagnostics since
  2.3, the downloads registry since 2.4), and the session export/import
  and download registry UIs consume the engine implementations instead
  of parallel LB ones (Settings session export/import and the DevTools
  downloads registry, both in the adapter repo). The cookie-jar and
  fingerprint-profile surfaces still need engine control messages
  (there is no zl:getJars today); they stay open follow-through for the
  2.x line rather than gate items for this release. The architectural
  gate still holds: the engine keeps zero LB imports and stays
  standalone-buildable; all integration lives in the adapter.
- zeolite-server arena reuse: RESOLVED BY AUDIT - the premise was
  stale, like the antiframe row. The server has no streaming rewrite
  paths: it relays opaque wisp bytes, and rewriting happens client-side
  in the SW's wasm rewriters, which already retain state across chunks
  (the incomplete-token tail) and whose per-chunk allocations are the
  JS-wasm boundary Strings inherent to wasm-bindgen. The server's relay
  loops already reuse their socket-read buffers; the per-packet Vec
  copies that remain are dictated by the wisp-core Packet API. No
  arena-shaped allocation exists to reuse, and the program rules forbid
  claiming a perf win without a gate, so first paint stays what it
  already was: measured by the scoreboard in the CI artifacts.

## Phase 15 - 2.5 Iodide: scoreboard expansion + real-site probes (shipped)

- The scoreboard basis was rebuilt rather than expanded: the 1.9 suite
  probed a plain-HTTP surface zeolite-server never exposed, and its
  first executed run was all-404. The 2.5 suite rides the real surface:
  a wisp v2.1 CONNECT tunnel with raw HTTP/1.1 inside, and the
  real-destination probes pass in CI (run 36479436783). Failures still
  open issues instead of gating merges.
- Replay comparisons now include the recorded WebSocket lifecycle and
  cookie-jar shape (contract facts only; never payloads or values).
- Promotion of client-runtime rows stays impossible without a browser
  in CI (there is none, by design); those rows stay client-runtime and
  honestly marked. No percentages invented.
- The nightly compat job failed its first runs on a port collision
  (46102/46103 in use); the fixed schedule (16102/16103) is pending its
  first cron verification - workflow_dispatch is not available to the
  automation account, so the wait is honest, not a choice.
- The issue-tab backlog closed with this release: #4, #10, #12, #13,
  #17, #18 fixed and gated; #5-#9 were harness false alarms, closed
  with the analysis; #20 (mirror route scheme) wired and unit-gated,
  real-site verification staying with the embedder's browser suite.

## Phase 16 - 3.0 Diamond: hardening release

- Full security re-audit against docs/security.md with the new surface
  (redirect-hop cookies, SharedWorker bridge, merge-mode import).
- Performance re-audit: bundle sizes, bootstrap under the 5120 gate,
  memory of long-running WS + worker sessions.
- Docs matrix refresh: every row re-rated against the code, limits
  rewritten where 2.x closed them.
- API freeze for the 3.x line; 3.0 marks the closing of this roadmap.

## Cross-cutting gates (every phase)

- Architecture: LobsterBrowse -> Zeolite public API -> Zeolite runtime ->
  rewrite/interception -> transport -> target. The engine never depends
  on host UI code.
- Performance: streaming always, tracing and verbose logging opt-in,
  no duplicated response bodies, cleanup of listeners, workers and
  WebSocket state.
- Security: origin/cookie/storage isolation, no open proxy, no
  XSS/CSP weakening, URL validation, header-injection and SSRF guards.
- Honesty: every feature either works and is tested, or is documented
  as limited. Nothing pretends. No phase ships while a known
  page-load-breaking regression is open.
