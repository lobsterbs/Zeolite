# Zeolite worker + service worker virtualization (1.6 Hydride)

How the engine keeps workers working inside a proxied page, without
ever hacking around browser security limits.

## Worker scripts get a prelude

The service worker intercepts worker script loads (request destination
`worker` / `sharedworker`). For those responses it prepends one chunk
- the compiled `worker-prelude.js` - before the upstream body, with
the live route prefix baked as a global and one init line appended
after the module source:

- `self.__ZL_PREFIX__`: the live route prefix (rotations included);
- `self.__zlPreludeInit(<route>)`: called once with the worker's own
  engine route (encodeDest of the upstream script URL).

The prelude decodes that route and keeps the real worker URL in a
closure: since #32 no `__ZL_WORKER_URL__` global exists, so no worker
script can read the upstream URL it was loaded from. The prefix stays
a global - it is the engine's own route shape, not a secret.

The prelude then:

- **routes `importScripts()`** through the engine codec. A raw
  cross-origin `importScripts` would load the upstream script directly
  (script loads need no CORS) and its own subresource fetches would
  fail; routed arguments load through the transport like any other
  engine request.
- **bridges dedicated-worker `WebSocket`** over `self.postMessage` to
  the parent page, which relays the port to the engine's existing
  `zl:wsOpen` seam (1.3). Event semantics match the page shim, so
  reconnecting libraries keep working.

Streaming is preserved: the prelude is one extra first chunk; the
upstream body is piped through, never buffered.

### Limits (honest)

- **SharedWorker `WebSocket` stays native.** A shared worker has no
  single parent page to relay through; the prelude still routes its
  `importScripts`.
- **Module workers** get no prelude behavior (`importScripts` does not
  exist); their import specifiers were already rewritten by the
  rewriter's JS passes when the script was served.
- `navigator.serviceWorker` inside a worker is untouched (it does not
  exist there in the browser either).

## navigator.serviceWorker shim

A browser allows exactly one real service worker per scope, and the
engine owns this scope. A proxied page's `navigator.serviceWorker` is
therefore virtualized by `app/src/swshim.ts` + bootstrap wiring:

- `register(scriptURL, { scope })` records a per-origin registration
  (site-scoped storage, same `zl:<sitehash>:` isolation as everything
  else) and returns a live registration whose worker settles
  `installing -> activated` across microtasks.
- `getRegistration` / `getRegistrations` / `unregister` / `update` /
  `ready` are shape-compatible; `ready` never hangs (it resolves with
  a synthetic registration when nothing was registered).

### Limits (by design, not accidents)

- No virtual worker script is ever fetched or executed.
- No `fetch` / `message` events reach a virtual registration; pages
  that rely on a real SW controlling them will not get that behavior.
- `controller` stays the engine's real worker.
- The fake states skip the real `installed`/`activating` waiting
  periods.

These are browser security limits, documented rather than hacked
around.
