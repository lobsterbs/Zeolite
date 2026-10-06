/* Zeolite service worker: interception + header surgery + streaming
   rewriter + wisp transport + SiteConfig rules + plugin hooks + the
   network inspector's log.

   URL shape: engine-local routes under a configurable prefix (default
   /j/, rotatable at runtime via an zl:config message, persisted across
   worker restarts since issue #17). Requests that
   are engine assets (sw.js, bootstrap.js, devtools.html, ...) or the
   wisp endpoint pass through untouched. All prefix/scheme decisions go
   through ./codec helpers (bug-scout fix: "/j/" was previously hard
   -coded here while decoding used the rotated prefix).

   Phase 2 control plane (postMessage from the engine adapter):
     { type: "zl:config", prefix }          rotate the route prefix
                                             (scheme fixed "b64u" since
                                             #32; other values rejected)
     { type: "zl:mint", dest }              mint an opaque route for a
                                             destination (#55: the SW
                                             mints with its realm-held
                                             key; the key never leaves
                                             the worker)
     { type: "zl:navHandle", dest }         mint an opaque one-window
                                             initial-navigation handle
                                             (#63, #54 design D; host-
                                             only: a proxied page sender
                                             is refused)
     { type: "zl:rules", ua, rules }         host-app per-site overrides
                                             (host, adblock, ua)
     { type: "zl:jarProfile", profile }     switch the cookie jar to a
                                             throwaway session profile
                                             (incognito; in-memory only)
     { type: "zl:siteRoute", site, enabled } per-site interception toggle
     { type: "zl:teardown" }                 unregister + drop caches
   Phase 4 control plane:
     { type: "zl:getNetLog" }                snapshot of the request log
     { type: "zl:tracing", enabled }          opt-in rewrite tracing ring (1.2)
     { type: "zl:wsOpen", url, protocols }  page WS bridge (1.3; the
                                            handshake identity is the
                                            verified sender's own origin,
                                            recovered from its client
                                            route, item 4)
     { type: "zl:docCookie", set }   per-origin document.cookie (1.5;
                                            the jar origin is the verified
                                            sender's, never a claim)
     { type: "zl:fingerprint", profile }   document surface spoofing (1.8)
     { type: "zl:recordStart", recId }     deterministic session recording (1.9)
     { type: "zl:recordStop" }             build the zlRecord artifact
     { type: "zl:find", dest, cmd, pattern, options }  in-page find in the
                                            addressed page (#29; replies
                                            { ok, matches, ordinal,
                                            highlight })
   2.1 Halogen control plane:
     { type: "zl:ping" }                    version handshake (replies
                                             { ok, version, degraded,
                                               prefix, scheme } so
                                             embedders can detect a
                                             route-shape revert, #17)
   2.2 Arsenide control plane:
     { type: "zl:sameSite", policy }        opt-in jar SameSite policy
                                             ("off" | "approx")
     { type: "zl:importSession", ..., mode: "merge", rule }  merge-mode
                                             session import (default replace)

    Issue #41 control plane:
      { type: "zl:getJars" }                jar enumeration: every profile
                                              with per-origin cookie state
      { type: "zl:clearJar", profile, origin }  clear the active or named
                                              jar profile, or one origin
                                              inside it

    Issue #44/#45 control plane:
      { type: "zl:downloadState", id, status }  host reports a
                                              zl:downloadOp handoff's
                                              state back (registry +
                                              downloads.onChanged)
      { type: "zl:listMenus", extId? }      host lists registered
                                              context-menu items

    Bug-scout gate (#41): proxied pages are SW clients too, so control
    messages are host-only now - a proxied document may still send its
    own page-facing messages (zl:docCookie, zl:wsOpen, zl:ext, zl:ping),
    nothing else.
   Replies are posted back on the given MessageChannel port, so the
   adapter (and the devtools page) get real acknowledgements.

   The rewriter wasm (wasm-bindgen output of crates/rewriter) is emitted
   by the build pipeline to src/rewriter_wasm/ (see workflow:
   wasm-pack build --target web -> copy into app/src/rewriter_wasm). */

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
     interrupted by the load itself; resume stays unbuilt. */
  try {
    await DL.load();
  } catch {
    /* in-memory registry only */
  }
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
