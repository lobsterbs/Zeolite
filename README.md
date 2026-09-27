# Zeolite
![Zeolite banner](assets/zeolite-banner.svg)
**Current release: 1.6 Hydride** · Rust/WASM · Wisp v2.1
Zeolite is a standalone, reusable web interception/proxy engine providing a browser service-worker runtime, streaming rewriting, Wisp transport, diagnostics, and WebExtension compatibility.
## Current architecture
The 1.0 release is interception + rewriting. The rewriter is production code.
    Host application -> Zeolite -> service worker -> interception/runtime -> streaming rewriter -> Wisp v2.1 -> upstream
## NativeTransit direction
NativeTransit is the next architecture: transport/interception first, with the existing rewriter retained as RewriteFallback.
    Zeolite -> Transport API -> NativeTransit
             \-> RewriteFallback -> Wisp -> Network
> Keep the website native whenever the browser architecture allows it. Rewrite only when necessary.
NativeTransit is a design direction, not a claim that the current release has already replaced rewriting. If it proves stable across serious real-world compatibility tests, rewriting can eventually become optional for integrations that do not need it.
NativeTransit reuses existing transport, cookie/session and diagnostics infrastructure. It does not add Gecko-specific architecture.
## Current capabilities
Rust/WASM streaming rewriting; Wisp v2.1; service-worker interception; interception API + rules engine; bounded diagnostics; opt-in rewrite tracing; runtime WebSocket; virtual origins with per-origin cookie jars; per-origin storage virtualization (localStorage/sessionStorage/IndexedDB/Cache API, document.cookie); worker + service-worker virtualization; WebExtension compatibility; extension resource protection; standalone server; compatibility probes; SSRF/destination protection.
## Important limitations
Zeolite is not a full browser engine. Some WebExtension APIs, true isolated extension worlds, true service-worker script execution for proxied sites (registrations are virtual records) and advanced browser networking remain partial or planned; WebSocket targets without TLS fail (ws:// is upgraded to wss:// by design).
## Repository layout
- crates/rewriter — Rust/WASM rewriter
- crates/wisp-core — Wisp v2.1
- crates/wisp-extensions — server extensions
- crates/zeolite-server — standalone server
- app/src/sw.ts — service worker
- app/src/extensions — WebExtension runtime
- app/src/diag.ts — diagnostics
- app/src/tracing.ts — opt-in rewrite tracing
- app/src/wsbridge.ts — page WebSocket bridge
- app/src/cookies.ts — virtual origins + per-origin cookie jars
- app/src/swshim.ts — navigator.serviceWorker shim
- app/src/worker-prelude.ts — in-worker importScripts routing + WebSocket bridge
- suite — compatibility probes
- docs — architecture/versioning/roadmap
## Diagnostics
Current bounds: 512 diagnostic events, 256 trace references and 512 tracing decisions, with one trace ID per request. Secrets are redacted on entry.
## Development
cargo build -p zeolite-rewriter -p zeolite-wisp --target wasm32-unknown-unknown --release
cd app && npx vitest run && npm run build
cargo run -p zeolite-server -- --port 6002 --static ../app/dist
node suite/probe.mjs --base http://localhost:6002
## Roadmap
The roadmap covers interception APIs/rules, diagnostics, WebSockets, downloads/session export, fingerprinting consistency, compatibility recording/replay and final hardening.
See docs/versioning.md, docs/roadmap.md, docs/engine-adapter.md and docs/plugins.md.