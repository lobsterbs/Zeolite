# Security audit (3.0 Diamond re-audit)

Scope: the 2.0 Graphene audit re-run at 3.0 against the surface added
since, plus corrections of findings the 2.0 text listed as open but
2.x has since closed. Findings reference real code seams; nothing is
claimed beyond what the code does.

## Destination policy (SSRF) - one enforcement point

crates/zeolite-server/src/policy.rs is the single place that answers
"may we reach this destination":

- Hostnames are checked before DNS resolution: localhost, .local,
  .internal, .home.arpa and cloud metadata names are blocked.
- Every RESOLVED address is checked again before connect, so a DNS
  rebinding answer that points into private space is rejected after
  a benign first answer.
- Blocked ranges: IPv4 loopback, RFC1918 private, link-local
  (including 169.254.169.254), unspecified, broadcast; IPv6 loopback,
  unique-local fc00::/7, link-local fe80::/10.

Test escape hatch: `ZL_TEST_ALLOW_PRIVATE_DESTS=1` disables the
private-IP block so the nightly fixture origin (127.0.0.1) can be
proxied. It is read only in the policy Default impl, exists solely
for the compat suite, and must never be set in a production process.
Local-name blocking stays on even with the hatch open.

Re-audited at 3.0: unchanged, still the only gate. The engine has
exactly one dial path (the policy-gated wisp hop); nothing added
since 2.0 dials a destination outside it.

## Header surgery

Two header paths, both deliberate and both in app/src/sw.ts:

- Upstream responses pass stripHostile(), which removes CSP,
  CSP-report-only, X-Frame-Options, HSTS, COOP/COEP/CORP,
  Permissions-Policy, Set-Cookie and Set-Cookie2. This is the core
  tradeoff of an interception engine: the proxied page must run inside
  the embedding application, so the origin's confinement headers
  cannot survive. Consequences, stated honestly:
  - The proxied page's CSP/XFO protections are gone; isolation of the
    proxied page from the host app is the HOST's responsibility (its
    own CSP, iframe sandboxing).
  - Set-Cookie is captured into the per-origin jar before being
    stripped, so the page never sees raw Set-Cookie headers; cookies
    only flow through jar-controlled Cookie headers.
- Engine-initiated requests pass forwardedHeaders(): host, connection,
  referer, origin and cookie from the page are dropped; Referer is
  rebuilt from the real destination; the jar supplies Cookie; a
  fingerprint profile (when active) overrides User-Agent and
  Accept-Language. Header injection through the Headers API is
  structurally prevented by header-name normalization; the hostile
  list is compared lowercase.

Re-audited at 3.0: the engine-route CORS surgery (2.3, app/src/cors.ts)
never reflects a request origin: engine routes state the engine's
own CORS facts, credentialed responses get the engine origin, and
arbitrary cross-origin consumers fail closed. The engine error page
(2.3) is generated from the engine's own fixed markup, never from
upstream bytes.

## Cookie and storage isolation

- Per-origin jars keyed by the FNV1a36 virtual-origin id; the jar is
  the sole authoritative Cookie source for engine requests. Dotless
  TLD Domain attributes are refused; Max-Age/Expires deletion
  implemented.
- localStorage/sessionStorage/IndexedDB/Cache API are scoped with the
  same id; Cache match only sees the origin's own entries.
- 2.0 audit correction (closed in 2.2): Set-Cookie on intermediate
  redirect hops IS captured. The SW follows the hop chain itself (the
  transport surfaces 3xx) and applySetCookie runs against every hop;
  a hop the SW cannot follow (307/308 with a stream body, the 10-hop
  cap) still surfaces with its Location mapped to an engine route,
  and its own Set-Cookie was captured first.
- 2.0 audit correction (closed in 2.2): SameSite is enforced through
  the opt-in zl:sameSite knob ("off" | "approx"), using approximate
  site context recovered from the request referrer. It stays off by
  default, honestly, because the SW seam has no true site context.
- Merge-mode session import (2.2) takes per-cookie conflict rules and
  writes only through the same jar path; it introduces no new
  cookie source.

## Secrets handling

