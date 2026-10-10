# Power features spec (Phases 3-4)

This document pins the contracts for the four power subsystems so they can
be built independently but compose. Everything here extends the engine
adapter contract in docs/engine-adapter.md and never replaces it.

## 1. Plugin API (native extension support)

A plugin is a signed ES module shipped from the app origin, loaded only by
the engine service worker. No remote code, ever: a plugin that is not
served from the engine origin does not load. That is a security boundary,
not a limitation.

```ts
// app/src/plugins.ts (target contract)
export type LjPlugin = {
  id: string;                 // reverse-dns, e.g. "im.zeolite.adstrip"
  version: string;
  permissions: PluginPermission[];  // declared, user-granted
  hooks: Partial<PluginHooks>;
};

export type PluginPermission =
  | "observe:requests"        // read-only request/response metadata
  | "modify:responses"        // rewrite bodies before the rewriter pass
  | "block:requests"          // veto requests
  | "storage:site"            // per-site keyed storage
  | "spoof:configure";        // change fingerprint profile per-site

export type PluginHooks = {
  onRequest(ctx: RequestContext): RequestVerdict | Promise<RequestVerdict>;
  onResponseHeaders(ctx: ResponseContext): HeaderEdit | Promise<HeaderEdit>;
  onResponseStream(ctx: StreamContext): TransformStream | null;
  onNavigate(ctx: NavigateContext): void;
  onCaptcha(ctx: CaptchaContext): CaptchaPolicy;
};
```

Rules:
- onRequest/onResponseHeaders see metadata, not raw bodies, unless
  modify:responses was granted. Bodies are streams; plugins return a
  TransformStream, never a buffered string.
- A plugin crash is contained: the hook call is wrapped, an exception
  disables that hook for the page load and logs to the technical ring,
  never takes the page down.
- Order: plugins run in registration order; block verdicts short-circuit.
- Ad/tracker stripping (phase 3) ships as the FIRST plugin using this API,
  not as engine code. It must eat its own dogfood.

## 2. Devtools hooks

Two tiers, in this order:

Tier 1, network inspector: the SW keeps a per-page-load ring of request
records (method, decoded target URL, wisp stream id, status, timing quartiles
TTFB/TTLB/done, bytes in/out, plugin verdicts). The devtools page
(app/devtools.html) opens a MessageChannel to the SW and streams the ring.
This is priority: it is also the debugging tool for everything else here.

Tier 2, CDP-subset DOM inspector: an injected content bridge
(postMessage relay, never direct DOM access from the devtools page) that
supports, at most: DOM tree snapshot, element highlight, computed styles,
console capture, storage view. Full CDP is out of scope; the bridge speaks
a tiny JSON schema of our own.

Both tiers respect permissions: an inspector that is not granted
observe:requests shows nothing. Devtools are disabled entirely when the
user is in a "strict" privacy mode.

## 3. Spoofing (fingerprint impersonation)

Location, corrected against the shipped architecture: the wisp server is
a RAW TCP relay (see crates/zeolite-server - TcpStream::connect, zero TLS
dependencies). TLS to target sites is terminated inside the client
transport, in the browser (libcurl.js = mbedTLS, epoxy = rustls+hyper),
end-to-end through the tunnel. The server never sees or originates a
TLS handshake, so "apply the profile at the wisp server connection
pool" would require terminating and re-originating TLS server-side -
a MITM with forged certificates. That is refused, not deferred.

What ships instead (the honest version of this contract):

- Profile model: a FingerprintProfile is DATA (the object accepted by
  the zl:fingerprint control message and docs/fingerprint.md):
  userAgent, platform, languages, screen, timezone, WebGL, canvas seed,
  and an engines binding. Applied per-site from siteconfig
  (SiteRule.fingerprint) or globally by the host; a plugin with
  spoof:configure can do the same later. Per-site resolution is
  ruleProfile() in siteconfig.ts; the SW applies it to the document
  init script, worker init scripts, and the upstream
  User-Agent/Accept-Language for that host's traffic.
- TLS/HTTP-2 fingerprint (JA3/JA4, ALPN, H2 SETTINGS): a property of
  the TRANSPORT ENGINE, never of the profile (this is what
  docs/fingerprint.md pins, and what the engines field binds). The two
  shipped stacks (libcurl/mbedTLS, epoxy/rustls) ARE the profile
  levers; switching engines is the only way to change the handshake.
  Big-three browser TLS stacks cannot ship: each engine carries one
  wasm TLS stack, and shipping three would mean three vendored
  TLS implementations - not built, and not pretended.
- Hard rule kept: the JS-surface profile and the wire surface come
  from the SAME profile object (the SW compiles both from one
  FingerprintProfile), so document and wire never disagree.
- Client-side JS surface spoofing stays SECOND to transport-layer
  honesty, as before. Spoofing JS surfaces while the transport screams
  "proxy" is worse than not spoofing at all.

## 4. Captcha detection (not bypass)

The repo non-negotiable stands: NO automated solving, NO interstitial
bypass, no Google login flows. What we ship instead:

- The rewriter tags responses that match known interstitial markers
  (cf-chl, recaptcha api loads as the only content, hcaptcha iframe,
  HTTP 403/429 with challenge bodies) as a CaptchaState on the page
  record: { kind: "cloudflare" | "recaptcha" | "hcaptcha" | "unknown",
  detectedAt, bodySnapshot (truncated) }.
