# Known limitations

Honest gaps, written down rather than papered over (README norm). Each
entry states what does not work, why, and where the real fix would land.

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

## POST with a streaming body against a 307/308

A redirect whose request body was already partially consumed (streaming
POST) cannot be replayed by the worker. The hop is surfaced to the page
with a mapped `Location` and the browser re-issues the request per
spec. A page that does not follow the redirect sees the submission as
hung. The DIAG event on the hop explains the behavior.

## Shared workers are keyed by URL only

Classic and module shared workers loading from the same URL share one
key, so their script environments are not isolated from each other.
Documented in docs/matrix.md; a module/classic-aware key is the fix.

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

## Page cache eviction is best effort

The per-worker page cache is capped (ZL_PAGE_LIMIT entries). If a
cache eviction delete fails (storage pressure), the cache may exceed
the cap until entries are dropped; a once-per-worker DIAG warning
records the condition. Cache stores that fail (storage full) skip
caching for that response, also with a once-per-worker warning.

## TLS and HTTP/2 fingerprints are client-stack

TLS terminates in the browser (libcurl/mbedTLS or epoxy/rustls), so
the wire fingerprint is that of the vendored stack, not a real browser
stack. Per-site FingerprintProfile data (siteconfig) aligns the
document surface (UA, languages, headers) with the wire surface where
possible, but JA3/H2 coherence is bounded by the transport stack.
