# AGENTS.md — Zeolite

Guidance for AI agents and human contributors. Read this before changing code, architecture, CI, or public documentation.

## Project identity
Zeolite is a standalone, reusable Rust/WASM web interception and proxy engine.
The project is explicitly experimental: public status is "experimental", releases are not stability guarantees, and the API/embed contract may change without a deprecation window. Docs must keep stating this. It provides a browser-side service-worker runtime, Wisp v2.1 transport, streaming rewriting, diagnostics, and a WebExtension compatibility layer.
Keep Zeolite independent from LobsterBrowse UI code. Do not document planned behavior as implemented.

## Current architecture
The 1.0 Nitride release is interception + rewriting. The rewriter is production code and must not be removed prematurely.

Long-term architecture: **NativeTransit**. NativeTransit makes transport/interception the preferred path and keeps the existing rewriter as **RewriteFallback**.

    Host app -> Zeolite -> Transport -> NativeTransit
                                  \-> RewriteFallback
                                      -> Wisp -> Network

NativeTransit should preserve original website URLs/content where browser security permits, reuse existing transport/cookie/diagnostic infrastructure, and record every fallback decision and reason. Never create a second network stack or cookie store.

NativeTransit does not bypass browser security boundaries such as same-origin policy, service-worker scope, CSP, CORS, iframe rules, or browser-owned APIs.

Status: the transport-mode decision layer is **Implemented (Alpha)** in `app/src/transit.ts`. Non-document resources are classified NativeTransit and transported without rewriting; document and stylesheet loads are deterministic RewriteFallback (reasons DOCUMENT_REWRITE_REQUIRED / CSS_URL_REWRITE_REQUIRED / UNSUPPORTED_PROTOCOL) recorded as structured network entries in the zl:getNetLog reply (counters + fallback ring), not as diag failure events; genuine rewrite failures emit their own REWRITE diag events (issue #1 finding 5). Redirect hops are followed by the service worker itself (the transport surfaces 3xx
 responses; its fetch adapter ignores the redirect option): every hop's Set-Cookie is captured against the hop URL, 303 (and POST on 301/302) continues as GET, 307/308 replay the method, and a hop that cannot replay (one-shot stream body) or passes the 10-hop cap is surfaced to the page with its Location mapped to an engine route. Final destinations are recorded (REDIRECTED). (2.2 Arsenide) 2.3 Selenide adds engine-owned CORS facts on every engine route (issue #2), the engine error page for failed navigations (issue #3), and completes worker virtualization (module-worker specifier pass, SharedWorker WebSocket bridge, worker and OffscreenCanvas fingerprint patches). 2.4 Bromide streams standalone CSS through the wasm CSS rewriter chunk by chunk (no whole-body buffering; only the incomplete url( tail is held between chunks). Deep-integration item 4 gives the WS bridge per-origin virtual identities: the zl:wsOpen upgrade handshake (headers assembled in `app/src/wsidentity.ts`) carries the initiator's Origin, the jar's cookies for the target and the per-site UA (an active fingerprint profile still wins, Telluride); the initiator origin is the message field when present, else recovered from the controlling client's route, and headers are engine-built only, so a page cannot smuggle handshake headers.

Extension pipeline status: webRequest is wired into the engine fetch path (onBeforeRequest cancellation honored with webRequestBlocking, onBeforeSendHeaders/onHeadersReceived header modification via validated pairs, onCompleted/onErrorOccurred observation; delivery gated by host permissions and listener url filters), webNavigation now exposes beforeNavigate/committed/completed from the real interception lifecycle (cache-hit navigations included), MV3 service-worker backgrounds execute on demand via wakeExtension with a 30s idle termination, script backgrounds boot at install as well as at worker activation (bootInstalled), and tabs.sendMessage delivers background-to-content-script messages through the zl:tabMessage channel with destination verification and 
honest no-listener errors. This pass adds runtime.alarms (in-memory timers in the shared worker context, firing wakes idle MV3 backgrounds, not persisted across engine restarts), management (getSelf/uninstallSelf with no permission, the full surface gated on 'management'), webNavigation listener url filters (webRequest pattern grammar), and webNavigation.onDOMContentLoaded delivered from the page-world bridge (no bridge, no event).

**Do not implement Gecko-specific architecture, dependencies, WASM, or adapters as part of NativeTransit.**

