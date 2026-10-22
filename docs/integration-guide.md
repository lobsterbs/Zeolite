# How to correctly integrate Zeolite

This document is the integration guide for hosts that embed the Zeolite
engine (current release: 3.0 Diamond). It defines the full integration
contract: what the host must provide, what the engine expects, what the
host must never do, and a verification checklist to run after wiring
everything together. LobsterBrowse is the reference host; every rule below
is either implemented there or documents a known gap there (marked as such).

Related documents: `engine-adapter.md` (the embed contract and engine adapter
API), `policy.md` (the rules engine), `interception.md`, `limitations.md`,
`transport-lifecycle.md`, `session.md`, `versioning.md`.

## Prerequisites

- Chromium 91 or newer on the client. The engine service worker is an ES
  module; Firefox has no module service worker support.
- The engine bundle, taken from the `dist` branch: `sw.js`, `bootstrap.js`,
  `codec.js`, `worker-prelude.js`, the rewriter wasm, `devtools.html` and
  the vendored transports (`libcurl/`, `epoxy/`).
- A server on the origin that will host the engine, able to serve those
  files with the headers described below.
- A transport: either a Wisp v2.1 endpoint (`zeolite-server` crate) or a relay
  endpoint on your host server (or both).

## The contract in one page

A correct integration provides, in this order:

1. An origin the engine service worker owns, with the bundle served under
   the correct headers (section 1).
2. Engine data files reachable at the origin root: `/policy.kdl`,
   `/rules.kdl`, `/siteconfig.kdl` (section 1).
3. Worker registration at application boot, not per view or per tab, with
   re-registration on `controllerchange` (section 2).
4. A working transport: a wisp endpoint and/or a relay endpoint, with the
   shipped `policy.kdl` routing traffic onto it (section 3).
5. A `zl:config` push (route prefix and behavior toggles) verified with
   `zl:ping` (section 4).
6. Navigation through the handle flow, not plaintext target URLs
   (section 5).

## 1. Serve the bundle

Serve `sw.js` with two non-negotiables:

- The `Service-Worker-Allowed: /` response header. Without it a script
  served outside the root path cannot register at root scope, and the
  engine must control the whole origin.
- `Cache-Control: no-cache`. A stale worker script means the served bytes
  and the pinned bytes disagree, which defeats the pin oracle (section 8).

Serve the sibling artifacts (`bootstrap.js`, `codec.js`,
`worker-prelude.js`, the rewriter wasm, devtools page) anywhere on the
origin. The wasm transport directories are the exception: they are
resolved at the origin root, not relative to the worker script, so
`/libcurl` and `/epoxy` must be reachable at the origin root.

Serve the engine data files at the origin root: `/policy.kdl`,
`/rules.kdl`, `/siteconfig.kdl`. If your server has an SPA fallback route,
these paths must be aliased before it, or they will return your app shell
instead of engine data.

## 2. Register the worker correctly

Register at application boot:

```js
await navigator.serviceWorker.register("/zlsw/sw.js", {
  scope: "/",
  type: "module",
});
```

Rules:

- `type: "module"` is mandatory. The bundle emits `sw.js` as an ES module;
  a classic registration fails at script evaluation with nothing surfaced
  below the `register()` call.
- Register once per application, at boot. Do not register per tab or per
  view; the worker owns the origin, and re-registering from inside views
  races the first navigation.
- Re-register on `controllerchange`.
- An idle worker restart does not fire `controllerchange`. It drops the
  registered relay port. Re-register the relay on an interval (the
  reference host uses 15 seconds) and answer the engine `zl:relayLost`
  broadcast.
