# Zeolite virtual origins + cookies (Phase 4, 1.4 Boride)

The engine owns one cookie store, `app/src/cookies.ts`, partitioned by
the virtual-origin registry. Every proxied request the service worker
initiates carries a `Cookie` header assembled from this store, and
every proxied response's `Set-Cookie` headers are captured into it
before the page ever sees them.

## Virtual-origin registry

`registerOrigin(origin)` maps each target origin to its
Zeolite-internal representation:

- a stable internal id (FNV1a base36 of the origin, the same scheme
  the bootstrap uses for storage scoping), and
- the codec path base (the engine-local encoding of the origin).

The jar stores cookie records under these ids.

## Cookie admission (RFC 6265)

`applySetCookie(responseUrl, headers)` parses every `Set-Cookie` header
of a response and admits each cookie with:

- `Domain`: stored with the leading dot stripped; a cookie is rejected
  when its Domain does not scope the response host (domain-match).
  Dotless domains that are not the host itself are refused (a cheap
  stand-in for a public-suffix list, blocking `Domain=com`).
- `Path`: defaults to the RFC 6265 default-path (the response path's
  directory); request matching is RFC 6265 path-match.
- `Secure`: stored; secure cookies attach only to https requests.
- `HttpOnly`: stored; there is no page-side cookie exposure to enforce
  it against yet.
- `SameSite`: parsed and stored, never enforced (see limits). The spec
  rule `SameSite=None` requires `Secure` is enforced as a hard gate.
- host-only cookies (no Domain attribute) attach only to the exact
  response host, never to subdomains.
- `Max-Age` / `Expires`: `max-age<=0` or a past `Expires` deletes the
  matching cookie (same name, domain, host-only flag and path);
  a session cookie has neither attribute and never expires.
- Re-admission of the same name + domain + path overwrites.

## Request assembly

`cookieHeaderFor(requestUrl)` returns the `Cookie` header value for a
request: every cookie whose domain, path and Secure attributes match,
ordered by longest path first, then earliest creation. Null when
nothing matches.

The service worker attaches this as the final cookie write on every
outgoing proxied request, and drops the browser's engine-origin
`Cookie` header: engine-origin cookies never leak upstream, and rule
or interceptor header modifications cannot leak another origin's
cookies.

## Set-Cookie surgery

`set-cookie` and `set-cookie2` are stripped from every response the
page sees (the hostile-header list). The page runs at the engine
origin; letting it execute `Set-Cookie` would write target-site
cookies into the engine-origin cookie store. Capture happens before
the strip, and the inspector detail record keeps the Set-Cookie names
(values are never stored, per the diagnostics redaction rules).

## Isolation hard gate

A cookie is admitted only when its Domain scopes the response host,
and attached only when its own attributes match the request host and
path. There is no API to read another origin's jar, and no code path
that bypasses the domain-match check: unrelated target origins are
isolated by construction.

## Persistence

The whole jar is one record in IndexedDB (service workers have no
localStorage; the extension subsystem's idb helper is reused, DB
version 2 adds the `cookies` store). Writes are debounced; the SW
restores the jar on activate. `zl:teardown` clears it: cookies do not
survive an engine switch.

## Honest limits

- Redirects are followed inside the transport (`redirect: "follow"`),
  so `Set-Cookie` headers on intermediate 3xx hops never surface to
  the jar. The jar sees every request the engine initiates and every
  final response; intermediate hops are handled by the transport's
  own redirect logic.
- SameSite is stored, not enforced: every proxied request is
  engine-initiated and has no meaningful site-for-sites context.
- `document.cookie` is not virtualized yet: page scripts read and
  write the engine-origin cookie store, not this jar. That is Phase
  5 (storage virtualization) scope.
- The transport (libcurl) may hold cookies internally; this jar is
  the engine's authoritative Cookie source for requests it initiates,
  and the session-export seam (`docs/engine-adapter.md`) still probes
  the transport defensively.

## Status

Implemented (1.4 Boride). Tested in
`app/src/__tests__/cookies.test.ts` (admission, matching, deletion,
isolation, ordering, persistence).
