# Virtual service workers, phase 2 (design)

Issue #257. A design document, not shipped behavior: no target
worker code execution work starts before this model is reviewed.

## Where phase 1 stands

The 1.6 shim (app/src/swshim.ts, wired by bootstrap/relay.ts)
virtualizes navigator.serviceWorker as per-origin records: register
stores one record per site storage partition, the fake worker
settles installing to activated across microtasks, getRegistration
and unregister are shape-compatible, and ready never hangs. No
worker script is fetched or executed, no fetch or message events
exist, and the page's controller stays the engine's real worker.
Covered by the shim suite in app/src/__tests__/worker.test.ts.

The cost of that honesty is compatibility: apps that rely on a
service worker for offline caching, lifecycle events, messaging or
update handling stay broken. Phase 2 specifies how far the
emulation can be extended without lying about what it is.

## The honest boundary

A browser allows exactly one real service worker per scope, and
the engine owns the engine scope. Phase 2 does not claim
native-equivalent origin security; everything below is an
emulation boundary and is documented as one. Two consequences
drive the whole design:

- registration identity is namespaced by virtual site, never by a
  shared-origin URL prefix, so one site can never capture another
  site's requests through scope shapes;
- the page's controller cannot honestly change: the real
  controller of every engine page is the engine worker itself.

## #477 P0 registration groundwork (PR #480)

A pure, bounded, **non-executing** registration identity registry lives in
`app/src/kernel/guests/registration.ts`. It uses full canonical virtual
origin + scope as the key (never a short hash), rejects cross-origin scripts
and scopes, path-ambiguous encoded separators, query/fragment scope input,
and invalid persisted registrations. Longest-prefix matching requires an
already-verified owner page origin, not a user-supplied identity. Its records
hold only `origin`, `scope` and `scriptURL`; they cannot execute code,
fetch a guessed script or access the engine's storage or control ports.

The legacy single-registration shim can reuse the canonical validation
helpers while retaining its existing non-execution behavior. This groundwork
does **not** implement the multiple-scope persistent registry, worker lifecycle,
isolated guest realm or synthetic fetch dispatch in a live browser. Browser
behavior and threat-model review remain required before activating any guest
execution. Never execute a guest inline in the engine Service Worker global;
a mere `self` facade cannot isolate `globalThis`, constructors or an infinite
loop. Untrusted worker code stays disabled.

## #477 capability probe verdict (observed, real Chromium)

Probe: suite/e2e/sw-capability.mjs (Playwright, dedicated fixture
server, a bare registered service worker; committed with this change).
Facts observed in the service worker global: Worker and SharedWorker
are UNDEFINED. importScripts, eval, Function, OffscreenCanvas,
WebAssembly, setTimeout, caches, indexedDB and WebSocket are available.

Consequence for the stage-2 sandbox: the plain dedicated Worker on the
engine origin in the model below cannot be created BY the engine
service worker, because the service worker global exposes no Worker
constructor at all. The only execution surfaces inside the service
worker (eval, Function, importScripts) run in the kernel own global
with no enforceable termination, which gate 2 forbids. Guest execution
therefore stays unsupported on this platform. P4 (worker-per-guest) is
likewise blocked from the worker side: the creator must be a page
context on the engine origin, bridged to the service worker, which is
a kernel architecture decision, not a shim change. Until that decision
is made and reviewed, untrusted guest execution stays disabled.

## #477 P1 facade fidelity, native shape (observed)

Native ServiceWorkerRegistration, captured from the same live
registration in real Chromium: scope, updateViaCache, installing,
waiting, active, update(), onupdatefound, unregister, navigationPreload,
showNotification, getNotifications, pushManager, sync, periodicSync,
backgroundFetch, cookies, paymentManager. The probe also confirms
controller === active and that controllerchange fires on claim. The
phase-1 VirtualRegistration ships scope, installing, active and
unregister. The S1 gaps are waiting, update(), onupdatefound and
updateViaCache; each addition is paid from the strict bootstrap byte
budget, so shipping them is a budget decision, not a mechanical fix.
controller, controllerchange, onmessage and ready stay the real
container own surface (the engine worker is the controller); the shim
intentionally does not fake them.

## Registration identity and scope mapping

Registration key: (site id, canonical scope). The site id is the
same per-site partition identity (zl:<sitehash>:) that storage and
cookie jars already use. The canonical scope resolves against the
registering page's virtual URL and clamps to that page's virtual
origin, exactly as phase 1 scopeFor does today.

Matching rule: a request or a page carries its virtual context
(site id plus URL); a registration matches only when the site id is
equal and the canonical scope is a path prefix. Two sites can
register the same scope path and never see each other, because the
site id is part of the key: a cross-site URL-prefix match is
structurally impossible, not merely filtered.

Phase 1's defense in depth (a record that scopes a foreign origin
is ignored even if it lands in this store) is kept and extended to
the full key.

## Phase 2 feature matrix

Stage column: S1 = non-execution semantics, shippable first; S2 =
sandboxed execution, gated on review of this document; N = not
supported, kept honest.

| Feature | Stage | Notes and limits |
| --- | --- | --- |
| register / getRegistration(s) / unregister | S1 | Already virtual since 1.6; S1 keys the store by (site, scope) so multiple scopes per origin work. |
| registration.update() | S1 | Re-fetches the script URL through the transport and compares stored validators and length; updatefound fires on a real change, never fabricated. |
| state machine and statechange | S1 | Native-shaped installing / installed / waiting / activating / activated with real waiting periods instead of the microtask settle; statechange events fire on transitions. |
| ready | S1 | Already resolves; S1 keeps it pending while a registration for the scope is installing, matching native. |
| controller / controllerchange | N | The real controller is the engine worker. A virtual claim would mislead page code into trusting a controller that does not exist. |
| page to worker messaging | S2 | A MessageChannel relay to the sandbox. Without executed code there is no receiver, so S1 ships no fake message events. |
| fetch event routing | S2 | Longest-prefix match over (site id, scope) inside the sandbox request path; a virtual fetch handler sees only requests of its own site. |
| install / activate / skipWaiting / clients | S2 | Emulated with hard budgets: waitUntil is bounded, clients.claim reaches only pages of its own site. |
| Cache API (caches) | S2 | Per (site, scope) partition inside the site storage partition, quota-bounded, separate from the engine page cache. |
| push / BackgroundSync / PeriodicSync | N | Requires real browser infrastructure the engine cannot emulate honestly. |

