/* Zeolite service worker: fetch interception, header surgery,
   streaming rewriter, wisp transport, SiteConfig rules, plugin
   hooks, netLog. Engine-local routes under a rotatable prefix
   (default /j/, zl:config since #17; scheme fixed "b64u" since
   #32). Engine assets (sw.js, bootstrap.js, devtools, ...) and the
   wisp endpoint pass through untouched; prefix/scheme decisions go
   through ./codec (was hardcoded here).

   Control plane (postMessage, replies on the given port):
     zl:config prefix | zl:mint dest | zl:navHandle dest
     zl:rules ua rules | zl:jarProfile profile | zl:siteRoute
     site enabled | zl:teardown | zl:getNetLog since cursor
     zl:tracing enabled | zl:wsOpen url protocols
     zl:docCookie set | zl:fingerprint profile
     zl:recordStart recId | zl:recordStop
     zl:find dest cmd pattern options | zl:ping (replies
     { ok, version, degraded, prefix, scheme })
     zl:spa404 (page own-404 watcher report, #456 gate 4)
     zl:sameSite policy | zl:importSession mode rule
     zl:getJars | zl:clearJar profile origin
     zl:downloadState id status | zl:listMenus extId
     zl:loadState host (loading indicator poll)
     zl:relayRegister port (embedder fetch relay, #137); #354: zl:relayLost broadcast asks the embedder to re-register after an idle restart
     zl:wispRegister url (public wisp endpoint for route "wisp", #168)

   Host-only gate (#41): proxied pages are SW clients too, so
   control messages are host-only; a proxied document may send only
   its own page-facing messages (zl:docCookie, zl:wsOpen, zl:ext,
   zl:ping).

   The rewriter wasm (wasm-bindgen output of crates/rewriter) is
   emitted by the build pipeline to src/rewriter_wasm/. */

/// <reference lib="webworker" />
import { jarLoad } from "./cookies";
/* #90: the download registry (DL) lives in ./downloads; the boot
   below restores it and the request engine calls adoptResponse. */
import { DL } from "./downloads";
/* #89: the network inspector ring lives in ./netlog; the boot stamps
   the generation and the request engine / control plane push rows. */
import { stampNetGeneration } from "./netlog";
import { initTransport, wispTransport } from "./transport";
import { configureGhostery } from "./ghostery";
/* #86: the streaming rewrite pipelines + wasm rewriter lifecycle
   live in ./transform; this entrypoint wires the state seam and
   prewarms the rewriter wasm on install. */
import { initTransform, prewarmRewriter } from "./transform";
/* #243-#247: client isolation, install lifetime, phased extension
   boot and dispatcher wiring live in ./lifecycle; this entrypoint
   is the composition root only. */
import { bootExtensionSubsystem, installLifecycle, raceBoot, wireDispatchers } from "./lifecycle";
/* #87: the shared service-worker runtime state (degraded flag, route
   key, fingerprint scripts, per-site profile cache) lives in
   ./swstate; this entrypoint and the request engine are call sites. */
import { getFpScript, getRouteKey, isImageLazy, setEngineDegraded, siteProfileFor, ZEOLITE_VERSION } from "./swstate";
import { ALARMS, MGMT, TABS, SCRIPTING, DOWNLOADS, NOTIFY, ACTION, PERMS, bootEnabled, extensions, wakeExtension } from "./extensions";

import { messageListener } from "./control";
/* #82: the request engine (route decode, page cache, upstream hop
   chain, header surgery, rewrite branches, navigation strands) lives
   in ./request.ts; this module is the entrypoint and composition
   root: it boots the runtime and wires browser events to the engine
   and the control plane. */
import { ghosteryListFetch, handleFetch, initEngine, persistRoute, routeReady } from "./request";
/* CORP parity for COEP embedders: withCorp (./corp) opts every
   engine-served response into cross-origin embedding at the
   respondWith seam, so a split-origin host that runs COOP/COEP
   on its top document can embed the content-origin frames. */
