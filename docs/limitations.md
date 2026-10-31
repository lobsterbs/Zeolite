# Known limitations

Honest gaps, written down rather than papered over (README norm). Each
entry states what does not work, why, and where the real fix would land.

## Guest service workers are cache-hit-speed, session-scoped guests

A proxied site's service worker script now executes (#538), but in a
guest realm (a page-created DedicatedWorker behind a harness prelude),
not as a real service worker, and the emulation keeps honest bounds:
the engine consults a running guest for at most 250 ms per request, so
only cache-hit-speed answers are served (a guest answer that needs a
network fetch falls back to the engine path); guest caches are
kernel-side and session-scoped, so nothing survives an engine
restart; clients.matchAll() resolves [] (no client enumeration) and
guest postMessage reaches the kernel listener only; no controller,
controllerchange, push, BackgroundSync or messaging surface into
virtual pages exists; XHR, WebSocket, importScripts and indexedDB stay
shadowed inside the guest. The real fix for the dispatch budget is a
longer consultation window with cancellation, and for persistence a
site-scoped store behind the same quotas; both stay unstarted. Full
detail: docs/virtual-service-worker-phase2.md, #538 wave section.

## Content Security Policy is stripped for proxied pages

Both the `Content-Security-Policy` and
`Content-Security-Policy-Report-Only` response headers are dropped
(headers.ts HOSTILE list), and `<meta http-equiv="Content-Security-Policy">`
and `Content-Security-Policy-Report-Only` meta tags are stripped by the
streaming rewriter. Rewritten URLs are engine-origin routes that the
upstream CSP never names, so honoring the policy would block the page's
own scripts and subresources. Consequence: a proxied page runs without
its CSP protection; the engine's origin isolation and hostile-header
stripping are the remaining guardrails. A CSP pass that rewrites
directive sources is the only real fix and is deliberately not faked.

### CSP opt-in prototype (#452)