## Execution sandbox model (stage 2)

- The virtual worker executes as a plain dedicated Worker on the
  engine origin, created from an engine-owned bootstrap blob. It
  is never registered as a real service worker against the shared
  engine scope.
- Globals exposed: a virtual self.registration, an emulated
  clients surface, the partitioned caches, and a fetch that rides
  the same transport and policy pipeline (SSRF policy, header
  surgery, cookie jar, netLog) as page traffic, carrying the
  site's identity.
- Never exposed: engine control messages (the zl: channel is
  filtered at the relay), engine storage, other virtual origins,
  host client APIs.
- Budgets: install, activation and per-event deadlines. A budget
  overrun or an event-loop stall terminates the worker and marks
  the registration broken; the state stays honest, no fake
  activated.
- Teardown: unregister and incognito teardown terminate the
  worker and drop the (site, scope) cache partition.

## Threat model

- Cross-site scope confusion: impossible by key construction. A
  hostile site registering a scope that prefixes another site's
  paths gains nothing: requests match only within their own site
  id, and canonical scopes never cross the registering virtual
  origin.
- Privilege escalation: worker code sees only the virtual
  surface. The engine's own fetch, credential and control seams
  are not reachable from the sandbox; worker fetches never bypass
  the policy pipeline.
- Cache and storage leakage: virtual caches live in the per-site
  storage partition, never in the engine page cache or host
  storage; quotas bound one site's footprint.
- Hostile worker code: CPU and memory (budget termination of the
  isolated worker), message flooding (bounded queues), fetch-based
  exfiltration (same policy as page traffic, so nothing
  engine-internal is reachable), denial of service against the
  engine (site code runs in its own Worker thread, never inline
  in the engine's service worker).

## Staged plan

1. Stage 1, non-execution: the S1 rows above, with deterministic
   browser tests extending the worker.test.ts shim suite
   (registration, update compare, state transitions, ready
   semantics) and a suite/e2e run for the bootstrap wiring.
2. Review gate: this document and the sandbox routing model.
3. Stage 2, execution: the sandbox, fetch routing, caches and
   messaging, behind the budgets listed above.
4. Stage 3, lifecycle parity: skipWaiting, clients, quotas and
   teardown polish.

## Explicitly unsupported semantics

- controllerchange and a site-owned navigator.serviceWorker
  controller: the engine worker is the controller of every page
  it serves.
- Any claim of native-equivalent origin security inside one
  shared engine origin.
- One real registration per scope shared across virtual sites:
  impossible by browser design and not emulated.
- push notifications, BackgroundSync and PeriodicSync.

The emulation boundary is the contract: what is not listed as
supported stays visibly absent rather than silently faked.

## Wave 1 decision: guest execution via a page-created Worker

Issue #477. Decision recorded 2026-10-27, implemented on branch
fix/html-bom-478. The isolation gate settled it: the engine's
service worker cannot create any realm of its own
(ServiceWorkerGlobalScope exposes no Worker constructor, proven by
suite/e2e/sw-capability.mjs), so the only proven-isolated,
terminable realm available to the engine is a DedicatedWorker
created by a page context on the engine origin.

Mechanism, as shipped:

- app/guest-host.html is an engine-served page the embedding
  application keeps open, the same pattern as the zlsw-register
  page. It never runs guest code itself.
- The page sends the host-only control message zl:guestHost to the
  engine worker with one end of a MessageChannel; the kernel
  (app/src/kernel/guests/executor.ts) registers it as its guest
  host port. The kind is deliberately absent from PAGE_MESSAGES,
  so proxied pages cannot send it.
- Spawn (zl:guestSpawn, host-only) validates the registration
  identity through canonicalGuestRegistration, caps the script
  body at 256 KiB, wraps it in a harness prelude, and asks the
  host page to build a Worker from a blob. The host transfers one
  MessagePort into the worker and reports zl:guestSpawned,
  zl:guestSpawnFailed, zl:guestError and zl:guestTerminated back.
- The kernel never touches the guest realm directly: install and
  activate are dispatched on the guest port in that order, guest
  messages route through an injectable listener, and a terminate
  request is confirmed by the host before the record is dropped.
- Dead handshakes are reaped lazily on the next kernel interaction
  against a 10 s deadline; no timer runs inside the kernel.

Honest deviations of wave 1, all deliberate:

- Guests are network-blind: fetch, XMLHttpRequest, WebSocket and
  importScripts are shadowed to undefined at spawn. Guest fetch
  routing is stage 2 of the staged plan above, not started.
- Guests receive no kernel storage handles: caches and indexedDB
  are shadowed to undefined.
- No fetch events are dispatched to guests; the engine owns
  interception.
- controllerchange and push remain unsupported, as listed above.
- waitUntil is accepted and not awaited.
- The spawn trigger is a host-only control message: the
  proxied-page register capture (routing a page's
  navigator.serviceWorker.register to a guest spawn) is a later
  phase; the shim stays virtual-only.
- The registration facade stays honest: update() rejects,
  unregister routes to the kernel, getNotifications returns an
  empty list.