- The engine adapter surfaces CaptchaState to the embedder. LobsterBrowse
  renders a real "this site wants a human" page with the proxied
  challenge visible and interactive INSIDE the proxy frame, because a
  challenge solved by the real user inside the session is legitimate.
- onCaptcha plugin hook lets plugins change the policy: block the page
  load, retry later, or annotate. It cannot auto-solve. The hook type
  has no "solve" verb on purpose.
- Telemetry: the compat suite records captcha incidence per site so the
  scoreboard shows which sites are effectively unusable, which is the
  honest signal, and which fingerprint profiles correlate with fewer
  challenges (that is the spoofing feedback loop).

Honest gap (2026-10-10, verified live): Google reCAPTCHA widgets
boot through the engine - api.js and the anchor load, the
checkbox is clickable, and #127 restored the upstream Referer
that an origin-only Referrer-Policy page would otherwise drop.
#129 routes challenge-widget frames through the engine too:
#120's provider-direct 302 was an IP leak (the #32 class) and
left the anchor cross-origin, so the widget's postMessage to the
embedder was dropped and the challenge spun. #130 finishes the
frame protocol: every engine frame is one real origin, so a
virtual targetOrigin is rewritten to the engine origin and
delivered natively (real ev.source, truly transferred ports);
each realm asks the engine for its own virtual origin
(zl:getVirtualOrigin, recovered worker-side from the client's
route, never a page-supplied claim) and marks its window with
it, and page message listeners see events re-labelled with the
sender's virtual origin - the unproxied view end to end, both
postMessage call shapes covered. A #132 follow-up (measured
live) removes that origin relabel: recipients such as the
reCAPTCHA channel establishers derive the origin they expect
from the rewritten src/co= URLs, which point at the engine, so
a virtual-origin relabel made every origin check fail and the
setup port was never taken; ev.origin now deliberately stays
the native engine origin while ev.source keeps the identity
relabel. #131 repairs the last
measured seam: that wrapper re-emits from its OWN realm, so the
anchor's parent.postMessage arrived stamped with the page's window as ev.source (from=self) and the page's grecaptcha
dropped it; each child now shadows its configurable window.parent
getter (measured; top is LegacyUnforgeable) with a Proxy that
executes the parent's stashed native from the CHILD realm, so
the browser stamps the genuine caller. #132 closes the remaining
duplex seams: the reply direction had the same corruption (the
page's calls into anchor.contentWindow re-emitted in the CHILD
realm, so the anchor heard its own setup echo) and the wrapper
delivered self-echo phantoms the unproxied browser drops; every
realm now shadows contentWindow on the iframe/frame prototypes
with a cached Proxy that runs the child's stashed native from
the CALLER's realm, and a parseable targetOrigin the recipient's
virtual-origin marker does not match is dropped (the unproxied
behavior). A same-day #132 follow-up closes the strict channel
handshake: the page gstatic receiver accepts the setup port
only when ev.source is the anchor contentWindow it stored, and
the engine was delivering the raw anchor window, so the port
was never taken and the widget timed out; delivered events now
also relabel ev.source to the sender cached contentWindow
proxy (one shared childProxyOf cache across the shims, so
references compare equal), while a sender never read via
contentWindow keeps raw identity. The wrapper own-slot legacy
re-emit is gone too: it replays the exact native call, matching
the measured direct run (self delivery drops ports, cross-frame
delivery preserves them). A further same-day follow-up closes
the identity race the live probe still showed: the strict
listener re-reads contentWindow inside its handler, and an
event can beat the realm first post-bootstrap read, so
ev.source stayed raw while w() returned the proxy and every
anchor rebuild repeated the mismatch; the relabel now mints
the shared per-child proxy on demand for senders that are this
document own frame elements (mintChildProxy /
childProxyByFrame), so the first delivered event and every
later read converge on one identity.
Residual: window.top and window.frames[i] are
LegacyUnforgeable and keep receiver-side delivery. Deliberate #32 relaxation
(user-authorized): page-realm scripts can read their own site's
origin at runtime; a spoofed marker grants nothing new, every
engine frame is already same-origin scriptable. What remains
unfixable: unforgeable location reads inside frames (#32 class)
and the datacenter IP failing Google's risk engine even on a
direct headless load. The no-bypass rule stands; hCaptcha and
Cloudflare Turnstile frames take the same engine-routed path.
## 5. Lazy images (opt-in rewrite pass)

A zl:config imageLazy true push (boolean, absent keeps the live
choice; resets to off on SW restart) turns on a streaming rewriter
pass that appends loading="lazy" to img tags that do not already
carry a loading attribute. Additive only: no attribute is removed,
scripts/styles/documents are untouched, and a page that sets its
own loading value per image keeps it. Off by default; hosts that
want it re-push it per boot.

## Build order

1. Network inspector ring + devtools streaming (it debugs the rest).
2. Plugin host + permissions + ad-strip as plugin zero.
3. Fingerprint profiles as data + wisp server enforcement.
4. Captcha detection + adapter state + embedder UI.
5. DOM bridge inspector (tier 2) last, it is the least load-bearing.
