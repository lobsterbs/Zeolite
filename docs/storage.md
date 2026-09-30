# Zeolite storage virtualization (1.5 Silicide)

Per-origin partitioning for everything a proxied page can persist.
The hard gate is unchanged: two proxied sites never see each other's
data, and neither ever touches the engine's own storage.

## What is partitioned, and how

Everything is keyed by the same stable site hash the bootstrap has
used since 1.0: `zl:<fnv1a36>:` derived from an opaque per-site token
(`window.__ZL.site`, set by the rewriter at injection time). The
service worker computes the same token from the destination it holds
privately, so the real origin never reaches the page (#32); an
unrewritten document falls back to hashing the origin of its own
baseURI, which keeps storage scoped and every shim native.

- **localStorage / sessionStorage**: engine-origin keys are prefixed
  with `zl:<site>:`, via a patched `Storage` object installed on both
  globals. `clear()` only clears the site's own keys; `key()` and
  `length` only count them. Session storage is per-tab in the browser
  and stays per-tab here; the prefix isolates two sites inside one tab.

- **IndexedDB**: `indexedDB.open(name)` and `deleteDatabase(name)` are
  wrapped to open `zl:<site>:name` instead. `IDBFactory.cmp` is wrapped
  the same way (both arguments prefixed, so ordering stays consistent
  inside the site scope; absent when the host factory lacks it, never
  faked). `databases()` is deliberately absent on the shim (an honest
  unimplemented API beats wrapping it and risking a leak of
  engine-own database names). The shim is installed with
  `Object.defineProperty`, not assignment: the Window property is
  accessor-only and the bootstrap is a classic sloppy-mode bundle, so
  the old plain assignment failed silently and left the raw unscoped
  factory in place (caught by the browser E2E suite, #35). The
  engine's own databases (the extension runtime's `idb` store, the
  cookie jar's `cookies` store, the download registry's `downloads`
  store) live in the service worker context and are unreachable from
  pages.

- **Cache API**: `caches.open/delete/has` are prefixed the same way;
  `keys()` lists only the site's own caches, un-prefixed; `match()`
  searches only the site's own caches (so a page can never match
  another site's cached responses). Installed via `defineProperty`
  for the same reason as IndexedDB above (#35). The engine's own page
  cache is opened by the service worker directly and is invisible to
  pages.

- **document.cookie**: virtualized against the 1.4 cookie jars. The
  bootstrap patches `document.cookie` on the document instance:
  writes are forwarded to the service worker via the `zl:docCookie`
  control message and admitted through the same RFC 6265 code path as
  `Set-Cookie` (with the `HttpOnly` attribute stripped, because a
  script cannot mint an HttpOnly cookie); reads return the jar view
  for the page origin (all non-HttpOnly cookies that domain-match,
  regardless of path, like the real getter).

## document.cookie consistency model (honest limits)

The real `document.cookie` getter is synchronous; the authoritative
jar lives in the service worker, a message round-trip away. The page
therefore keeps an optimistic local copy:

- a read triggers an asynchronous jar refresh that replaces the copy;
- a write applies to the copy immediately (so read-after-write works),
  then forwards the write; the jar reply corrects the copy.
- a Set-Cookie admitted on a proxied response (fetch/XHR reply or a
  redirect hop) is pushed, not polled: the service worker posts the
  fresh jar view to the requesting client's `zl:docCookie` port right
  after admission, so a fetch-received cookie is visible to the page's
  next read without waiting for that read's own refresh (#35).
- deletion (`max-age=0` or a past `Expires`) is not detected locally:
  the copy keeps the stale pair until the next jar reply corrects it
  (milliseconds).
- A cold page returns `""` until the first jar reply lands.
- Cross-window writes become visible once the other window's next
  read completes its refresh. This is eventual consistency, not a
  cookieStore polyfill.

## blob:, data:, about: handling

Opaque schemes are browser-native and never engine routes. The fetch
handler passes any non-http(s) request through before route decoding
(`isOpaqueUrl` in `codec.ts`): `createObjectURL` media, blob workers,
generated blob downloads, `data:` documents and `about:blank` frames
all work natively. Static `blob:`/`data:` URLs in rewritten HTML are
left untouched by the rewriter; they have no cross-origin meaning at
page scope anyway.

## Cross-site channels beyond storage (#37)

The engine serves every virtual site from one real origin, so any
engine-origin-wide channel leaks across sites unless it is scoped
(bootstrap/isolation.ts):

- **storage events**: one real `storage` listener re-dispatches only
  this site's events to page handlers, prefix stripped,
  `storageArea` pointing at the page's scoped Storage. Another
  site's writes and engine-own keys never reach a page listener.
  `addEventListener("storage")` and `onstorage` are both covered; on
  a context where the interception cannot install, the native
  delivery (prefixed keys) stays, documented in docs/matrix.md.
- **BroadcastChannel**: channels silently move onto a site-prefixed
  real name; the page-visible `.name` keeps the page's spelling, so
  two virtual sites never hear each other.
- **window.name**: scoped through the site-scoped sessionStorage;
  same-site reloads keep it, another virtual site starts empty.
- **cookieStore**: it reads the real engine-origin cookie jar, not
  the virtual per-site jar, and its async/change-event semantics
  cannot be built on the jar without faking. It is removed at
  runtime (feature detection falls back to the virtual
  `document.cookie`) - honest absence, never a fake.

## Persistence

Site-scoped `localStorage` keys, prefixed IndexedDB databases and
prefixed caches live in the engine origin's real storage, so they
survive engine restarts. The cookie jar persists through its own
IndexedDB record (see docs/cookies.md). `zl:teardown` drops every
cache the service worker owns (site-prefixed ones included) and
unregisters the engine; storage keys and databases are left behind
by design (session export is Phase 7 scope).

