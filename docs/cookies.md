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
- `SameSite`: parsed and stored. Enforced only through the opt-in
  policy knob (below). The spec rule `SameSite=None` requires `Secure`
  is enforced as a hard gate regardless of the knob.
- host-only cookies (no Domain attribute) attach only to the exact
  response host, never to subdomains.
- `Max-Age` / `Expires`: `max-age<=0` or a past `Expires` deletes the
  matching cookie (same name, domain, host-only flag and path);
  a session cookie has neither attribute and never expires.
- Re-admission of the same name + domain + path overwrites.

## Request assembly

`cookieHeaderFor(requestUrl, ctx?)` returns the `Cookie` header value for
a request: every cookie whose domain, path and Secure attributes match,
ordered by longest path first, then earliest creation. Null when
nothing matches. The optional context carries the request initiator
and whether it is a top-level navigation; it feeds the SameSite knob.

The service worker attaches this as the final cookie write on every
outgoing proxied request, and drops the browser's engine-origin
`Cookie` header: engine-origin cookies never leak upstream, and rule
or interceptor header modifications cannot leak another origin's
cookies.

## SameSite policy knob (2.2 Arsenide)

`setSameSitePolicy` (control message `zl:sameSite { policy }`) turns
SameSite enforcement on. Off by default. Under `"approx"`:

- the cookie's effective policy is its attribute, `null` meaning lax
  (the browser default);
- `SameSite=None` always attaches (admission already required Secure);
- the site context is the request initiator recovered from the
  referrer: same-site (or unknown) initiator attaches everything;
- cross-site initiator drops strict, and allows lax only on
  top-level navigations.

This is an approximation, honestly: every proxied request is
engine-initiated, the engine only sees the referrer, and the
site-for-cookies computation is the last-two-host-labels heuristic (no
public-suffix list). Requests the SW follows across redirect hops keep
the original initiator context.

## Redirect hops (2.2 Arsenide)

The transport's fetch adapter surfaces 3xx responses instead of
following them, so the SW follows the hop chain itself: every hop's
`Set-Cookie` is captured against the hop URL, 303 (and POST on
301/302) continues as GET, and 307/308 replay the method. A hop whose
one-shot stream body cannot replay, a hop past the cap (10), or a 3xx
without a resolvable Location is surfaced to the page with its
Location mapped to an engine route (its Set-Cookie is still captured).

## Jar profiles (zl:jarProfile)

The host app can switch the whole jar between the durable `default`
profile and a throwaway session profile (incognito isolation, the
client-side equivalent of the server engine's per-sid `lb_inc` jar):

```
{ type: "zl:jarProfile", profile: "inc:<session-id>" }   // switch
{ type: "zl:jarProfile", profile: null }                 // back to default
```

- Session-profile cookies are in-memory only: they are never written
  to IndexedDB, and they are dropped the moment the host switches
  back to the default profile (or any other profile).
- Admission, request assembly, `document.cookie` reads/writes, the
  session-export snapshot and import (replace and merge) all operate
  on the active profile only; the export format is unchanged (records
  stay keyed by bare origin id).
- The profile is SW runtime state: it resets to `default` on SW
  restart, and `zl:ping` echoes it (`profile`) so the host can detect
  a revert and re-push. A restart while a session profile is active
  can briefly admit cookies into the default jar until the host's
  re-push lands — the host re-sends on boot, on the incognito toggle
  and on `controllerchange`.
- Malformed profile input (non-string, empty, over 64 chars, or
  containing the key separator) falls back to `default`, and the
  reply reports the effective profile.
- One engine origin serves one host app instance: the profile is
  global SW state, so two app windows in different incognito states
  cannot hold different profiles at the same time (last push wins).
  The engine's page cache is also shared across profiles (cookies
  never are).

## Session import modes (2.2 Arsenide)

`zl:importSession` accepts `mode: "replace"` (default, the 1.7
behavior) or `mode: "merge"` with `rule: "import-wins" |
"keep-existing" | "keep-newest"`. Merge mode adds imported cookies
into the live jars; a conflict (same name + domain + hostOnly + path)
is resolved by the rule, `keep-newest` comparing the `created`
timestamps. Malformed records are dropped, never admitted. The reply
carries honest counts: `{ jars, cookies, conflicts }`.

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
version 3 carries the `cookies` and `downloads` stores). Writes are
debounced; the SW restores the jar on activate. `zl:teardown` clears
it: cookies do not survive an engine switch.

## Honest limits

- Redirect hops are followed by the SW itself (the transport surfaces
  3xx), so `Set-Cookie` on intermediate hops is captured (2.2). A hop
  the SW cannot follow (307/308 with a one-shot stream body, or past
  the 10-hop cap) is surfaced to the page with a mapped Location; its
  `Set-Cookie` is captured before that.
- SameSite is enforced only through the opt-in knob, and the site
  context is an approximation (see the knob section).
- `document.cookie` IS virtualized by the bootstrap: page scripts read
  and write a per-origin view over the `zl:docCookie` channel, backed
  by this jar (the page never touches the engine-origin cookie store).
- The transport (libcurl) may hold cookies internally; this jar is
  the engine's authoritative Cookie source for requests it initiates,
  and the session-export seam (`docs/engine-adapter.md`) still probes
  the transport defensively.

## Status

Implemented (1.4 Boride; SameSite knob, hop capture and merge-mode
import added in 2.2 Arsenide; jar profiles added on the
deep-integration line). Tested in
`app/src/__tests__/cookies.test.ts` (admission, matching, deletion,
isolation, ordering, persistence, SameSite knob, merge mode) and
`app/src/__tests__/jar-profiles.test.ts` (profile isolation,
persistence, document.cookie, import scoping).

