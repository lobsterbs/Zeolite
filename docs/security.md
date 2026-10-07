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

## Wisp endpoint auth, exposure and browser-origin guard

Closed in the 2026-10-07 audit round, all socket-gated in the Rust test
suite:

- Wisp auth can no longer be bypassed by a CONTINUE-first handshake. A
  v2 client that sends CONTINUE as its first packet used to complete
  the handshake without any INFO exchange, so check_auth never ran,
  and the CONNECT gate (auth_ok) passed the unverified session
  whenever the confusingly named ZL_AUTH_REQUIRED_V1 flag was off -
  the default. An unauthenticated client could open streams with
  ZL_WISP_USER/ZL_WISP_PASSWORD or an Ed25519 key configured. Now the
  Ok(None) handshake branch refuses unverified sessions at once, and
  auth_ok rejects every unverified session when auth is configured
  (v1 sessions can never authenticate and are always refused).
  Socket-level tests drive the CONTINUE-first shape, the
  INFO-without-extension shape, the v1 shape and a full authenticated
  password session through the real axum app.
- The server binds 127.0.0.1 by default (ZL_BIND / --bind to
  override). It used to hard-bind 0.0.0.0, which made the README
  quick start an open relay reachable from every network the host is
  on.
- The /wisp/ upgrade checks Origin: browsers always send it;
  non-browser clients pass without one. With an allowlist configured
  (ZL_ALLOWED_ORIGINS, comma-separated) the Origin must be listed;
  otherwise it must match the request's own Host (same-origin). A
  reverse proxy in front of the server must list its client origins,
  or the browsers behind it lose wisp access - deliberate fail-closed.
- Auth configuration fails closed: a half-set ZL_WISP_USER/
  ZL_WISP_PASSWORD pair or a malformed ZL_WISP_ED25519_HEX is a hard
  startup error (exit 2). Both used to filter to None, leaving an
  open server that looked configured.
- The KDL config file (ZL_CONFIG / --config) fails closed like the
  environment: unknown settings are rejected, limits clamp to the
  same minimums as the environment overlay, and the auth block runs
  through the same auth_config validation. A malformed or unreadable
  file refuses to start.
- Optional per-IP connection cap (MAX_CONNECTIONS_PER_IP, default
  off): a reverse proxy collapses all peers into one address, so the
  default cannot be a per-IP number.
- Static responses carry X-Content-Type-Options: nosniff, and an
  opt-in frame-ancestors CSP (ZL_FRAME_ANCESTORS) exists because the
  engine app is designed to be embedded by host applications.

## Header surgery

Two header paths, both deliberate, invoked from app/src/sw.ts
with the surgery helpers in app/src/headers.ts (unit-gated in
app/src/__tests__/leak.test.ts):

- Upstream responses pass stripHostile(), which removes CSP,
  CSP-report-only, X-Frame-Options, HSTS, COOP/COEP/CORP,
  Permissions-Policy, Set-Cookie, Set-Cookie2 and the
  destination-bearing informational headers (Link, Content-Location,
  X-Original-URL), plus the browser-action headers:
  Clear-Site-Data (honored by the browser on any response, an upstream
  response would wipe the engine origin's own storage - the host
  app's state and every virtual site's partition; an isolation bug,
  not just a leak), Report-To, NEL and Reporting-Endpoints (the
  browser would send network-error reports directly to upstream-named
  real endpoints, a #34-class browser-direct escape), and
  Timing-Allow-Origin (names upstream origins, nothing reads it).
  Location is mapped to an engine route on any status that carries
  it, not only surfaced 3xx. The functional Refresh header is not
  stripped:
  its url=, when present, is re-encoded to an engine route against
  the response destination (mapRefreshHeader), so a delayed refresh
  stays inside the engine; a same-page refresh (no url=) passes
  untouched and an unresolvable url= fails closed with the header
  dropped. This is the core
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
- localStorage/sessionStorage/IndexedDB/Cache API are scoped by the
  page-held site token (the keyed per-origin MAC above, fnv1a in the
  keyless degraded mode); the SW-side jar id stays SW-private and
  does not need to match it. Cache match only sees the origin's own
  entries.
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
  bypass both the property and setAttribute hooks. Anchors, forms
  and meta refresh still fire the navigate event (covered above);
  parser-inserted iframe/frame src is covered by a document-wide
  MutationObserver in the bootstrap, which rewires the src to the
  marker before the browser's queued iframe load task starts (an
  observer callback is a microtask, the load is a task, so the
  child never receives the plaintext address). Frames inside a
  shadow root escape the document observer (honest limit).