import { withCorp } from "./corp";
/* #121: engine-update alerting (update poll + activation broadcast)
   lives in ./updates; this entrypoint owns the worker lifecycle
   seams that call it. */
import { broadcastEngineUpdate, startUpdateChecks } from "./updates";

declare const self: ServiceWorkerGlobalScope;

/* ---- HTTP over wisp ----------------------------------------------- */
/* Phase 1: libcurl wasm transport (BareMux-compatible), the same proven
   TLS-termination path ScramJet uses. The vendored bundle is loaded by
   src/libcurl-transport-vendored.ts. Both this module and the loader use
   STATIC imports only: dynamic import() is not available on
   ServiceWorkerGlobalScope in Chromium, and a dynamic import here used
   to kill every proxied fetch with a ReferenceError from vite's
   preload helper. Until the CI vendoring step runs, calls throw and
   the suite records transport-missing. */

/* #84: the wisp/libcurl transport lifecycle (init, connect-class
   reset + single retry, engine switch) moved to transport.ts; sw.ts
   depends on the Transport interface. The degraded-flag seam keeps
   reporting init failures to zl:ping exactly as before (finding 5:
   the flag itself lives in ./swstate). */
initTransport({ setDegraded: setEngineDegraded });
/* #381: Ghostery's subscription fetches ride the same transport
   decision as page traffic (relay included): the raw wisp client
   is auth-refused on relay-only embedders, so remote lists
   silently never loaded. Global fetch stays forbidden: it would
   expose the user's direct network address to the filter-list
   hosts. */
configureGhostery((input, init) => {
  const dest = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return ghosteryListFetch(dest, init);
});

/* #86: the streaming rewrite pipelines + wasm rewriter lifecycle
   moved to transform.ts. */
initTransform({
  routeReady: () => routeReady,
  routeKey: () => getRouteKey(),
  fpScript: () => getFpScript(),
  siteScript: async (base) => (await siteProfileFor(base))?.script ?? null,
  setDegraded: setEngineDegraded,
  lazyImages: isImageLazy,
});


export { ZEOLITE_VERSION };
console.info("[Zeolite] runtime " + ZEOLITE_VERSION);

self.addEventListener("install", (e) => {
  /* Prewarm: instantiate the rewriter wasm during install, not on the
     first HTML response (instantiation is the slowest cold-path step).
     #244: the async prewarm is held by waitUntil (./lifecycle). */
  installLifecycle(e, prewarmRewriter);
});

/* Restart-safe engine init (runs once per worker evaluation). A
   terminated worker restarts by re-evaluating this module WITHOUT a
   new install/activate pair, so activate-only init left every
   restart with an empty extension registry, an empty cookie jar,
   unwired tabs/scripting/downloads/notifications dispatches and
   unwoken alarms: installed extensions looked missing, menu
   listings went stale, and host notification broadcasts were
   dropped silently. Everything below is idempotent, so it runs here
   instead of in activate; consumers that need the restored state
   await initReady (the fetch handler and the control plane). */
