# Zeolite storage virtualization (1.5 Silicide)

Per-origin partitioning for everything a proxied page can persist.
The hard gate is unchanged: two proxied sites never see each other's
data, and neither ever touches the engine's own storage.

## What is partitioned, and how

Everything is keyed by the same stable site hash the bootstrap has
used since 1.0: `zl:<fnv1a36>:` derived from the target origin
(`window.__ZL.dest`'s origin, set by the rewriter at injection time).

- **localStorage / sessionStorage**: engine-origin keys are prefixed
  with `zl:<site>:`, via a patched `Storage` object installed on both
  globals. `clear()` only clears the site's own keys; `key()` and
  `length` only count them. Session storage is per-tab in the browser
  and stays per-tab here; the prefix isolates two sites inside one tab.

- **IndexedDB**: `indexedDB.open(name)` and `deleteDatabase(name)` are
  wrapped to open `zl:<site>:name` instead. `databases()` is
  deliberately absent on the shim (an honest unimplemented API beats
  wrapping it and risking a leak of engine-own database names); so is
  `IDBFactory.cmp`. The engine's own databases (the extension
  runtime's `idb` store, the cookie jar's `cookies` store) live in
  the service worker context and are unreachable from pages.

- **Cache API**: `caches.open/delete/has` are prefixed the same way;
  `keys()` lists only the site's own caches, un-prefixed; `match()`
  searches only the site's own caches (so a page can never match
  another site's cached responses). The engine's own page cache is
  opened by the service worker directly and is invisible to pages.

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

## Persistence

Site-scoped `localStorage` keys, prefixed IndexedDB databases and
prefixed caches live in the engine origin's real storage, so they
survive engine restarts. The cookie jar persists through its own
IndexedDB record (see docs/cookies.md). `zl:teardown` drops every
cache the service worker owns (site-prefixed ones included) and
unregisters the engine; storage keys and databases are left behind
by design (session export is Phase 7 scope).