- srcdoc and about:blank child documents (issue #58): a frame's
  inline document runs no bootstrap, so the parent hooks cannot see
  its runtime. The parent rewrites the navigable attributes inside
  the srcdoc markup at the property, setAttribute and parser seams,
  and guards the child realm itself: the frame observer re-enters
  the navigation guard on every reachable same-origin child
  window, recursively and re-armed on the frame's load event, so a
  runtime meta refresh or location assignment inside the child
  cancels-and-re-drives through the marker instead of committing
  browser-direct (a real-URL subframe navigation is exactly what a
  browser URL-block policy evaluates). Honest residuals, kept open
  on the issue: cross-origin and sandboxed children stay
  browser-direct on purpose (the realm probe cannot reach them, and
  blanket-routing them would swallow challenge-host and host-app
  frames), a child script that navigates before the observer
  microtask still wins the race, requests the child's own scripts
  make keep the #34 about: limits, unquoted attribute values inside
  the markup keep their limit, and frames inside a shadow root
  escape the document observer.
- Fragments after a mapped navigation are an engine-wide bound: the
  page URL the browser commits is the engine route alone, so a
  target's fragment (mapped Location, Refresh url=, marker routes)
  never re-appears in the address bar and fragment-targeted scroll
  does not happen. Fragment-only references inside a rendered page
  (#top) stay client-side and keep working. Re-stamping the fragment
  onto the served route from the decoded destination would be the
  fix, if a real site ever needs it.
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
  per-site identity, computed SW-side from the destination the
  engine already holds privately. With a #55 route key active the
  token is a SipHash MAC of the target origin under that key, so an
  origin dictionary cannot reverse it the way it could the old
  fnv1a token; the keyless degraded mode keeps the fnv1a token, and
  the mint waits for the key to settle so one site never splits
  across both prefixes (storage written under an older prefix is
  orphaned by the upgrade, honestly).
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
- Browser-level assertions over these properties run in the real-Chromium
  browser job (issue #35, suite/e2e): the suite asserts no plaintext
  destination in window.__ZL and on page surfaces, and that two virtual
  contexts stay isolated in localStorage, the cookie jar and the Cache
  API.
- The page-realm mint seam (#54 residual 1): proxied pages may send
  zl:mint and receive an opaque route minted under the SW-realm key.
  This grants no new capability (the legacy codec is page-public; a
  page could always encode any destination itself) and minted
  destinations are bounded to absolute http(s) URLs. Consumers are
  not yet migrated: navguard markers, worker-prelude fetch inputs
  and bootstrap-issued requests still carry legacy-shape routes
  until #54 items 2-3 land; importScripts stays legacy for good
  (synchronous, no channel to the SW).

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

## Capture-dated leak inventory (issue #62)

Every surface on which a destination URL can appear decodably, dated
to this capture (keyed routes #55, keyed site tokens #32, navigation
handles #63, marker-branch fix #62):

Covered - no plaintext destination on the surface:

- Engine routes (`/j/`, `/__zl_navh__/`): keyed tokens; the legacy
  decode of the tail yields keystream garbage, never http(s). Pinned
  by the browser e2e leak-inventory check and the navhandle unit
  tests.
- Initial navigation via `zl:navHandle` (#63): the handle route is a
  keyed token with a TTL; the mint reply and the navigated URL carry
  no decodable destination.
- Storage tokens, WS retarget URLs, the error page: opaque or
  engine-shaped; unchanged from the sections above.
- The runtime navguard marker branch: the SW-side `/__zl_nav__/`
  decode was broken from the first release (the branch matched the
  bare marker path, which navEncode never emits); every marker
  navigation fell into escaped-path recovery. Fixed and pinned by a
  browser e2e marker navigation.

Documented residuals - decodable, bounded, by design:

- Navguard markers (`/__zl_nav__/`): b64u of the target, the #54
  degrade when the keyed mint is unavailable. Counted and named by
  the e2e inventory check, never failed.
- Worker prelude inputs and bootstrap re-emission seams: legacy
  shape where the receiver cannot hold the key (#54 residuals).
- `importScripts` stays legacy for good: worker scripts cannot
  await a mint before load.
- The `?url=` initial embed: plaintext until a host adopts
  `zl:navHandle` and flips `navHandles` (#63); the engine refuses it
  only on the opt-in, so migration is the host's choice.

Open: none at this capture date. The browser e2e leak-inventory
check walks every captured request URL and the proxied page's
resource-timing names and fails on any `/j/` or `/__zl_navh__/` tail
that legacy-decodes to http(s); the list above is what it pins.

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
  still escape to the browser; parser-inserted URLs are covered where
  a seam exists (navigate event, iframe observer), frames inside a
  shadow root are not. See the runtime navigation escape section.
- Page-identity opacity is obfuscation (issue #32): base64url routes
  are reversible by anyone who holds them (the keyed site token is a
  MAC and is not); see the destination leakage section.
- Browser-direct escape residuals (issue #34): blob-worker fetches
  and opaque request URLs passthrough; navigations are the #28
  class. See the browser-direct HTTP(S) escape section.