- Since the idle-restart fixes (Zeolite #391) the engine broadcasts
  `zl:relayLost` once on every worker start (a cold wake), so answering
  that broadcast alone re-arms the relay after an idle restart; keep the
  interval as defense in depth.
- Wait for the worker to be ready before the first navigation, then push
  configuration (section 4).

## 3. Wire the transport

The engine supports exactly one protocol natively: Wisp v2.1. Never
reimplement it; mount `zeolite_server::wisp_handler` or run the reference
server.

### Wisp endpoint

Mount the wisp handler (the reference host mounts it at `/wisp/`).
Authentication follows the server key config (`ZL_WISP_ED25519_HEX`),
regardless of which auth extension parsed.

Honest limitation: the shipped wasm wisp client carries no password or
key credentials. If your wisp endpoint requires authentication, every wasm
wisp connection is refused. Either place an unauthenticated endpoint where
network position protects it, or route traffic over the relay. This is why
the reference host runs relay-only.

### Relay endpoint

The relay lets the embedder origin perform fetches with its own network
stack (native TLS) and stream answers back. Wire it in three steps:

1. After worker registration, register a `MessageChannel` port with
   `zl:relayRegister` (host-only message; proxied pages can never register).
2. On that port, answer `zl:fetchRelay` frames:
   `{ type: "zl:fetchRelay", rid, dest, method, headers, body }`.
   Perform the fetch with your own stack, keep your SSRF judgment
   host-side, and stream the answer back over the same port as
   `zl:relayHead {rid, status, statusText, headers, setCookies}`, then
   `zl:relayChunk {rid, bytes}` frames, ending with `zl:relayEnd {rid}` or
   `zl:relayError {rid, error}`.
3. Rate-limit and authorize the server-side endpoint before parsing the
   envelope. The reference host checks `Origin` and `sec-fetch-site`,
   requires a shared token header, rate-limits by client, and caps
   concurrent streams. Its handler (`zl_relay_endpoint`) is the reference
   implementation.

Relay constraints to respect:

- GET/HEAD and string or ArrayBuffer bodies only; a stream body cannot
  ride the port and falls back to wisp.
- The header deadline is the only clock: an embedder that answers beyond
  it resolves the fetch as channel death, and the engine falls back to
  its secondary transport. Never park relayed requests.
- Keep the relay a relay, not a second engine: the engine hands you
  destination, method, headers and body; the fetch decision stays yours.

### Policy routing

`policy.kdl` decides both behavior (rewrite, native) and transport (relay,
wisp). Two rules:

- Put the match-less default rule first. Ties break toward the later rule,
  so a match-less `default-relay` anywhere but first silently wins every
  tie and kills your specific rules.
- Behavior rules compose with transport rules through `transportMatch`:
  a `native` rule alone wins the whole match and dead-ends the load on a
  transport the host cannot use. Ship behavior rules together with a
  transport the engine can actually reach.

Runtime selection: `zl:wispRegister` announces a public wisp endpoint for
policy `wisp` routes, `zl:wispPrimary` switches the primary endpoint
(empty string restores the build-time one). Both persist with the route
shape, so an idle-restarted worker instance restores them.

## 4. Push configuration and verify it

After registration, send `zl:config`:

```js
port.postMessage({
  type: "zl:config",
  prefix: "/zl/",
  navHandles: true,
  queryRoutes: true,
  httpsUpgrade: true,
  imageLazy: false,
});
```

- `prefix` sets the route shape. The default is `/j/`. The scheme is b64u
  only; anything else is refused. The prefix persists, so a worker
  restart keeps it, but a storage wipe reverts to defaults.
- Probe `zl:ping` and compare the returned `prefix`, `navHandles`,
  `queryRoutes`, `httpsUpgrade` and `version` against what you pushed.
  On mismatch, re-push. This is the only reliable detector of a reverted worker.
- The route prefix is per-origin state. Each origin worker needs its own
  `zl:config`. The codec accepts the reserved `zl` route segment regardless
  of the configured prefix, so legacy decode keeps working while you
  unify, but every route that origin mints reads the default prefix until
  its worker receives the config push.
- Never place a plaintext destination in a page-visible URL. The mirror
  scheme is gone for this reason; do not reintroduce destination text in
  routes, query strings or fragment identifiers.

## 5. Navigate with handles, not target URLs

The legacy `?url=<target>` embed puts a plaintext destination in a
browser-visible URL and is on a deprecation path. Use the handle flow:

1. Send `zl:config { navHandles: true }`.
2. Ask the worker for a handle: `zl:navHandle { dest }`. The message is
   host-only by the sender gate; a proxied page can never mint handles.
3. Navigate to the answered `/__zl_navh__/<token>` route. Expired handles
   re-mint on GET navigations; a parent parked on the opaque prel form
   is answered with a same-origin redirect to the visible handle form.
4. With `queryRoutes: true` the answer is the query shape instead:
   `<real path>?<real query>&zlNavh=<token>`. The committed pathname
   is the real destination path, so native `location.pathname` reads
   work without any shim (the LegacyUnforgeable fix). Destinations
   whose paths collide with engine-internal paths keep the NAVH form.

### The committed-URL constraint (read this twice)

`window.location`, `window.top`, `window.parent`, `document.URL` and
`document.referrer` are LegacyUnforgeable in Chromium. No Proxy and no
`defineProperty` shim can intercept reads of them. Pages that route on
`location.pathname` (SvelteKit routers, single-page apps) see the opaque
engine route, not the virtual upstream path. Two consequences:

- Runtime shimming of those surfaces is impossible by platform design,
  not by missing effort. Route-state work must start from the committed
  URL shape, not from shim optimism.
- Anchor href surfaces (`HTMLAnchorElement.prototype`) ARE shimable.
  Virtualizing what page code reads from anchors is a separate, legal
  shim layer. Keep the two classes apart when designing location work.

## 6. Respect the control plane

All control traffic uses `zl:` verbs over `MessageChannel` ports. The
sender gate is fail-closed:

- A client counts as a host page only when its pathname is one of
  `/`, `/index.html`, `/devtools.html`, `/zlsw-register`, same-origin.
- Everything else (about:blank, blob:, cross-origin, unparseable) is
  treated as untrusted and receives only the page-facing set:
  `zl:mint`, `zl:docCookie`, `zl:wsOpen`, `zl:ext`, `zl:ping`,
  `zl:getVirtualOrigin`, `zl:getEmbedder`, `zl:decodeRoutes`.
- Host-only verbs include: `zl:config`, `zl:ping`, `zl:navHandle`,
  `zl:relayRegister`, `zl:wispRegister`, `zl:wispPrimary`, `zl:getNetLog`,
  `zl:getDiag`, the extension verbs (`zl:listExt`, `zl:installExt`,
  `zl:installExtFiles`, `zl:extEnable`, `zl:extUninstall`, `zl:scripting`),
  the jar verbs (`zl:jarProfile`, `zl:getJars`, `zl:clearJar`),
  `zl:fingerprint`, the download verbs, `zl:recordStart`, `zl:recordStop`,
  the session verbs and `zl:teardown`.

Do not fight the gate. Put your host pages on the allowlisted paths, and
never rely on a proxied page being able to send host verbs.

## 7. Split-origin hosting (optional)

For host isolation, run the engine bundle on a second origin (a content
origin) and keep your UI on the first:

- Embed the content origin `/zlsw-register` boot page in a hidden
  iframe and keep it embedded forever. The boot page registers that
  origin relay, wisp and embedder state through the `zlRegAsk`
  handshake; the sender gate allowlists its path exactly for this.
- The boot page answers `zl:getEmbedder` for embedded frames with the
  registered embedder origin and the client-decoded virtual URL, and the
  bootstrap `embedsync` module posts navigation, URL and title updates
  to the parent.
- Route keys are per-origin in the engine storage. A handle minted on one
  origin cannot decode on another origin worker. Each origin mints its
  own handles.

Honest gaps to document for your users: cookie jars are per-origin
(logins do not carry over), there is no in-frame console capture for
cross-origin frames, extensions do not ride content-origin pages, and
DevTools document access is limited to the app origin.

## 8. Pin the bytes and verify them

Pin by dist commit. The reference host Dockerfile carries:

- `ARG ZEOLITE_COMMIT=<dist branch sha>`
- `ENV ZEOLITE_SW_SHA=<first 16 hex of sha256 of sw.js>`
- the bootstrap sha likewise, plus a pin comment documenting the payload.

Verification rules:

- After every deploy (with cache clearing), fetch your version endpoint
  (the reference host uses `/build`) and check that the reported worker
  hash equals the pinned `ZEOLITE_SW_SHA`. The served bytes are the
  oracle; container layer caches silently re-serve old tarballs.
- A docs-only engine push still republishes dist and changes the dist
  commit. Hash the new `sw.js` before bumping the pin: identical bytes
  mean no pin bump or redeploy is needed.
- Never land half a pin. The pin comment, the deploy docs and the live
  version endpoint must all agree before you call the integration
  correct.

## 9. What an integration must never do

- Never reimplement Wisp. Mount the crate.
- Never buffer a full document: the rewriter streams; time-to-first-paint
  is the primary metric.
- Never place a plaintext destination in a page-visible URL.
- No headless-browser fallback, no login or interstitial bypass, captcha
  is detection only.
- Do not fake extension APIs: unimplemented namespaces stay absent so
  feature detection stays honest.
- Do not register the worker per view, and do not mint handles from page
  context.
- Do not let the relay grow into a second engine.

## 10. Verification checklist

Run this after integrating and after every pin bump:

1. The version endpoint reports the pinned worker hash (section 8).
2. `zl:ping` answers your pushed `prefix` and `navHandles`, `degraded` is
   false, and `version` is the expected release.
3. A first navigation renders through the engine: the net log shows the
   relay or wisp transport engaged, no direct fetches from the page.
4. The relay channel survives an idle worker restart: the engine
   cold-wakes with a `zl:relayLost` broadcast at every worker start
   (#391), and your listener or interval re-register re-arms the relay
   before the deadline.
5. A proxied page sending `zl:config` is refused by the sender gate.
6. In split-origin mode, both origin workers report the pushed prefix.
7. Recovery candidates and filter-list fetches ride the same transport
   decision as normal traffic (never a dead secondary transport).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| register() resolves but the engine never controls the origin | classic registration, missing `type: "module"` | pass `type: "module"`; a classic evaluation error surfaces nowhere |
| 502 tls handshake eof on every upstream fetch | the wisp endpoint requires auth the wasm client cannot present | route `default-relay` first in `policy.kdl`, or expose an unauthenticated wisp endpoint |
| Routes render as `/j/...` on your origin | `zl:config` never reached the worker (register-before-config race, or wrong origin worker) | wait for registration, re-push, verify with `zl:ping` |
| Version endpoint reports a stale worker hash after deploy | container layer cache re-served the old tarball | deploy with cache clearing; the served hash is the oracle |
| A host page throws on a strict URL sanity check before fetching (loader classes that validate generated URLs) | the rewriter tokenized a string literal the loader validates | add a `native` behavior rule for that host; the transport rule still routes the fetch |
| Second origin decodes nothing on app-minted routes | route keys are per-origin | mint on the origin that navigates; never share handles across origins |

## Known open gap in the reference host

LobsterBrowse runs split-origin hosting but pushes `zl:config` only to
the app origin worker. The content origin worker keeps the default
`/j/` prefix, so routes minted on content-origin pages read `/j/` in
page-visible surfaces while the app origin mints `/zl/`. The codec
legacy-segment fallback keeps decode working, so the gap is cosmetic
today, but it violates section 4 (per-origin config) and is tracked as
the prefix-unification work item. Measure route-shape fallout with the
planned differential suite before unifying prefixes on live traffic.