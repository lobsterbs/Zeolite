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
