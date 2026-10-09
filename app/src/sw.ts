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
     zl:sameSite policy | zl:importSession mode rule
     zl:getJars | zl:clearJar profile origin
     zl:downloadState id status | zl:listMenus extId

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
/* #86: the streaming rewrite pipelines + wasm rewriter lifecycle
   live in ./transform; this entrypoint wires the state seam and
   prewarms the rewriter wasm on install. */
import { initTransform, prewarmRewriter } from "./transform";
/* The tabs.sendMessage dispatch decodes a client's engine path to
   match the target tab's destination (codec is shared with the
   request engine). */
import { decodePath } from "./codec";
/* #87: the shared service-worker runtime state (degraded flag, route
   key, fingerprint scripts, per-site profile cache) lives in
   ./swstate; this entrypoint and the request engine are call sites. */
import { getFpScript, getRouteKey, setEngineDegraded, siteProfileFor, ZEOLITE_VERSION } from "./swstate";
import { ALARMS, MGMT, TABS, SCRIPTING, DOWNLOADS, NOTIFY, PERMS, bootEnabled, extensions, wakeExtension } from "./extensions";

import { handleControlEvent } from "./control";
/* #82: the request engine (route decode, page cache, upstream hop
   chain, header surgery, rewrite branches, navigation strands) lives
   in ./request.ts; this module is the entrypoint and composition
   root: it boots the runtime and wires browser events to the engine
   and the control plane. */
import { handleFetch, initEngine, persistRoute, routeReady } from "./request";

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

/* #86: the streaming rewrite pipelines + wasm rewriter lifecycle
   moved to transform.ts. */
initTransform({
  routeReady: () => routeReady,
  routeKey: () => getRouteKey(),
  fpScript: () => getFpScript(),
  siteScript: async (base) => (await siteProfileFor(base))?.script ?? null,
  setDegraded: setEngineDegraded,
});


export { ZEOLITE_VERSION };
console.info("[Zeolite] runtime " + ZEOLITE_VERSION);

self.addEventListener("install", () => {
  self.skipWaiting();
  /* Prewarm: instantiate the rewriter wasm during install, not on the
     first HTML response (instantiation is the slowest cold-path step). */
  prewarmRewriter();
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
     background scripts. Any failure lands in that extension's
     record; the engine itself never fails because of one. */
  try {
    await extensions.startup();
    await bootEnabled();
    /* Alarms wake MV3 backgrounds through the background module;
       management events observe the manager's lifecycle stream. */
    ALARMS.setWake(wakeExtension);
    MGMT.wire(extensions);
  } catch {
    /* extension subsystem unavailable: stays inert */
  }
  /* Tabs bridge: extension ops broadcast to the engine UI clients,
     which own the real tab model and mirror changes back through
     the zl:tabs sync channel. */
  TABS.setDispatch((op) => {
    void self.clients.matchAll({ type: "window" }).then((cs) => {
      for (const c of cs) c.postMessage({ type: "zl:tabsOp", op });
    });
  });
  /* tabs.sendMessage: each page verifies it is the addressee by
     destination, so the payload carries the target tab's url. */
  TABS.setMessageDispatch((_tabId, tabUrl, extId, payload) => {
    void self.clients.matchAll({ type: "window" }).then((cs) => {
      for (const c of cs) {
        let cdest = "";
        try {
          const cu = new URL(c.url, self.location.origin);
          cdest = decodePath(cu.pathname) + cu.search;
        } catch {
          continue;
        }
        if (cdest === tabUrl) {
          c.postMessage({ type: "zl:tabMessage", extId, dest: tabUrl, payload });
        }
      }
    });
  });
  /* Scripting: the payload carries the exact page destination; the
     page listener drops anything not addressed to itself. */
  SCRIPTING.setDispatch((msg) => {
    void self.clients.matchAll({ type: "window" }).then((cs) => {
      for (const c of cs) c.postMessage(msg);
    });
  });
  /* Downloads: the UI host owns the save. */
  DOWNLOADS.setDispatch((op) => {
    void self.clients.matchAll({ type: "window" }).then((cs) => {
      for (const c of cs) c.postMessage({ type: "zl:downloadOp", op });
    });
  });
  /* Notifications (#43): the UI host renders (the embedding host
     owns the surface) and reports interactions back via
     zl:notifyEvent. */
  NOTIFY.setDispatch((op) => {
    void self.clients.matchAll({ type: "window" }).then((cs) => {
      for (const c of cs) c.postMessage({ type: "zl:notifyOp", op });
    });
  });
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

/* #82: pure wiring - the request lifecycle is the engine's. */
self.addEventListener("fetch", handleFetch);

/* ---- Control plane ----------------------------------------------- */
// Core zl: dispatch lives in ./control.ts; the extension facade lives in
// ./extensions/control.ts. This listener only wires them up (#85, #91).
self.addEventListener("message", (e: ExtendableMessageEvent) => {
  void handleControlEvent(e, {
    ready: (async () => {
      await routeReady;
      await initReady;
    })(),
    persistRoute,
  });
});
