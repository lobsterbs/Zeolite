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
shadowed inside the guest. Registration itself is truthful (#576):
script and scope arguments the JS rewriter minted into engine token
routes are decoded back through the bounded zl:decodeRoutes oracle,
the page register() promise settles only when the kernel confirms
the guest realm is running, and a rejection carries the kernel real
reason. One visible consequence stays: a page-realm caches read (a
site own CacheStorage probe) sees the engine real, empty per-origin
cache because guest caches live kernel-side, so such test pages
honestly report "empty" while the guest serves its warmed cache on
fetch. The real fix for the dispatch budget is a
longer consultation window with cancellation, and for persistence a
site-scoped store behind the same quotas; both stay unstarted. Full
detail: docs/virtual-service-worker-phase2.md, #538 wave and #576
sections.

## Opaque-sandbox frames bypass the engine interception

An iframe carrying a sandbox attribute without allow-same-origin (for
example sandbox="allow-scripts") gets an opaque origin, and Chromium
does not make opaque-origin frames service-worker clients (the same
client-binding class as the about:blank children a parent writes
with document.write; about:srcdoc children left this class only
on newer Chromium - the platform is split on crbug.com/41411856
(SW clients at 156, still bypassing at 131 where CI runs) and the
srcdoc-clients suite pins the measured class per build, see the
matrix row): their
route fetches bypass the engine entirely. The engine answers such
bypassed internal routes (/j/, /__zl_nav__/, /__zl_prel__/,
/__zl_navh__/) with a fixed bypass notice, a 404 carrying no-store and
a short marker body ("Zeolite engine route"), so the bypass is
observable and never leaks upstream content or a fake success; a
static miss outside those namespaces keeps the bare 404 (#533).
Residual: the sandboxed child runs its raw page scripts outside
engine control, a platform limit; the real fix would need a
client-binding-free interception host, the same one the about:blank
parent-written child class needs. The direct-vs-proxied suite pins the bypass notice and never
runs the opaque children proxied.

## Over-cap raw blocks pass verbatim, unrewritten

A raw script or style body larger than the 2 MiB RAW_PASS_CAP (#526)
stops retaining and passes through verbatim so the stream stays
bounded: the block is served complete and fail-open, never truncated
at the cap and never half-rewritten, and the decision is traced
(the rewriter raw over-cap verbatim counter). Consequence: construct-
level rewriting is skipped inside such a block - URL-shaped literals
in an over-cap inline script or style stay unrewritten (page-context
relative fetches still resolve through the virtual origin and the
service worker, but nothing rewrites the bytes). Blocked-element
swallowing is bounded separately by the 256 KiB DROP_RAW_CAP. The
streaming bound and the verbatim fallback are browser-gated by
suite/e2e/raw-caps.mjs (#526), which also carries the measured
TTFB/completion gate for an unterminated raw block.

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
directive sources is the only real fix and is deliberately not faked; an
opt-in deny-only subset can be restored (see the subsection below).

### CSP opt-in deny-only enforcement (#452, #527)

`app/src/csp-translation.ts` holds the parser, the conservative
candidate planner and the enforcement seam. Behind the cspTranslation
experimental flag (zl:config experimental, off by default) the request
pipeline serves an audited deny-only subset on proxied HTML documents
(`object-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
`worker-src 'none'`, `frame-src 'none'`, `child-src 'none'`) and marks
every decision visibly on the response: an enforced candidate sets
`x-zl-csp: enforced <directives>`, an unsupported policy stays stripped
and sets `x-zl-csp: unsupported <reason>`. The marker values are
engine-generated (whitelisted directive names or a reason enum), never
upstream source text.
The 2026-10-28 audit conclusions still govern the subset: worker/frame/child `none` is
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
**unsupported** reason: nothing is emitted or silently widened on
the browser side. Since the engine seam below enforces the
fetch-directive half of those lists, the x-zl-csp marker composes
the typed reason with the engine's decision segment.

Real-Chromium acceptance lives in suite/e2e/csp-enforce.mjs (#527):
with the flag on, the proxied document securitypolicyviolation set
(frame-src, worker-src, object-src, base-uri, form-action) is identical
to the direct browser oracle while the page own resources still load;
the served policy is byte-identical to the upstream one and carries no
origin, scheme or quoted source, so enforcement can never grant one
virtual site access to another through the shared engine origin; with
the flag off the old stripped behavior holds, unmarked. The honest
divergences are pinned, not hidden: the fetch-seam gate governs
requests only, so a proxied page still runs its INLINE script under a
`script-src 'self'` policy where the direct oracle blocks it (the
nonce/strict-dynamic fixture pins the same false allow on the fetch
side while its img-src half stays enforced), report-only policies are
never enforced, and meta policies are dropped by the rewriter so the
effective policy is exactly the header-path decision (the direct
oracle honors a meta policy the engine cannot represent).

### CSP engine-side source-list enforcement (#527)

`app/src/csp-enforce.ts` closes the origin/path/'self'/default-src
half of the browser-side gap at the ENGINE boundary, the same seam
#531 uses for SRI: the fetch handler knows the decoded upstream URL
of every route and the document's virtual origin, so source lists
are matched against exactly the truth a direct browser matches.
Behind the same cspTranslation flag the served document installs a
per-client plan (memory-only; a navigation clears it first, so no
document ever inherits a stale policy) and every non-navigate,
non-worker subresource fetch is gated before cache and transport:
script-src, style-src, img-src, font-src, media-src and connect-src
source lists, with default-src as the fallback. 'self' is the
document's VIRTUAL origin, never the engine origin, so enforcement
cannot grant one virtual site access to another; a blocked load
answers a network error - the same shape a direct CSP violation
produces - recorded as a BLOCKED_CSP transit decision and a
`blocked:csp` netLog verdict. Decisions stay visible: x-zl-csp
composes the browser-side reason with an `engine <directives>` /
`engine-unsupported <directives>` segment of whitelisted directive
names, never upstream source text.

Degrades are false allows, never false blocks: a directive whose
list carries nonce/hash/strict-dynamic tokens stays unenforced (an
element nonce cannot be verified at the fetch seam) and is reported
in the engine-unsupported marker segment. Honest residuals: the
inline/eval classes are not requests through this seam; worker,
frame, object and manifest classes stay ungated (the browser-enforced
deny-only subset governs them where it applies); report-only stays
unenforced; a page-cache document serve installs no plan (the stored
view is hostile-header stripped), so a cache-hit document runs
unenforced; and recovery-candidate loads are ungated.

The csp-enforce suite (#527) pins parity directly against a second
fixture origin: a script-src/img-src/connect-src 'self' page blocks
the same cross-origin script, image and fetch classes as the direct
oracle with ZERO upstream hits (the gate decides before transport)
while same-origin subresources still load; a default-src 'self'
page blocks all three classes through the fallback with the marker
naming it; a nonce/strict-dynamic policy degrades to a visible
false allow (the cross-origin script runs proxied where the direct
oracle blocks it, and its upstream hit is asserted) while its
img-src half stays enforced; with the flag off the old stripped,
unmarked behavior holds. The composed marker strings are asserted
byte-exact.

Still open for #527, honestly: nonce/hash/strict-dynamic, report-only
and violation reporting have no engine-safe translation, and the
browser-served policy stays deny-only; a shared engine origin is not
equivalent to a virtual site's `'self'`, so no source list is ever
served to the browser. The opt-in stays off by default.

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
The real-Chromium suite now compares native direct behavior with proxied
same-site reuse and cross-site separation, and covers multi-tab connections,
classic/module and credentials separation, worker-scoped IndexedDB and cookie
inheritance, one-client port closure, and reconnect persistence. Chromium owns
the exact termination time of an unreferenced SharedWorker, so the suite does
not claim to force a particular shutdown event; an explicit engine teardown,
service-worker restart, and hostile same-engine-page token guessing remain
outside this verification. The virtual sites remain browser-same-origin.

## window.location is not virtualized

`window.location` is LegacyUnforgeable: pathname, search, origin and
friends cannot be intercepted by a page shim, and the page sees the
engine route. #144 splits the identity on nav-handle routes: the real
path and query ride after the opaque token
(`/__zl_navh__/<token>/<real path>?<real query>`), so SPAs that route on
`location.pathname` and pages that build URLs relative to their location
work without any location virtualization. The destination HOST stays
opaque - only the token can name it. Routers that string-match the exact
bare token still cannot work client-side. The forgeable document
surfaces ARE virtualized (#238, #532): `document.URL` and
`documentURI` reads rename to the virtual location view
(`__zl.href`) and `document.baseURI` reads to `__zl.baseURI`
(#532), alongside the rewriter AST pass over free `location`
reads. The virtual base keeps the same identity model: the real
base path is visible (the #144 relaxation) and the destination
host stays opaque - the worker delivers the folded first
`<base href>` target as a hostless `zl:vbase` control message,
never as injected source bytes. initScript output is CI-tested
to never contain the destination host.

## document.baseURI residuals (#532)

The virtual base view is honest about its edges. `HTMLBaseElement`
`href` reads and writes stay fully native: the served attribute is
the opaque engine route (a page read sees the route, a page write
resolves natively). The `zl:vbase` delivery is a best-effort
control message posted while the document streams: a script that
reads `document.baseURI` before the message lands reads the opaque
route path (never the destination host), and the message closes
the race as soon as it arrives. The delivered base applies only
while the first base element keeps the served attribute bytes; a
later page rewrite of the href is page truth immediately (live DOM
read), and a base element inserted before the served one wins per
the HTML first-base-in-tree-order rule. Nested engine-rewritten
`about:srcdoc` documents read their own faithful `about:srcdoc`
view (a direct srcdoc document reads the same); the rewriter
renames their reads identically. About:blank frames never carry
engine-rewritten bytes and stay untouched. Bare `top`/`parent`
`location` reads stay native for frame-buster identity (the #235
rule), so a page comparing `document.baseURI` against a native
top-document read still sees the engine route on the native side
of the comparison.

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
## Subresource integrity is engine-verified, not browser-native

The rewriter drops integrity attributes (rewritten bodies can never
match an upstream hash, #531); the engine verifies fresh script and
stylesheet bytes itself.

- Unsupported hash algorithms (anything but sha256/384/512) fall
  back to the compatibility serve with the
  skipped:unsupported-algorithm marker. This is parity: Chromium
  ignores integrity metadata with no supported algorithm and loads
  the resource too.
- The per-client expectation registry is memory-only. A service
  worker restart forgets all expectations; the next document serve
  repopulates them, and subresources fetched before that document
  finishes re-serving verify against nothing.
- Cached script entries hold transformed copies, so a cache-hit
  script with a live expectation records
  skipped:cache-transformed-body instead of blocking: a hash
  mismatch there cannot distinguish tampered storage from a
  legitimately rewritten body, and fresh-path verification already
  gated the raw upstream bytes.
- Raw bodies over the 4 MiB verification cap skip with
  skipped:body-too-large.
- Only script src and link rel=stylesheet href integrity metadata
  is scanned; integrity passed to fetch() is ignored.

## Import maps are recorded, not fully implemented

Import map awareness (#554) has two seams with honest limits:

- The wasm rewriter rewrites import map bodies: mapped values and
  URL-like keys ride engine routes, bare and scope keys stay
  verbatim, and a malformed or oversized (over 256 KiB) map
  passes through unrewritten. Scope keys are rewritten only in
  the split route form (origin token + verbatim path); a scope
  key with a query or fragment is left alone.
- A module worker created by the page resolves bare specifiers
  through the owning page's recorded imports map at the serve
  seam. Only the top-level imports member is honored: scope
  resolution needs the URL of the importing module, which the
  serve seam does not know, so scoped bare specifiers stay bare
  and fail natively, exactly as before #554.
- The per-page map registry is memory-only per service worker
  lifetime: a worker restart forgets the maps, and later
  workers fall back to the native bare-specifier failure until
  the page is served again.
- Array fallback targets return the first parseable http(s)
  entry: resolution is by URL parse, not a probe, so a dead
  first fallback is returned before a live second one, matching
  what a fetch-time fallback would discover only after a
  failed load.
- Bare specifier resolution in page scripts (not workers) is
  native: the browser resolves them against the REWRITTEN map
  the rewriter served inline.