- redactSecrets() runs at the boundary of diagnostics, tracing and
  recording: nothing that stores or transmits log/record data keeps
  credential-shaped values.
- Recording artifacts (zlRecord) never contain cookie values,
  WebSocket payloads, request/response bodies or headers.
- Session export carries secrets only inside AES-256-GCM ciphertext
  (PBKDF2-SHA256, 120k iterations); the passphrase never leaves the
  control message.

## WebSocket

- ws:// targets are upgraded to wss:// before the transport sees
  them; plaintext WS is never dialed (traced as subsystem websocket,
  rule upgrade).
- The bridge registry holds only live connections; zl:teardown closes
  all of them.
- Re-audited at 3.0: the SharedWorker bridge (2.3) rides the same
  relay rule (the engine is the relay parent, a page never becomes
  one) and the same ws->wss upgrade.

## Runtime navigation escapes (issue #28)

The bootstrap navigation guard (app/src/bootstrap/navguard.ts)
rewrites absolute cross-origin URL assignments before the browser can
act on them directly: window.open, the href/src/action properties and
setAttribute on anchor, area, iframe, form and link elements, and
form submit/requestSubmit (the static rewriter already covers
server-provided markup, including form action and formaction).
Rewritten URLs travel to the /__zl_nav__/<b64u> marker route (the
target base64url-encoded, opaque since #32), which the SW decodes
and proxies like any engine route: cross-origin navigations
otherwise never reach the fetch handler at all (SW interception is
scope-bound), which is what made them both unpreventable and
invisible. RTCPeerConnection is removed outright: WebRTC connects
directly, cannot be routed through the engine, and leaving a
constructible-looking API would be a fake feature.

Residuals, stated honestly:

- location and all its properties are LegacyUnforgeable: no page
  script, including the bootstrap, can hook location.href = "...", so
  a deliberate self-navigation to a real origin still escapes to the
  browser. No service-worker engine can close this class; it needs a
  real browser extension (declarativeNetRequest navigation
  redirects).
- URLs inserted through the HTML parser (innerHTML, document.write)
  bypass both the property and setAttribute hooks; the parser has no
  script-visible seam.
- Cross-origin subresource requests (fetch/XHR) from controlled pages
  are routed through the engine since #34 (see the browser-direct
  HTTP(S) escape section); what remains here is the navigation class
  only.

## Page-visible destination leakage (issue #32)

Before #32 the engine put the real destination in places a page (or
anyone reading the DOM, the address bar, history or resource timing)
could inspect. The known classes, all closed:

- `window.__ZL` no longer carries the destination. The rewriter
  injects `window.__ZL = { site: "<token>" }`: a stable opaque
  per-site identity (the fnv1a of the target origin, computed
  SW-side from the destination the engine already holds privately).
  Storage scoping, the cookie, relay and serviceWorker shims and
  the ws bridge all key off the token; an unrewritten document falls
  back to hashing the origin of its own baseURI.
- The mirror route scheme (`/m/https://real.site/...`) is removed:
  routes are b64u only. A persisted mirror config coerces to the
  default shape on restore, zl:config rejects any other scheme
  value, and decodePath no longer recognizes /m/ shapes, so the
  address bar, history and every page-visible route string carry
  only base64url.
