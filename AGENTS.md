# AGENTS.md â Zeolite

Guidance for AI agents and human contributors. Read this before changing code, architecture, CI, or public documentation.

## Project identity
Zeolite is a standalone, reusable Rust/WASM web interception and proxy engine. It provides a browser-side service-worker runtime, Wisp v2.1 transport, streaming rewriting, diagnostics, and a WebExtension compatibility layer.
Keep Zeolite independent from LobsterBrowse UI code. Do not document planned behavior as implemented.

## Current architecture
The 1.0 Nitride release is interception + rewriting. The rewriter is production code and must not be removed prematurely.

Long-term architecture: **NativeTransit**. NativeTransit makes transport/interception the preferred path and keeps the existing rewriter as **RewriteFallback**.

    Host app -> Zeolite -> Transport -> NativeTransit
                                  \-> RewriteFallback
                                      -> Wisp -> Network

NativeTransit should preserve original website URLs/content where browser security permits, reuse existing transport/cookie/diagnostic infrastructure, and record every fallback decision and reason. Never create a second network stack or cookie store.

NativeTransit does not bypass browser security boundaries such as same-origin policy, service-worker scope, CSP, CORS, iframe rules, or browser-owned APIs.

Status: the transport-mode decision layer is **Implemented (Alpha)** in `app/src/transit.ts`. Non-document resources are classified NativeTransit and transported without rewriting; document and stylesheet loads are deterministic RewriteFallback (reasons DOCUMENT_REWRITE_REQUIRED / CSS_URL_REWRITE_REQUIRED / UNSUPPORTED_PROTOCOL) recorded in diagnostics via TRANSPORT_FALLBACK events, with counters in the zl:getNetLog reply. Redirect final destinations are recorded when the transport exposes them (REDIRECTED).

Extension pipeline status: webRequest is wired into the engine fetch path (onBeforeRequest cancellation honored with webRequestBlocking, onBeforeSendHeaders/onHeadersReceived header modification via validated pairs, onCompleted/onErrorOccurred observation; delivery gated by host permissions and listener url filters), webNavigation now exposes beforeNavigate/committed/completed from the real interception lifecycle (cache-hit navigations included), MV3 service-worker backgrounds execute on demand via wakeExtension with a 30s idle termination, and tabs.sendMessage delivers background-to-content-script messages through the zl:tabMessage channel with destination verification and honest no-listener errors.

**Do not implement Gecko-specific architecture, dependencies, WASM, or adapters as part of NativeTransit.**

## Repository layout
- `crates/rewriter/` â streaming Rust/WASM rewriter.
- `crates/wisp-core/` â Wisp v2.1 protocol.
- `crates/wisp-extensions/` â auth/lifecycle/server extensions.
- `crates/zeolite-server/` â standalone Wisp/static server and destination protection.
- `crates/wisp-wasm/` â WASM Wisp bindings.
- `app/src/sw.ts` â service-worker/interception entrypoint.
- `app/src/extensions/` â WebExtension compatibility runtime.
- `app/src/diag.ts` â bounded diagnostics.
- `app/src/transit.ts` â NativeTransit transport-mode decision layer + fallback record.
- `suite/` â compatibility probes.
- `docs/` â architecture, roadmap, versioning and adapter docs.

## Hard invariants
- Rewriting stays streaming; never buffer whole documents for convenience.
- Attribute parsing must not consume bytes beyond closing quotes.
- Preserve whitespace/delimiters where possible.
- Use RFC-aware scheme detection.
- Non-engine worker paths must pass through correctly.
- Extension asset routes must enforce web-accessible-resource rules.
- Validate destinations after DNS resolution to prevent SSRF/DNS-rebinding bypasses.
- Never turn the server into an unrestricted open proxy.
- Keep credentials, cookies and bearer tokens out of diagnostics.

## Diagnostics
Diagnostics are part of the engine contract. Current bounded storage is 512 diagnostic events and 256 trace entries, with a trace ID per request.
NativeTransit diagnostics must distinguish NativeTransit, RewriteFallback, fallback reason, upstream failure, runtime limitation, policy block, and extension/runtime interference. Never invent a cause.

## Extensions
Check `app/src/extensions/compat.ts` before documenting WebExtension support. Partial/unsupported APIs must remain honestly documented; do not fake browser APIs.

## CI
Do not weaken CI. Keep cargo fmt, clippy with warnings denied, cargo test, WASM checks, app builds, and extension tests green. The published dist bundle must be produced from a clean temporary checkout, and the AGPL libcurl transport package must not be committed to dist.

## Compatibility testing
Transport/rewrite/cookie/WebSocket/worker/extension changes require real behavior tests covering navigation, SPA history, fetch/XHR, WebSockets including clean close, redirects, modules, iframes, workers, storage, cookies, large responses, MIME-sensitive resources and authentication.

## Developer workflow
Read the relevant implementation and trace the request path first. Make the smallest coherent change, run applicable tests, inspect the diff, and update documentation. Fix abstractions instead of adding hostname-specific hacks.

## Public API
Reusable integrations must have stable boundaries, documented inputs/outputs, explicit errors, no LobsterBrowse dependencies, and tests proving the contract. The long-term goal is that developers can embed Zeolite without understanding the browser UI or rewriter internals.

## Status labels
Use **Implemented**, **Partial**, **Experimental**, or **Planned**. Never describe NativeTransit as implemented until code and tests prove it.

## Versioning
Current release: **1.0 Nitride** (`1.0.0`). See `docs/versioning.md` before changing version identifiers.