## Repository layout
- `crates/rewriter/` — streaming Rust/WASM rewriter.
- `crates/wisp-core/` — Wisp v2.1 protocol.
- `crates/wisp-extensions/` — auth/lifecycle/server extensions.
- `crates/zeolite-server/` — standalone Wisp/static server and destination protection.
- `crates/wisp-wasm/` — WASM Wisp bindings.
- `app/src/sw.ts` — service-worker/interception entrypoint.
- `app/src/control.ts` — control plane: zl: message dispatch, sender gates, session recording state.
- `app/src/extensions/control.ts` — extension control facade: extension message dispatch + content-script bridge handler.
- `app/src/transform.ts` — response transformation: wasm rewriter lifecycle, worker prelude, streaming HTML/CSS rewrite pipelines (issue #86).
- `app/src/transport.ts` — upstream transport seam: wisp/libcurl client lifecycle behind the Transport interface (issue #84).
- `app/src/extensions/` — WebExtension compatibility runtime.
- `app/src/diag.ts` — bounded diagnostics.
- `app/src/rules.ts` - interception rules engine (block/allow/rewrite/modify, compiled from /rules.json).
- `app/src/intercept.ts` - public interception API (Phase 1).
- `app/src/transit.ts` — NativeTransit transport-mode decision layer + fallback record.
- `suite/` — compatibility probes.
- `docs/` — architecture, roadmap, versioning and adapter docs.

## Interception API + rules engine (Phase 1, 1.1 Oxide)
**Implemented** in `app/src/intercept.ts` (public `intercept(kind, handler)`: request/response plus navigation/worker/websocket/fetch filtered dispatch; block, URL rewrite, header merge; opt-in response body transforms behind the 512 KiB BODY_LIMIT gate, never for documents/stylesheets) and `app/src/rules.ts` (block/allow/rewrite/modify lists with resource-type filters, compiled once from `app/public/rules.json`, which ships the ad/tracker host lists migrated from the browser app's server-side engine plu
s the captcha-host allowlist). The host toggles rules via the `zl:adblock` control message; the flag resets to enabled on SW restart. Contract: docs/interception.md. Honest limits: rules.json is global (per-site compatibility stays in siteconfig.json); the host's per-site adblock overrides apply only to the server-side engine; transformed responses are not page-cached.

## Hard invariants
- Rewriting stays streaming; never buffer whole documents for convenience.
- Attribute parsing must not consume bytes beyond closing quotes.
- Preserve whitespace/delimiters where possible.
- Use RFC-aware scheme detection.
- URL fragments are client-side only: never part of the encoded request target, a cache key, or an upstream identity. The rewriter re-attaches them after the engine route so SVG `<use href="sprite.svg#symbol">` keeps working with one network identity per sprite.
- SVG external references (`<use href>`, `<use xlink:href>`, `<image href>`) must be rewritten like other URL-bearing attributes or sprite icons silently break.
- Non-engine worker paths must pass through correctly.
- Extension asset routes must enforce web-accessible-resource rules.
- Validate destinations after DNS resolution to prevent SSRF/DNS-rebinding bypasses.
- Never turn the server into an unrestricted open proxy.
- Keep credentials, cookies and bearer tokens out of diagnostics.
- A normal WebSocket close is not a failure. `CloseEvent.wasClean` defaults to false, so the bootstrap must set it explicitly: server close frame received or client-initiated close is clean; a wisp stream dying without a close frame (1006/1002) or a failed handshake is not.

## Frame-buster neutralization (rewriter js::antiframe)
Proxied pages render inside the app's UI frame, so `top` is cross-origin from the page's perspective; classic frame-buster code (`if (top != self) top.location = location`) throws a SecurityError at the top level and kills the rest of the script. `crates/rewriter/src/js/antiframe.rs` (ported for
 parity with the server engine's pass, previously a documented gap) runs on every script body and inline event handler AFTER the URL-literal pass: framed-detection guards fold to their "not framed" values, `top.location` navigation writes sink into `self.zl_antiframe`, reads map to `self.location`. Method-call sinks (`replace`/`reload`/`assign`) are emitted optional-chained (`self.zl_antiframe?.replace?.(x)`) so they are silent no-ops with NO runtime definitions: the rewriter cannot inject definitions into every script context, and a bare call would throw ReferenceError. Plain assignments are safe without definitions (assigning an undeclared property creates it). Do NOT rename the sinks to reference the sibling browser project (naming rule); do not "fix" the optional chaining into direct calls.

## Diagnostics
Diagnostics are part of the engine contract. Current bounded storage is 512 diagnostic events and 256 trace entries, with a trace ID per request.
NativeTransit diagnostics must distinguish NativeTransit, RewriteFallback, fallback reason, upstream failure, runtime limitation, policy block, and extension/runtime interference. Never invent a cause.

## Extensions
Check `app/src/extensions/compat.ts` before documenting WebExtension support. Partial/unsupported APIs must remain honestly documented; do not fake browser APIs.

## CI
Do not weaken CI. Keep cargo fmt, clippy with warnings denied, cargo test, WASM checks, app builds, and extension tests green. The published dist bundle must be produced from a clean temporary checkout, and the AGPL libcurl transport package must not be committed to dist. The vendored transport loads through app/src/libcurl-transport-vendored.ts, which patches libcurl.js 0.7.4's CurlSession.stream_response at load time (issue #11: close-delimited empty-body responses were discarded as curl error 56 with the full header set already received); the transport-gate workflow runs the real failing redirect through a local wisp relay on every pus
h to main and fails if the seam regresses.

## Compatibility testing
Transport/rewrite/cookie/WebSocket/worker/extension changes require real behavior tests covering navigation, SPA history, fetch/XHR, WebSockets including clean close, redirects, modules, iframes, workers, storage, cookies, large responses, MIME-sensitive resources and authentication.

## Developer workflow
Read the relevant implementation and trace the request path first. Make the smallest coherent change, run applicable tests, inspect the diff, and update documentation. Fix abstractions instead of adding hostname-specific hacks.

## Public API
Reusable integrations must have stable boundaries, documented inputs/outputs, explicit errors, no LobsterBrowse dependencies, and tests proving the contract. The long-term goal is that developers can embed Zeolite without understanding the browser UI or rewriter internals.

## Status labels
Use **Implemented**, **Partial**, **Experimental**, or **Planned**. Never describe NativeTransit as implemented until code and tests prove it.

## Versioning
Current release: **2.4 Bromide** (`2.4.0`). See `docs/versioning.md` before changing version identifiers.