- The navigation guard marker route encodes the target base64url
  instead of percent-encoded plaintext (see the #28 section).
- The engine error page no longer prints the target URL
  (docs/error-pages.md); its meta payload carries category and
  engine version only.
- The worker prelude keeps the upstream worker URL in a closure: the
  `__ZL_WORKER_URL__` global is gone, only the route prefix stays a
  global (it is the engine's own shape, not a secret).
- WebSocket retargeting moved SW-side: a same-origin ws URL stays
  engine-local on the page side and the SW retargets it through the
  sender's virtual context (#33), so `ws.url` and event origins
  report engine-origin URLs as written. The findLoad message posted
  to the page carries no destination echo.

Honest bounds:

- b64u is obfuscation, not encryption. decodePath is public and the
  route shape is documented: #32 removes the plaintext from
  page-visible surfaces, it does not make the target secret from
  whoever already holds the route.
- Location and referrer surfaces are routes by construction (the
  rewriter maps them through encodeDest; referrers are b64u routes).
  SW-constructed Responses have an empty Response.url. Cross-origin
  subresource requests route through the engine since #34, so no
  browser-network request carries the page-chosen URL; the URL string
  still appears in resource timing entries the page itself created
  (they are page-side objects, not network facts).
- Browser-level assertions over these properties are deferred to the
  real-Chromium harness (issue #35); CI runs no browser by design.

## Browser-direct HTTP(S) escapes (issue #34)

Before #34 the SW declined every foreign-origin http(s) request from
a controlled page and the browser went direct: every runtime-built
fetch/XHR, EventSource, sendBeacon, image, stylesheet, script, media
or worker URL that named a real origin exposed the client's IP and
the target hostname to the browser and the network. The right seam
is the fetch event itself: subresource requests from controlled
clients all reach the SW whatever origin they name, only navigations
are scope-bound. Routing there covers parser-inserted markup, CSS
url() and srcset too, surfaces no page-side hook can reach.

The policy (app/src/foreign.ts, pure code, unit-tested):

- route: the requesting client is a proxied document - its own URL
  decodes to an engine destination, or it holds a #33 virtual context
  (a proxied page or a worker the engine itself served; a worker's
  script URL may be foreign or a blob URL, so the URL alone is not
  the whole truth). The full request URL becomes the destination and
  the existing pipeline serves it: SSRF policy, header surgery, the
  per-origin cookie jar, transport, rewriter and netLog all apply
  unchanged, so no browser-direct request ever leaves.
- preflight: a CORS preflight (OPTIONS + access-control-request-method)
  from a proxied document is answered by the engine locally, for
  exactly the method and headers the page asked for, credentials
  honored. The target's own CORS policy never applied to
  engine-routed responses anyway (applyEngineCors states the
  engine's CORS facts on every response), so a local answer is the
  consistent one; the actual request that follows routes like any
  other.
- passthrough: requests from clients that are not proxied documents
  (the embedder app's own pages, or a client the SW cannot resolve)
  keep the direct browser path with the #30 escape telemetry. Failing
  open here is deliberate: the host app's cross-origin traffic is its
  own business, and an unknown client is far more likely a host page
  than a proxied one.

netLog: routed foreign requests carry the full target URL as their
engine-local path, preflight rows carry transport "engine" (answered
locally, no transport touch), and passthrough rows keep the #30 shape
and are now host-app and unattributable traffic only.

Residuals, stated honestly:

- location.href navigations are the #28 class: navigations never
  reach the fetch handler (SW interception is scope-bound), so the
  nav guard is the only defense and its residuals stand.
- Workers a page created from blob: URLs have neither a decodable
  client URL nor a #33 context; their foreign fetches passthrough.
  Opaque (data:, blob:) request URLs passthrough by construction.
- WebSocket is already bridged and never browser-direct; unchanged.

## Known open items (honest, not fixed by 3.0)

- SameSite approximation quality: referrer-derived site context is
  approximate for engine-initiated subresource requests; the knob
  stays opt-in.
- CSP of the embedding application is the host's job; Zeolite cannot
  restore the proxied page's own confinement headers and still
  function.
- The compat-suite policy hatch exists; deployments must verify they
  never export ZL_TEST_ALLOW_PRIVATE_DESTS.
- Fingerprinting resistance is spoofing, not anonymity: timing,
  font and other unprofiled surfaces remain measurable.
- The vendored transport's craigslist behavior (issue #11) is not a
  security issue: no data leaks, the failure is closed (error page),
  and the target host is unaffected.
- Runtime navigation residuals (issue #28): location.href assignments
  and HTML-parser-inserted URLs (innerHTML, document.write) still
  escape to the browser; see the runtime navigation escape section.
- Page-identity opacity is obfuscation (issue #32): base64url routes
  are reversible by anyone who holds them; see the destination
  leakage section.
- Browser-direct escape residuals (issue #34): blob-worker fetches
  and opaque request URLs passthrough; navigations are the #28
  class. See the browser-direct HTTP(S) escape section.
