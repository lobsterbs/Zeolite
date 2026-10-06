# Browser E2E suite (issue #35)

Real-Chromium regression tests for the browser runtime: the
transport-level compat suite cannot see SW interception, the bootstrap
shims, the rewriter's page seams or the privacy properties, so
browser-only failures survived CI.

## What it does

Launches a controlled Chromium (Playwright), starts zeolite-server
serving `app/dist` on 127.0.0.1:6002 (with the test-only
`ZL_TEST_ALLOW_PRIVATE_DESTS=1` SSRF hatch, same as the compat job) and
two deterministic fixture origins on 127.0.0.1:7101/7102, then loads
fixture pages through `/?url=<target>` and asserts:

- Routing: absolute and relative links, 302 redirects, SPA pushState
  with rerouted API fetches, reload, query-bearing fetches keep their
  query exactly once (#38).
- Recovery (#31): a malformed engine route and an unroutable unlisted
  target answer navigations with the engine-owned error page, never a
  bare text strand; the SPA and recovery checks all run against
  unlisted sites (no siteconfig rules in this harness).
- Browser APIs: fetch/XHR (same-origin reroute and cross-origin #34
  routing), EventSource, sendBeacon, classic and shared workers
  (prelude, importScripts), localStorage/sessionStorage, document.cookie
  (jar round-trip and upstream Set-Cookie capture), IndexedDB, Cache
  API, the navigator.serviceWorker shim.
- Rewriter: img/src/srcset (including a data URL candidate), CSS url()
  in a linked stylesheet and an inline style block, iframe src, iframe
  srcdoc, base href folding, meta refresh navigation, module-script
  import specifiers.
- Privacy (#32/#34): window.__ZL carries no plaintext destination, page
  surfaces show only engine routes, two virtual contexts stay isolated
  (storage, cookie jar, Cache API names).
- Isolation (#37): window.name is scoped per virtual site (survives a
  reload, empties on the other site, restores on return),
  BroadcastChannel delivers same-site only while .name keeps the
  page's spelling, storage events deliver same-site with
  prefix-stripped keys, cookieStore is absent (removed, not faked).
- Pass-through invariant (#96): the identical probe suite runs
  browser-direct on the fixture origin and engine-proxied, and the two
  records are compared for semantic equivalence - method, request
  body, content-type, Origin stamping, response status and headers,
  Range slices (206 + content-range), conditional GETs (If-None-Match
  -> 304), Set-Cookie round-trip, streaming bytes, abort semantics and
  redirect-follow final content. The contract and its documented
  deviations live in docs/passthrough.md.

## How a browser-direct escape is distinguished from an engine request

1. Canary: fixture `/api/data` sends no CORS headers, so a
   browser-direct cross-origin fetch from the engine page is an
   unreadable CORS error. Reading the body proves the engine served it.
2. Wire log: the engine re-stamps Referer from the real destination
   (forwardedHeaders), so a fixture hit whose Referer mentions the
   engine origin or a `/j/` route was sent browser-direct.
3. CDP: the network capture must show no fixture-origin request that
   was served with `fromServiceWorker !== true`, or that failed with
   no response at all (status 0). An SW-served stream the page later
   aborts (EventSource close) reports `loadingFailed` together with its
   200 - the response did come from the engine, so it is not an
   escape (the gate fails only on positive evidence).

## Honest gaps (not faked)

- WebSocket bridge: skipped. The engine upgrades ws to wss by design
  and the fixture origins are plain HTTP, so the bridge cannot be
  exercised against loopback without a TLS fixture.
- SW restart: not covered yet.
- SVG paint url() attributes (fill/stroke/filter/...): covered by the
  rewriter's Rust unit tests (#36), not here - a browser-side
  computed-style check would only observe the unresolvable-reference
  fallback for an external sprite, not the rewrite itself.
- Real-site behavior: this suite is fixtures-only, on purpose; CI must
  not depend on third-party sites.

## Run locally

```
cargo build -p zeolite-server --release
cd app && npm install && npm run build && cd ..
cd suite/e2e && npm install && npx playwright install chromium && cd ../..
node suite/e2e/e2e.mjs
```

The script exits non-zero on any failed check and prints the engine
server's output tail for diagnosis.

# Torture battery (issue #92)

`suite/e2e/torture.mjs` is the dedicated compatibility torture suite:
web-semantics probes (not just "does it 200") that run the SAME probe
browser-direct on the fixture origin and engine-proxied, then compare
the two records. It boots its own engine + fixtures and runs as its
own CI step right after the #35 suite.

## Cause classes

Every check declares the compatibility category a failure implicates,
so a red run names the broken layer. The classes and what they mean:

- `interception` - the request seam: methods, bodies, content-type,
  Authorization, multipart forms, data:/blob: URLs.
- `routing` - the engine route: unicode/percent-encoded paths,
  double-encoded queries, 2 KB paths.
- `transport` - wire semantics: gzip bodies, ~1 MiB chunked bodies,
  slow TTFB, 204/418/500 status preservation, the 301/302/303/307/308
  method+body table, and redirect chains (5 hops inside the engine
  cap, 15 hops across it - the engine surfaces the 11th hop with a
  mapped Location and the browser re-enters the engine).
- `rewriting` - the streaming rewriter: the torture HTML page
  (CRLF inside a tag, unquoted and padded attributes, a unicode src,
  srcset, iframe, relative anchor), CSS @import + multiline url() +
  @font-face, the JS string-literal URL pass.
- `isolation` - virtual-origin behavior: cookie set/delete lifecycle,
  the pinned Secure-cookie divergence (see below), cross-origin
  preflight vs same-virtual-origin.
- `browser-limitation` - documented gaps PINNED by asserts: a change
  in the pinned behavior is caught, not silently absorbed.

## NativeTransit vs RewriteFallback

The fetch/XHR-shaped probes exercise the NativeTransit pass-through
path (whose contract the #35 suite's #96 check enforces in detail);
the torture-page probes exercise RewriteFallback (the streaming
rewriter). Both classes are represented per the issue's acceptance
criteria.

## Pinned deviations (asserted, never papered over)

- Secure cookies: the DIRECT browser treats 127.0.0.1 as trustworthy
  and sends Secure cookies over plain http; the engine jar honors the
  Secure attribute against the real target scheme, so an http target
  never carries one. Both are correct per their own rules; the check
  asserts the divergence itself.
- Runtime-concatenated URLs: `pre + "img.png"` is invisible to every
  static rewrite pass; the assembled relative URL resolves against the
  opaque engine route and fails closed (404), never escaping
  browser-direct. Pinned.
- `location.pathname` is LegacyUnforgeable: the page keeps seeing the
  opaque engine route. Pinned so any future virtualization change
  (which must not leak destinations per #32) trips CI.

## Machine-readable output

The run ends with per-category pass/fail counts and failure names on
the `== E2E-JSON ==` line, e.g.

```
== E2E-JSON == {"suite":"torture","passed":17,"failed":1,"categories":{"transport":{"passed":6,"failed":1,"failures":["..."]}}}
```

CI greps `[FAIL]` lines into `::error::TORTURE` annotations. Adding a
regression test is one more `check(category, name, fn)` call - no
infrastructure redesign (issue acceptance).

## Honest gaps (not faked)

- WebSocket: needs a TLS fixture (the engine upgrades ws to wss by
  design); same gap as the #35 suite.
- IDN hostnames: need a real domain; the fixtures are loopback IPs.
- Downloads: the #90 registry is unit-tested; a fetch-shaped
  attachment is just another body probe, and a UI-observable download
  harness would be a new scope.
- SW restart group: same as the #35 suite, not covered.

## Run locally

Same prerequisites as the #35 suite, then:

```
node suite/e2e/torture.mjs
```

(The two suites bind the same ports, so run them sequentially.)
