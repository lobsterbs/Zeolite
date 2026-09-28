# Support and limitation matrix (2.3 Selenide)

Every row states what actually ships, verified against the code and
the test suite, not what would be nice to have. Statuses:

- supported: implemented, wired through the service worker or server,
  covered by tests.
- partial: implemented with documented, real limitations.
- not supported: absent by design, not faked.

| Feature | Status | Notes and limits |
| --- | --- | --- |
| Streaming HTML rewriting | supported | Chunked through a TransformStream; no full-body buffering. Links, iframes, scripts rewritten to engine paths. |
| Streaming CSS rewriting | supported | url() references rewritten; same streaming path. |
| JS rewriting | partial | Rust/WASM JsRewriter exists and runs, but token-level rewriter decisions are not surfaced to tracing (documented tracing limit). |
| Opaque URL passthrough | supported | blob:/data: hrefs are never rewritten; isOpaqueUrl guards the fetch path. |
| Nested-route unwrap at decode | supported | A decoded destination that is itself an engine route (any host binding, stale double-wrap from old dists) is peeled to the innermost destination (bounded 8 layers) before transport. |
| Escaped same-origin fetch reroute | partial | Same-origin non-asset requests from a rewritten page are rerouted against the origin recovered from the request referrer (issue #1 finding 3). No decodable referrer = passthrough; request bodies of escaped fetches are rerouted, so genuinely engine-local paths a page invents cannot be recovered. |
| Wisp v2.1 transport | supported | All proxied traffic rides the same wisp hop; TLS terminates client-side in the vendored libcurl transport. |
| Runtime WebSocket bridge | supported | Page WebSocket goes through the SW bridge to the transport; lifecycle + direction traced, payloads never recorded. |
| ws:// WebSocket targets | not supported | Upgraded to wss:// by design before the transport sees the URL (traced). Plaintext WS never attempted. |
| Virtual origins + per-origin cookie jars | partial | RFC 6265 parsing (Domain/Path/Secure/HttpOnly/SameSite), jar is the sole Cookie source for engine requests. SameSite enforced only through the opt-in zl:sameSite knob (approximate site context from the request referrer). Set-Cookie on redirect hops is captured: the SW follows the hop chain itself (the transport surfaces 3xx) and captures every hop; a hop it cannot follow (307/308 with a stream body, 10-hop cap) is surfaced with its Location mapped to an engine route (issue #1 finding 1). |
| document.cookie virtualization | partial | Per-origin, synced to the SW via a transferred port. Eventual consistency only: a cookie deleted directly by local JS is not detected (no local deletion signal). |
| localStorage/sessionStorage scoping | supported | Scoped per virtual origin (same FNV1a36 id as cookie jars). |
| IndexedDB virtualization | supported | Open/deleteDatabase names prefixed per virtual origin; IDBFactory.cmp compares prefixed names (consistent ordering in-scope, absent when the host lacks it). databases() is absent by design (honest gap, see docs/storage.md). |
| Cache API virtualization | supported | open/delete/has/keys/match scoped to the virtual origin; own-entries only. |
| Worker virtualization | supported | Dedicated/shared workers get a prelude: importScripts routed through the engine, worker WebSocket bridged over postMessage; shared workers relay over their newest connect port through the same page-side relay (2.3). Module workers get import/export-from and import() specifiers rewritten in the body at serve time (absolute and relative http(s) become engine routes; bare specifiers pass through - no resolver, same limit as pages; a text pass, so a specifier-shaped string literal is rewritten too). |
| Engine-route CORS surgery | supported | Target Access-Control-* response headers are never valid on an engine route: they are dropped and replaced with the engine's own CORS facts on every proxied response and on the page cache before storing. Uncredentialed responses get `*`, credentialed ones get the engine origin plus allow-credentials. Cross-origin consumers fail closed; an arbitrary request origin is never reflected, because the bodies are jar-authenticated (issue #2). |
| Engine error page | supported | Failed navigations answer with the engine-owned minimal error page: the target URL, one honest category line (dns/tls/timeout/blocked/stream; unknown failures are stream, a cause is never invented), a retry action, and a machine-readable zl-error meta payload. Subresource failures keep the honest 502 text/plain body. The no-control case cannot be answered by the engine and stays a documented embedder snippet (docs/error-pages.md) (issue #3). |
| Service-worker registration for proxied sites | not supported | Registrations are virtual records (swshim); no true SW script execution for proxied origins. |
| Download registry | supported | Counting passthrough with filename detection (content-disposition/URL) and cancellation. Ring persists to site-scoped IndexedDB across SW restarts (2.2); active entries at restart are honestly marked interrupted. No resume. |
| Session export/import | supported | AES-256-GCM + PBKDF2-SHA256 (120k iterations, hand-rolled base64). No plaintext secrets ever at rest. Import supports replace (default) and merge with per-cookie conflict rules (2.2). |
| Fingerprinting resistance | partial | One consistent profile across navigator/screen/Date/Intl/canvas/WebGL, mirrored onto upstream headers, compiled into both document and worker init scripts (2.3): WorkerNavigator surfaces, timezone/Intl, WebGL UNMASKED_* and OffscreenCanvas perturbation with the same seed, so worker-computed canvas fingerprints match the document's. Limits: fixed-offset timezone, no DST simulation, Date toString zone text stays native, default profile is a shared fixed fingerprint, not per-session randomness. |
| Session recording + replay | supported | zlRecord artifacts; deterministic given identical rings; replay compares reachability, status class, unrewritten-URL absence, plus the recorded WebSocket lifecycle and cookie-jar-shape facts against the artifact contract (direction/kind/URL shape; names and scopes, never values). Bodies, headers, timings and WebSocket payloads are never recorded, so never compared. |
| Opt-in rewrite tracing | supported | 512-decision ring, zero allocation while off. Token-level wasm decisions untraced. |
| Network inspector | supported | 256-entry ring with delta polling. fetch() and XHR are not distinguishable without initiator info; both reported as FETCH. |
| Diagnostics | supported | 512 events, 256 trace references, one trace ID per request, secrets redacted on entry. |
| SSRF/destination protection | supported | One policy: local names blocked pre-DNS, every resolved IP re-checked pre-connect (rebinding-safe); loopback/private/link-local/metadata/unspecified/broadcast and IPv6 ULA/link-local blocked. Test-only ZL_TEST_ALLOW_PRIVATE_DESTS=1 escape hatch must never be set in production. |
| WebExtension compatibility | partial | Real runtime for content scripts, storage, tabs, messaging, alarms, permissions, webNavigation, webRequest, management. Some APIs, true isolated worlds and true extension service workers remain partial (see README limitations). |
| SPA routing | supported | Client-runtime; covered by app unit tests, honestly not probeable by the HTTP compat suite (marked client-runtime in the scoreboard). |

Bounded by design: 256 network-log entries, 512 tracing decisions, 512
diagnostic events, 512KB interception body cap (BODY_LIMIT in
intercept.ts).