const initReady = (async () => {
  /* Generation stamp per worker evaluation: a restart resets the
     netLog ring, and the devtools delta-sync resets on it. */
  stampNetGeneration();
  /* 1.4 Boride: restore the persisted cookie jar. Storage failure
     means an in-memory jar, never an init failure. */
  try {
    await jarLoad();
  } catch {
    /* in-memory jar only */
  }
  /* 2.2 Arsenide: restore the persisted download registry. Entries
     that were active across the restart are honestly marked
     interrupted by the load itself; #118: paused entries restore
     with their stored partial bytes and stay resumable. */
  try {
    await DL.load();
  } catch {
    /* in-memory registry only */
  }
  /* #118: the download resume path issues its Range request through
     the engine transport; the wisp tunnel relays the header
     end-to-end (the seam test pins that it is sent). */
  DL.setResumeFetch((url, init) => wispTransport.fetch(url, { method: "GET", headers: init.headers }));
  /* Extensions: load the installed set, then boot enabled
     background scripts. #245: independent phases - a failed registry
     restore or boot no longer silently skips alarm wake wiring and
     management wiring; each failure lands in DIAG (./lifecycle). */
  await bootExtensionSubsystem({
    startup: () => extensions.startup(),
    boot: () => bootEnabled(),
    /* Alarms wake MV3 backgrounds through the background module;
       management events observe the manager's lifecycle stream. */
    wireAlarm: () => ALARMS.setWake(wakeExtension),
    wireMgmt: () => MGMT.wire(extensions),
  });
  /* #243: tab/download/notify ops reach host clients only; a
     tabs.sendMessage or scripting payload reaches only the client
     whose decoded destination matches the target (an unmatched
     scripting payload is dropped, never broadcast to proxied
     pages). Wiring lives in ./lifecycle. */
  wireDispatchers({ tabs: TABS, scripting: SCRIPTING, downloads: DOWNLOADS, notify: NOTIFY, action: ACTION });
  /* Advanced permissions: request/remove run through the manager
     so grants persist and the master record stays authoritative. */
  PERMS.setBackend(async (id, op, perms) => {
    const rec =
      op === "grant"
        ? await extensions.grantOptional(id, perms)
        : await extensions.revokeOptional(id, perms);
    return rec ? { permissions: [...rec.permissions], origins: [...rec.hostPermissions] } : null;
  });
})();


/* #82: the request engine awaits the same boot promise the control
   plane does; injecting it keeps the engine importable without the
   worker entrypoint (and lets the engine own its lifecycle seams). */
initEngine(initReady);
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      /* #121: the freshly-activated worker announces itself to every
         window client (proxied pages get a console note + window
         CustomEvent once per engine sha, never a reload; the
         embedding host's own window can surface the alert). After
         claim, so matchAll sees the claimed clients. */
      try {
        await broadcastEngineUpdate();
      } catch {
        /* best-effort: the notice guard is idempotent, a dropped
           broadcast costs one update cycle */
      }
      /* Warm the transport so the first proxied request skips libcurl
         init. A missing vendored build just logs, as before. */
      try {
        await wispTransport.ready();
      } catch {
        /* transport-missing: the suite records it, as before */
      }
    })(),
  );
});
/* #121: long-lived tabs never run the browser's navigation-time
   update check, so the active worker polls registration.update()
   itself (the browser's own byte-compare oracle). */
startUpdateChecks();

/* #82: pure wiring - the request lifecycle is the engine's. The
   event is proxied so every respondWith call site inside
   handleFetch gets funneled through withCorp without touching the
   engine's internal branches (redirects, rewrite streams, honest
   error pages, cache hits). */
self.addEventListener("fetch", (e) => {
  handleFetch(
    new Proxy(e, {
      get(target, prop) {
        if (prop === "respondWith") {
          return (r: Response | Promise<Response>) => {
            void target.respondWith(Promise.resolve(r).then(withCorp));
          };
        }
        const v = target[prop as keyof FetchEvent] as unknown;
        return typeof v === "function"
          ? (v as (...args: unknown[]) => unknown).bind(target)
          : v;
      },
    }) as FetchEvent,
  );
});

/* ---- Control plane ----------------------------------------------- */
// Core zl: dispatch lives in ./control.ts; the extension facade lives in
// ./extensions/control.ts. This listener only wires them up (#85, #91).
self.addEventListener(
  "message",
  /* #250: the whole handler (boot gate included) extends the
     message event lifetime, and a handler failure is answered
     instead of surfacing as an unhandled rejection. */
  messageListener({
    ready: (async () => {
      await routeReady;
      /* #249: bounded - a hung boot step must not wedge the control
         plane (netLog and diag queries) too. */
      await raceBoot(initReady, "control-plane boot");
    })(),
    persistRoute,
  }),
);
