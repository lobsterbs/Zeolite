# Zeolite roadmap

This is the execution plan for the Zeolite feature program. Each phase is
one version milestone (see docs/versioning.md) and lands through CI
(cargo fmt/clippy/test, wasm build, tsc, vite build, compat probes) before
the next phase starts. No phase starts while the previous one is red.

## Phase 0 — 1.0 Nitride (shipped)

Rename LobsterJet to Zeolite across crates, workspace, CI, app and docs;
introduce the version system (docs/versioning.md) with the version
indicator exposed in the rewriter crate, the service worker and the
network log reply.

Known follow-ups for this phase: the GitHub repository itself must be
renamed to `Zeolite` in the org settings (GitHub redirects keep old URLs
working); LobsterBrowse-side references to the old engine name are
updated in the 1.1 adapter pass.

## Phase 1 — 1.1 Oxide: interception API + rules engine + modification (shipped)

Prompts items 9, 10, 11.

- Public interception API on the engine: `intercept("fetch" |
  "websocket" | "navigation" | "worker" | "request" | "response")`
  handlers that can inspect, block, rewrite URLs and modify headers
  safely. Modular, documented, standalone (no LobsterBrowse deps).
- Rules engine: block / allow / rewrite / modify lists plus
  resource-type filters, as reusable data the engine compiles once.
- LobsterBrowse's ad/tracker blocking migrates onto this system.
- Streaming is preserved: header-only transforms by default; response
  body transforms are opt-in with explicit size gates. Huge responses are
  never buffered just to modify them.

## Phase 2 — 1.2 Halide: rewrite tracing + diagnostics + inspector depth (shipped)

Prompts items 5, 18, 4.

- Opt-in rewrite tracing: per-decision records (original value, result,
  rule/subsystem, resource, timestamp) in a ring buffer in the service
  worker, enabled by a `zl:tracing` message. Zero allocation when off.
- DevTools diagnostics feed with concrete errors (SW registration
  failed, cookie rejected, rewrite failed, worker failed, storage
  unavailable, request blocked) including URL, subsystem, timestamp.
- Inspector detail view per request: headers, request, response,
  cookies, timing, initiator, raw data, and both the original target URL
  and the internal Zeolite URL. WebSocket rows land with 1.3.

## Phase 3 — 1.3 Carbide: WebSocket (shipped)

Prompt item 1. Runtime WebSocket over a raw Wisp TCP stream (TLS stays
with the transport): open/message/error/close, send, binary frames,
reconnecting apps, ws:// upgraded to wss://. Connections and messages
are visible in the inspector; connection state is cleaned up on
close/teardown to avoid leaks.

## Phase 4 — 1.4 Boride: virtual origins + cookies (shipped)

Prompt item 2. Virtual-origin registry mapping each target origin to
its Zeolite-internal representation; per-origin cookie jars with Domain,
Path, Secure, SameSite, expiration/max-age, host-only and deletion
semantics; Set-Cookie surgery in the rewriter emit; redirects re-bind
cookies correctly. Isolation between target origins is a hard gate.

Shipped as the 1.4 release: the registry and jars live in `app/src/cookies.ts`
(RFC 6265 admission, Set-Cookie capture before hostile-header surgery,
jar-as-Cookie-source on every engine request, IndexedDB persistence;
see docs/cookies.md). Honest limits: Set-Cookie on intermediate redirect
hops followed inside the transport is not captured (only final responses
are), SameSite is parsed but not enforced (engine-initiated requests
have no site context), and document.cookie virtualization is Phase 5
scope.

## Phase 5 — 1.5 Silicide: storage virtualization + blob/data URLs (shipped)

Prompts items 3, 8. Per-origin localStorage/sessionStorage/IndexedDB
partitioning (extending the existing `zl:<sitehash>:` scheme), Cache API
partitioning where practical, and correct blob:/data:/about: handling
(createObjectURL, blob workers, blob media, generated downloads) with
regression tests.

Shipped as the 1.5 release: localStorage/sessionStorage are scoped by
the existing `zl:<sitehash>:` key prefix in the bootstrap; IndexedDB
names and Cache API names are prefixed the same way (open, delete,
databases, has, keys, match are wrapped, so a proxied site only ever
sees its own databases and caches); document.cookie is virtualized
through the `zl:docCookie` control message against the 1.4 jar (the
page keeps an eventually-consistent cache because the getter is
synchronous); blob:/data:/about: pass through the fetch handler
untouched (see docs/storage.md). Honest limits: document.cookie reads
are eventually consistent (the local cache is corrected by the
authoritative jar reply), Expires-based deletion is not detected
optimistically in the page, and IDBFactory.cmp is not wrapped.

## Phase 6 — 1.6 Hydride: worker + service worker virtualization (next)

Prompts items 6, 7. Classic and module workers wrapped with the runtime
(importScripts, module imports, fetch, WebSocket keep working through
the engine); SharedWorker where practical. navigator.serviceWorker
shim (register/getRegistration(s)/unregister/update, installing/
waiting/active/controller states) with per-origin isolation. Browser
security limits (the engine origin owns the real SW scope) are
documented, not hacked around.

## Phase 7 — 1.7 Sulfide: downloads + session export

Prompts items 12, 13. Download manager fed by engine network info:
filename, MIME, size, progress, speed, source, status, errors,
cancellation; streamed to disk, never fully buffered. Encrypted session
export/import (cookies, storage, IndexedDB, tabs) in a format clearly
separate from engine configuration; no plaintext secrets.

## Phase 8 — 1.8 Telluride: fingerprinting resistance

Prompt item 14. One internally-consistent config object drives
userAgent, platform, screen, timezone, language, hardwareConcurrency,
deviceMemory, canvas and WebGL surfaces. Configurable by the host app;
no per-session randomization, no contradictory values.

## Phase 9 — 1.9 Fullerene: compat suite + scoreboard + recording/replay

Prompts items 15, 16, 17. Expand the probe suite to real browser
behavior (HTML/CSS/JS, fetch, XHR, WebSocket, workers, storage, cookies,
Cache API, redirects, SPA routing, iframes, blob/data, downloads, media,
error handling). Structured JSON results and a per-capability
scoreboard, no invented percentages. Deterministic recording of
navigations, requests, responses, rewrite decisions, cookies and
WebSocket messages, with a replay harness for regression testing engine
changes against recorded sessions.

## Phase 10 — 2.0 Graphene: documentation + final hardening

Prompts items 22, 23. Docs rewritten to describe actual behavior with
a per-feature support/limitation matrix (no claims beyond reality), full
regression pass, performance audit (streaming preserved, long-running
WebSocket memory, listener/worker cleanup) and security audit (origin,
cookie and storage isolation, CSP, header injection, SSRF, open
redirects).

## Cross-cutting gates (every phase)

- Architecture (item 19): LobsterBrowse -> Zeolite public API ->
  Zeolite runtime -> rewrite/interception -> transport -> target. The
  engine never depends on LobsterBrowse UI code; anything reusable
  lives in the engine.
- Performance (item 20): streaming always, tracing and verbose logging
  opt-in, no duplicated response bodies, cleanup of listeners, workers
  and WebSocket state.
- Security (item 21): origin/cookie/storage isolation, no open proxy,
  no XSS/CSP weakening, URL validation, header-injection and SSRF
  guards.
- No fake implementations (item 15 spirit): every feature either works
  and is tested, or is documented as limited. Nothing pretends.
