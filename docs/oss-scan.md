# OSS component scan (#142)

Per-component verdicts. Rule: no license contamination of the engine
core; the libcurl transport (AGPL) stays vendored at deploy time only
and is never committed.

## webextension-polyfill (MPL-2.0) - adopted at the API-shape level

NOT vendored, deliberately. Verified against the polyfill's own
source (0.12.0): it requires a load-time globalThis.chrome with
runtime.id, and skips its callback wrapping entirely when
globalThis.browser with runtime.id exists. The extension runtime
exposes exactly that: background boots set the globals during the
synchronous script execution (#139), popup/options pages set
window.browser natively, so the polyfill binds to the native
promise surface and its chrome-callback machinery never runs
(which is what would hang: this runtime's chrome.* is promise
based and would never invoke the polyfill's callbacks). Content
scripts are the honest gap: they run in the page's JS world, so a
global browser would hand the page the extension's API object
(a property-setter trap captures it); recorded as unsupported in
compat.ts with that reason. Vendoring the polyfill itself would add
no capability beyond this.

## adblock-rust (Brave, MPL-2.0) - not adopted

The blocker use cases today are host-list filtering (the embedder's
own adblock crate) plus the engine's rules host lists. adblock-rust's
value is full filter syntax (network rules, cosmetic filters,
procedural snippets); that is a wasm build plus a rule pipeline for
capability the host lists do not need yet. Cosmetic filtering in
particular is element hiding at rewrite time, a different pipeline,
not a bigger matcher. Revisit when a shipped rules format requires
network-rule syntax beyond hosts.

## rustls-based wasm TLS - deferred behind the relay

A third transport with a standard ClientHello would attack the
TLS-fingerprint class engine-side (#141's JA3/H2 item). #137 ships
the embedder relay for the blocked-host class first: the embedder's
native TLS stack answers the same need with zero new wasm surface.
A rustls transport remains the long-term engine-owned answer, needs
the same integration surface libcurl/epoxy use, and would carry its
own (different) non-browser ClientHello until tuned; tracked with
the fingerprint transport binding (engines field, #71).

## whatwg-url compliance - no action on evidence

Client-side routing and the SW use the platform URL API, which IS
the WHATWG parser. The Rust streaming rewriter hand-rolls RFC 3986
scheme/attribute scanning for throughput (byte streaming, no
per-attribute allocation); the known divergence classes (backslash
treatment, tab/newline stripping, IDNA) have produced no failures in
the suite or live probes. Adopting the url crate per attribute would
cost the streaming hot path; deferred until a real failure names a
URL edge case the RFC 3986 scan mishandles.

## Server-side rewriter techniques - parity pass done

The embedder's server-side js_antiframe pass was ported
line-for-line into crates/rewriter (guard-folding table,
top.location scan) and wired into both script bodies and inline
handlers, with unit tests in the same file. Remaining divergences
are documented rewriter gaps (inline module scripts), recorded in
the compatibility matrix rather than papered over.