`app/src/csp-translation.ts` contains a **pure, not-yet-enforcing** parser
and conservative candidate planner. It accepts only a small deny-only subset
(`object-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
`worker-src 'none'`, `frame-src 'none'`, `child-src 'none'`).
The 2026-10-28 audit conclusions: worker/frame/child `none` is
representable (the engine page runtime creates no workers and injects
no frames into proxied documents, and a site declaring them `none`
had none upstream either); `frame-ancestors` stays rejected (the
engine legitimately embeds proxied pages in its own UI frame, so a
faithful `none` breaks the product while `self` broadens the
embedding grant across the shared engine origin); `connect-src` stays
rejected (the page runtime legitimately fetches minted engine routes
from page context); nonce retention is rejected (engine-injected
scripts are minted at the wasm rewriter seam and cannot carry the
upstream nonce attribute) and hashes are rejected (the rewriter
mutates inline script bodies, so upstream hashes fail);
`strict-dynamic` depends on nonce propagation; `sandbox` is rejected
(an opaque origin breaks the proxied page own storage semantics).
Origin/path source lists, `'self'`, fallback directives, report-only
policies, reports and malformed policies return a typed
**unsupported** reason: nothing is emitted or silently widened. The current request pipeline still
strips CSP and CSP meta as before; no new header or browser enforcement has
been enabled. This is strictly a preparation stage, **not a CSP security
restoration**.

To enable it safely, #452 still needs origin-scoped engine route matching,
an injection nonce/hash design, preservation of full policy semantics and
real Chromium fixtures for allow/block, frames, workers, inline scripts,
report-only and embedding isolation. A shared engine origin is not
equivalent to a virtual site's `'self'`; mapping one to the other would
weaken isolation.

## Redirect hops with a body over the replay cap

The hop chain buffers a request stream body once and replays it on
every redirect kind, so 307/308 POSTs follow like a real browser; a
cross-origin hop drops Authorization per the fetch spec. Two measured
realities shape the over-cap behavior:

- Chromium never exposes Content-Length on service-worker-intercepted
  requests, so a page upload always reaches the engine as an unannounced
  stream. Without the host-authorized replay spool (#556, zl:config
  spoolUploads), a body that overflows the replay cap (32 MiB default,
  zl:config replayCapMb, range 1 to 32) fails with the honest 502 naming
  the cap: never a truncated body, never a surfaced redirect.
- The vendored transport artifact full-buffers every request body into
  its wasm heap before the socket sees it. Measured through the engine:
  8 MiB uploads ride, 16 MiB uploads kill the renderer process
  deterministically. The ceiling is independent of the spool.

When the embedder authorizes the spool, an over-cap body is written
once to Origin Private File System storage (per-request cap 256 MiB,
live budget 512 MiB across concurrent spools). The spooled file is the
replay source; the engine materializes one ArrayBuffer copy per
redirect chain, bounded by the measured 8 MiB transport ceiling, so
the copy fails honestly instead of crashing the renderer when a
spooled body exceeds it. Redirects on spooled bodies follow with
byte-identical replay (pinned by suite/e2e/replay-spool.mjs).
Upload bytes reach persistent storage only on that explicit opt-in;
storage that fails before the first byte keeps the documented honest
failure, and a failure after the first byte fails the request honestly
instead of serving a truncated body. Bodies above the transport
ceiling remain impossible until the artifact streams uploads from a
read callback, which is the remaining #556 work.

## SharedWorker identity is scoped, not a separate origin

The constructor wrapper folds the virtual-site token, classic/module script
type and credentials mode into the native worker name. This prevents
accidental classic/module and cross-site instance sharing while preserving
the same scoped identity for repeated same-site, same-type constructions.
Chromium sharing, teardown and hostile same-engine-page isolation still need
end-to-end verification for #453. The virtual sites remain browser-same-origin.

## window.location is not virtualized

`window.location` is LegacyUnforgeable: pathname, search, origin and
friends cannot be intercepted by a page shim, and the page sees the
engine route. #144 splits the identity on nav-handle routes: the real
path and query ride after the opaque token
(`/__zl_navh__/<token>/<real path>?<real query>`), so SPAs that route on
`location.pathname` and pages that build URLs relative to their location
work without any location virtualization. The destination HOST stays
opaque - only the token can name it. Routers that string-match the exact
bare token still cannot work client-side; virtualizing the forgeable
surfaces (`document.URL`, `documentURI`, `baseURI`) plus a rewriter AST
pass over free `location` reads stays the tracked direction for those.
initScript output is CI-tested to never contain the destination host.

## Referer on undecodable routes

When the request's referrer path is not a decodable engine route, the
Referer header is omitted rather than sent (sending the raw engine
route would leak the proxy origin). A TRANSPORT warning DIAG event
records the omission; referrer-dependent CSRF and analytics may
misbehave on such requests.

## Page cache eviction fails closed

The per-worker page cache is capped (ZL_PAGE_LIMIT entries) as a hard
bound (#548): room is made before a new entry is admitted, so a
failed eviction delete (storage pressure) refuses that store instead
of admitting an entry that could never be trimmed, and one failure
disables storing for the rest of the worker lifetime - the entry
count stays at the stuck value and the next worker start retries with
a clean slate. A once-per-worker DIAG warning records the condition.
Cache stores that fail (storage full) skip caching for that response,
also with a once-per-worker warning. Vary responses are cached with
their variant metadata (the field list plus the selecting request's
header values) and only serve requests with matching values (#557);
Vary: * stays uncacheable.

## TLS and HTTP/2 fingerprints are client-stack

TLS terminates in the browser (libcurl/mbedTLS or epoxy/rustls), so
the wire fingerprint is that of the vendored stack, not a real browser
stack. Per-site FingerprintProfile data (siteconfig) aligns the
document surface (UA, languages, headers) with the wire surface where
possible, but JA3/H2 coherence is bounded by the transport stack.

## Compat-probe single-row connect timeouts

The real-site compat probe (suite/probe.mjs) can fail a single row
with close reason 0x43 (ConnectTimedOut) when the runner its server
runs on cannot reach one host: the outbound TCP connect from the
server to that destination times out while every other probe site,
including other properties of the same provider, passes through the
same wisp session. The classifier labels such a row client-defect
(the direct baseline was not a 3xx/403/429/451 gate), but it is an
egress condition of the runner network, not an engine defect - the
honest check is a local rerun with the same binary. Observed:
google-consent on CI run 38219174704 failed with 0x43 while
google-home and google-search passed through the engine on the same
session; three local probe runs with the same build passed
google-consent 3/3 (the next CI run confirmed green).

## Replay buffering is conditional, not universal

Bodies that reach the transport as a ReadableStream are buffered
once (cap 32 MiB) only when a replay path can actually fire for
that request: a relay rule with a registered relay channel, or a
Content-Length-announced body the single connect-class retry can
replay. Unannounced stream bodies without a relay route (chunked
uploads, request/response duplexing) stream one-shot: the retry is
honestly unavailable for them and a mid-request failure cannot be
replayed. A Content-Length-announced body over the cap would stream one-shot,
but Chromium never announces Content-Length to the service worker, so
the real page traffic class is the unannounced one: it fails honestly
at the cap unless the host authorized the OPFS replay spool (#556),
which captures it to disk past the memory cap and materializes one
bounded transport copy per redirect chain.
Every cap trip is counted (replayCapTrips in app/src/request.ts) and
logged, and every script-body mask (the #158/#159 honesty layer) is
counted and logged with the requested path, referrer and resolved
route.
