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

## Phase 13 - 2.3 Selenide: worker virtualization completion

Closes the 1.6/1.8 limits.

- Module workers get the prelude treatment (route import specifiers in
  the prelude, not only via rewriter passes).
- SharedWorker WebSocket through the engine bridge (single relay parent
  rule stays: the engine is the relay, not a page).
- Fingerprint patches for workers and OffscreenCanvas (currently
  documents only).
- Keep the honest boundary: no virtual SW script is ever fetched or
  executed; the engine owns the only real scope.

## Phase 14 - 2.4 Bromide: rewriter parity + deep LobsterBrowse integration

- Port LobsterBrowse's js_antiframe pass into the wasm rewriter (known
  parity gap since the split).
- Deep LobsterBrowse integration: the /zlsw/ embed stops being an
  afterthought. The subpath alias is a first-class build target (the 2.1
  CI variant becomes the LB-consumed artifact), the zl: control plane is
  bridged into LB's DevTools surfaces, and the download registry, session
  export, fingerprint profiles and cookie-jar UI consume the engine
  implementations instead of parallel LB ones. The architectural gate
  still holds: the engine keeps zero LB imports and stays
  standalone-buildable; all integration lives in the adapter.
- CSS stream size gate: stream large CSS without injecting the
  window.__ZL init script for non-document CSS responses.
- zeolite-server: arena reuse for the streaming rewrite paths; keep
  time-to-first-paint the primary metric, measured in the CI artifacts.

## Phase 15 - 2.5 Iodide: scoreboard expansion + real-site probes

- Promote report-only scoreboard rows to gated as they become
  CI-verifiable; never invent percentages.
- A periodic (not per-push) probe pass against a small list of real
  destinations through a real zeolite-server, results committed as
  structured JSON only; failures open issues, they do not gate merges
  (flaky external targets must not break CI).
- Extend replay comparisons to WebSocket lifecycle and cookie jar shape
  (both already recorded; never payloads or values).

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
