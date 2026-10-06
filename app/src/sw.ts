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
import {
  mintableDest, b64uDecode, b64uEncode, decodeNavHandle, decodePath, encodeDest, encodeDestLegacy, encodeNavHandle, isEngineAsset, isEnginePath, isOpaqueUrl, isWorkerDestination, looksKeyedToken, NAVH, passChallengeRedirFixed, recoverPath, referrerDest, setRouteKeys, setScheme, unwrapDest, currentPrefix } from "./codec";
import { PAGE_MESSAGES, senderIsProxiedPath } from "./cpgate";
import { charsetFromHeader, decodeBody, makeDecoder, mapRefreshHeader, resolveCharset, stripHostile, utf8ContentType } from "./headers";
import { loadRouteHistory, saveRouteKey } from "./routekey";
import { classifyForeign, preflightHeaders } from "./foreign";
import { NAV } from "./bootstrap/navguard";
import { initScript, initSplicePoint } from "./pageload";
import { planRange, ZL_RANGE_MAX } from "./range";
import { applyEngineCors } from "./cors";
import { classifyFailure, errorPage, type ErrorCategory } from "./errorpage";
import { rewriteModuleWorkerImports } from "./worker-imports";
import { decideTransport, refineWithContent, sniffsAsHtml, transitRecord, transitStats, DOC_DESTS } from "./transit";
import { cssRewriteStream, initTransform, isCss, isHtml, isJs, prewarmRewriter, rawFrom, rewriteJsBody, rewriteStream, workerPrelude } from "./transform";
import { httpsUpgraded } from "./config";
import { ruleFor, siteRules } from "./siteconfig";
import { applyOnRequest, applyOnResponse } from "./plugins";
import { applyRules, loadRules, setRulesEnabled, setSiteOverrides, siteUaFor, type ResourceType } from "./rules";
import { runRequestInterception, runResponseInterception, BODY_LIMIT, type InterceptKind } from "./intercept";
import { DIAG } from "./diag";
/* #89: the network inspector ring moved to ./netlog (bounded storage,
   redaction, generation stamp); the SW and the extracted engine /
   control plane are call sites. */
import { flatRed, netLog, netLogCursor, netLogGeneration, netLogPush, netLogSince, stampNetGeneration, type NetDetail, type NetEntry } from "./netlog";
import { setTracing, traceDecision, tracingSnapshot } from "./tracing";
import { beginRecording, finishRecording, type RecordingState } from "./recording";
import { currentEngine, initTransport, openWebSocket, wispTransport } from "./transport";
import { WsBridge, type PortLike } from "./wsbridge";
import { wsIdentityHeaders } from "./wsidentity";
import { senderVirtualOrigin, virtualOriginHeaders } from "./origin";
import { capContexts, contextOf, establishContext, resolveRelative, VCTX_CAP } from "./vctx";
import { applySetCookie, cookieHeaderFor, documentCookieRead, documentCookieWrite, isPassChallenge, jarClear, jarClearScope, jarEnumeration, jarHeaders, jarLoad, jarMerge, jarProfileState, jarReplace, jarSnapshot, setJarProfile, setSameSitePolicy, type CookieRequestContext, type JarConflictRule } from "./cookies";
/* #87: the shared service-worker runtime state (per-client virtual
   contexts, degraded flag, route-shape toggles, route key, download
   registry instance, fingerprint profile + per-site profile cache,
   per-site route table, docCookie port registry) moved to ./swstate;
   the SW, the request engine and the control plane are call sites. */
import {
  DL,
  getEngineDegraded,
  getFpProfile,
  getFpScript,
  getFpWorkerScript,
  getRouteKey,
  isHttpsUpgrade,
  navHandlesEnabled,
  pushDocCookieView,
  registerDocCookiePort,
  setEngineDegraded,
  setFingerprint,
  setHttpsUpgrade,
  setNavHandles,
  setRouteKey,
  setSiteEnabled,
  siteDisabled,
  siteProfileFor,
  VCTX,
  ZEOLITE_VERSION,
} from "./swstate";
import { decryptSession, encryptSession } from "./session";
import {
  CS_ROUTE,
  EXT_ROUTE,
  MESSENGER,
  TABS,
  SCRIPTING,
  WEBNAV,
  WEBREQ,
  wrType,
  wakeExtension,
  MENUS,
  DOWNLOADS,
  NOTIFY,
  PERMS,
  ALARMS,
  MGMT,
  bootEnabled,
  bootInstalled,
  tabView,
  contentScriptMatches,
  extensions,
  getExtensionContext,
  resolveContentScripts,
  serveExtensionAsset,
  mintPageToken,
  pageClientOf,
  handleExtPageCall,
  normalizeExtensionPath,
} from "./extensions";
import type { ExtensionStorageArea } from "./extensions/storage";
import type { UiTab } from "./extensions/tabs";

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

/* ---- Header surgery ------------------------------------------------
   stripHostile() and mapRefreshHeader() live in ./headers (unit-gated
   in __tests__/leak.test.ts); the SW is the call-site layer. */

/* 2.2 Arsenide: bound on SW-followed redirect hops (the transport
   surfaces 3xx; the loop follows). Past the cap the 3xx is surfaced to
   the page with a mapped Location instead of looping forever. */
const MAX_REDIRECT_HOPS = 10;

/* #86: the streaming rewrite pipelines + wasm rewriter lifecycle
   moved to transform.ts. */
initTransform({
  routeReady: () => routeReady,
  routeKey: () => getRouteKey(),
  fpScript: () => getFpScript(),
  siteScript: async (base) => (await siteProfileFor(base))?.script ?? null,
  setDegraded: setEngineDegraded,
});


/* ---- WebSocket bridge (1.3 Carbide) -------------------------------- */
/* Pages route ws(s):// through the zl:wsOpen control message; the
   connection runs on the libcurl transport (TLS terminates there)
   over a raw wisp TCP stream. ws:// is upgraded to wss:// before the
   transport sees it. One netlog row lands at open (status 101), one
   with the final close code and byte totals at close. */

const wsBridge = new WsBridge(
  {
    open: (url, protocols, h, headers) =>
      openWebSocket(
        url,
        protocols,
        {
          onopen: (p) => h.onopen(p),
          onmessage: (d) => h.onmessage(d),
          onclose: (c, r) => h.onclose(c, r),
          onerror: (e) => h.onerror(e),
        },
        headers,
      ),
  },
  {
    attempt: (url, upgraded) => ({
      url,
      upgraded,
      entry: null as NetEntry | null,
      bytes: 0,
      traceId: DIAG.trace(),
    }),
    onReady: (token, protocol, ms) => {
      const t = token as { url: string; entry: NetEntry | null; traceId: string };
      netLogPush({
        method: "WS",
        traceId: t.traceId,
        path: "(ws bridge)",
        dest: t.url,
        status: 101,
        ms,
        bytes: 0,
        verdict: "ws" + (protocol ? " proto " + protocol : ""),
        rtype: "WEBSOCKET",
        transport: "NativeTransit",
        detail: { internalUrl: "(wisp stream)", ttfb: ms },
      });
      t.entry = netLog[netLog.length - 1];
    },
    onBytes: (token, rx, tx) => {
      const t = token as { entry: NetEntry | null; bytes: number };
      t.bytes += rx + tx;
      if (t.entry) t.entry.bytes = t.bytes;
    },
    onClose: (token, code, clean, ms) => {
      const t = token as { url: string; bytes: number; traceId: string };
      if (!clean) {
        DIAG.emit({
          category: "WEBSOCKET",
          cause: "failure",
          severity: "error",
          message: "websocket closed abnormally",
          technicalReason: "close code " + code,
          url: t.url,
          traceId: t.traceId,
          requestId: t.traceId,
        });
      }
      netLogPush({
        method: "WS",
        traceId: t.traceId,
        path: "(ws bridge)",
        dest: t.url,
        status: code,
        ms,
        bytes: t.bytes,
        verdict: clean ? "ws:closed" : "ws:aborted",
        err: clean ? undefined : "abnormal close " + code,
        rtype: "WEBSOCKET",
        transport: "NativeTransit",
        detail: { internalUrl: "(wisp stream)", ttfb: ms },
      });
    },
    trace: (d) => void traceDecision(d),
  },
);

/* ---- Page cache (ported from the v3 worker) -------------------- */
/* Cache-first for proxied GETs with stale-while-revalidate. Freshness
   honors Cache-Control: max-age when present (no-store skips the cache
   entirely); the fallback TTL is 10 minutes. 60-entry cap, FIFO
   eviction. x-zl-cached-at carries the stored-at time. */

export { ZEOLITE_VERSION };
console.info("[Zeolite] runtime " + ZEOLITE_VERSION);

/* 1.9 Fullerene: active session recording, when any. */
let rec: RecordingState | null = null;

const ZL_PAGES = "zeolite-pages-v1";
const ZL_CACHED_AT = "x-zl-cached-at";
const ZL_DEFAULT_TTL = 10 * 60 * 1000;
const ZL_PAGE_LIMIT = 60;

function cacheTtl(headers: Headers): number {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (/\bno-store\b/.test(cc)) return 0;
  const m = /(?:^|[,\s])max-age=(\d+)/.exec(cc);
  if (m) return Math.min(Number(m[1]) * 1000, 24 * 60 * 60 * 1000);
  return ZL_DEFAULT_TTL;
}

async function pageCacheMatch(req: Request): Promise<Response | null> {
  let hit: Response | undefined;
  try {
    hit = await (await caches.open(ZL_PAGES)).match(req);
  } catch {
    return null;
  }
  if (!hit) return null;
  const at = Number(hit.headers.get(ZL_CACHED_AT) ?? 0);
  const ttl = cacheTtl(hit.headers);
  if (!ttl) return null;
  if (Date.now() - at >= ttl) {
    /* Stale: serve it now, refresh in the background. */
    try {
      /* #35: a background refresh fetches the RAW upstream body. For
         serve-time-transformed JS (worker/script destinations) the
         composed copy is built on the fetch path, which this refresh
         bypasses - storing raw here would regress the entry. Drop the
         stale entry instead: this hit serves from memory, the next
         request re-fetches and re-transforms. */
      const jsServe =
        isWorkerDestination(req.destination) ||
        ((req.destination === "script" || req.destination === "") && isJs(hit));
      if (jsServe) {
        await (await caches.open(ZL_PAGES)).delete(req);
      } else {
        const fresh = await wispFetchCacheBypass(req);
        if (fresh.ok) await pageCacheStore(req, fresh);
      }
    } catch {
      /* offline: the stale copy stays served */
    }
  }
  /* Issues #13 + #18: a Range request is answered from the stored full
     entry only when exactly one byte range names a slice the engine can
     serve (plain body under the size cap). Everything else bypasses the
     cache so the origin owns range semantics; forwardedHeaders passes
     the header to the wisp path. */
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) return await rangeFromEntry(hit, rangeHeader);
  return hit;
}

/** Issue #18: slice a single-range request out of a stored full 200.
    206 + content-range on success, 416 when unsatisfiable, null to
    bypass (multi-range, compressed or oversized entries). */
async function rangeFromEntry(hit: Response, rangeHeader: string): Promise<Response | null> {
  /* A compressed body cannot be sliced: the range would cut the
     encoded stream, not the resource. */
  if (hit.headers.get("content-encoding")) return null;
  const body = new Uint8Array(await hit.arrayBuffer());
  if (body.byteLength > ZL_RANGE_MAX) return null;
  const plan = planRange(rangeHeader, body.byteLength);
  if (plan.kind === "bypass") return null;
  const headers = new Headers(hit.headers);
  if (plan.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${body.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  const slice = new Uint8Array(body.subarray(plan.start, plan.end + 1));
  headers.set("content-range", `bytes ${plan.start}-${plan.end}/${body.byteLength}`);
  headers.set("content-length", String(slice.byteLength));
  headers.set("accept-ranges", "bytes");
  return new Response(slice, { status: 206, headers });
}

/* Once-per-lifetime STORAGE warnings (scout report): both fire at
   most once per worker restart or they would spam the diag ring. */
let pageCacheTrimWarned = false;
let pageCacheStoreWarned = false;

async function pageCacheStore(req: Request, resp: Response): Promise<void> {
  const ttl = cacheTtl(resp.headers);
  if (!ttl || resp.status !== 200) return;
  try {
    const cache = await caches.open(ZL_PAGES);
    /* Issue #2 + hostile-header hygiene: the cache must never store the
       target's CORS or hostile response headers - cache hits bypass the
       live surgery path, so a stored target ACAO would break module
       scripts and a stored Set-Cookie would replay against the engine
       origin on every hit. The jar already captured Set-Cookie on the
       live path; the stored copy is the surgered view. */
    const storedHeaders = stripHostile(resp.headers);
    applyEngineCors(storedHeaders, self.location.origin, req.credentials);
    /* Cache hits bypass the live surgery path, so the stored view must
       carry the mapped Refresh too (a target-host url= here would
       replay against the browser on every hit). */
    const cu = new URL(req.url);
    const croute = decodePath(cu.pathname);
    mapRefreshHeader(storedHeaders, croute ? croute + cu.search : cu.href);
    const stored = new Response(resp.body, { status: 200, headers: storedHeaders });
    stored.headers.set(ZL_CACHED_AT, String(Date.now()));
    await cache.put(req, stored);
    let keys = await cache.keys();
    while (keys.length > ZL_PAGE_LIMIT) {
      const gone = await cache.delete(keys[0]);
      /* Scout report: a failed eviction used to pass silently and the
         cache rode over the limit until entries expired. Once per
         worker lifetime is enough - it is a storage condition, not a
         per-request defect. */
      if (!gone && !pageCacheTrimWarned) {
        pageCacheTrimWarned = true;
        DIAG.emit({
          category: "STORAGE",
          severity: "warning",
          message: "page cache eviction failed; cache may exceed the page limit until entries expire",
        });
      }
      keys = keys.slice(1);
    }
  } catch {
    if (!pageCacheStoreWarned) {
      pageCacheStoreWarned = true;
      DIAG.emit({
        category: "STORAGE",
        severity: "warning",
        message: "page cache store failed (storage full or unavailable); caching skipped",
      });
    }
    /* storage full or unavailable: skip caching */
  }
}

/** Re-fetch a cached request straight through the wisp transport. The
    transport adapter ignores the fetch redirect option (3xx responses
    surface to the caller), so no redirect hint is passed. */
async function wispFetchCacheBypass(req: Request): Promise<Response> {
  /* Issue #38: engine routes keep the query outside the encoded
     destination; a foreign (#34) cached entry is keyed by the full
     target URL, and its pathname is not a decodable route. Compose
     the destination per shape - the old form glued a null decode of
     a foreign path onto its query. */
  const u = new URL(req.url);
  const route = decodePath(u.pathname);
  const dest = route ? route + u.search : u.href;
  /* 1.4 Boride: cache refreshes carry the jar's Cookie header too. */
  const headers = new Headers();
  const jarCookie = cookieHeaderFor(dest);
  if (jarCookie) headers.set("cookie", jarCookie);
  return wispTransport.fetch(dest, { method: "GET", headers });
}

/* ---- Fetch interception -------------------------------------------- */

/** The request destination from the spec source of truth first:
    sec-fetch-* are forbidden headers the browser's network layer
    adds, and SW-visible requests can lack them entirely (Firefox;
    the repo's own #40), so every sec-fetch-dest header read goes
    through here. request.destination is set on every FetchEvent
    request; its "" (fetch/XHR) is what the header calls "empty", so
    the helper maps it and never returns a bare "". */
function reqDest(req: Request): string {
  if (req.destination) return req.destination;
  return (req.headers.get("sec-fetch-dest") ?? "").toLowerCase() || "empty";
}

/** Classify a request by destination plus response content-type.
    The devtools network panel filters on this; honest fallbacks only:
    unknown destinations and unknown content types report OTHER. */
function classifyRtype(destHeader: string, contentType: string): string {
  const d = destHeader.toLowerCase();
  const ct = contentType.toLowerCase();
  if (d === "document") return "DOCUMENT";
  if (d === "style" || ct.includes("text/css")) return "STYLE";
  if (d === "script" || /javascript|ecmascript/.test(ct)) return "SCRIPT";
  if (d === "image" || ct.startsWith("image/")) return "IMAGE";
  if (d === "font" || /font|woff|ttf|otf/.test(ct)) return "FONT";
  if (d === "audio" || d === "video" || ct.startsWith("audio/") || ct.startsWith("video/"))
    return "MEDIA";
  if (d === "worker" || d === "sharedworker" || d === "serviceworker") return "WORKER";
  if (d === "manifest" || ct.includes("manifest")) return "MANIFEST";
  if (d === "websocket") return "WEBSOCKET";
  if (d === "eventsource" || ct.includes("event-stream")) return "EVENTSOURCE";
  if (ct.includes("wasm")) return "WASM";
  if (d === "empty") return "FETCH";
  return "OTHER";
}

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

/** Content-script injection URLs for this document: one bridge per
    matching declared script set (each carries its own js/css/run_at).
    Zero installed extensions means an empty array: no added work on
    the hot path beyond one array scan. */
function csInjectUrls(target: string, req: Request): string[] {
  const exts = extensions.list();
  if (exts.length === 0) return [];
  const dest = reqDest(req);
  const subframe = dest === "iframe" || dest === "object";
  const urls: string[] = [];
  for (const r of resolveContentScripts(exts, target, subframe)) {
    if (r.js.length === 0 && r.css.length === 0) continue;
    urls.push(
      CS_ROUTE +
        r.extId +
        "/__bridge.js?cfg=" +
        encodeURIComponent(
          JSON.stringify({ ext: r.extId, js: r.js, css: r.css, runAt: r.runAt }),
        ),
    );
  }
  if (exts.some((x) => x.enabled && x.permissions.includes("scripting"))) {
    urls.push(CS_ROUTE + "__scripting.js");
  }
  return urls;
}

/* ---- Route-shape persistence (issue #17) -------------------------- */

/* The rotated prefix/scheme used to be in-memory only: a worker
   restart reverted to the default and long-lived pages silently lost
   their route shape (their /zl/ routes became passthroughs answered by
   the host's no-worker notice, zl:ping still ok). The shape now
   persists in a dedicated Cache Storage entry and restores on every
   worker start; zl:ping and the zl:config ack also echo it so embedders
   can detect drift. zl:teardown drops every cache, this one included,
   which is the intended full reset. */
const ZL_ROUTE_CACHE = "zeolite-route-v1";
const ZL_ROUTE_KEY = new URL("route-config.json", self.registration.scope).href;
const routeReady: Promise<void> = (async () => {
  try {
    const hit = await (await caches.open(ZL_ROUTE_CACHE)).match(ZL_ROUTE_KEY);
    if (hit) {
      const cfg = (await hit.json()) as { prefix?: string; scheme?: string; httpsUpgrade?: boolean; navHandles?: boolean };
      /* A pre-#32 deployment may have persisted scheme "mirror": it
         coerces to the default (mirror routes are gone, #32). */
      setScheme(cfg.prefix ?? "/j/");
      /* #53: the host's upgrade choice restores with the shape. */
      if (typeof cfg.httpsUpgrade === "boolean") setHttpsUpgrade(cfg.httpsUpgrade);
      /* #63: the ?url= refusal choice restores with the shape. */
      if (typeof cfg.navHandles === "boolean") setNavHandles(cfg.navHandles);
    }
  } catch {
    /* storage unavailable: defaults stay until the next zl:config */
  }
  /* #55: the opaque route key restores alongside the shape. First
     boot mints a fresh 16-byte key and persists it. Storage
     unavailable keeps the legacy codec for this worker lifetime:
     routes stay browser-decodable, the documented degraded mode.
     The full decode history also restores: minting uses the newest
     key, decode accepts every key this deployment minted, so routes
     already handed to pages, history and the address bar keep
     working across a restart instead of stranding. */
  try {
    let history = await loadRouteHistory();
    if (history.length === 0) {
      const fresh = crypto.getRandomValues(new Uint8Array(16));
      await saveRouteKey(fresh);
      history = [fresh];
    }
    setRouteKey(b64uEncode(history[0]!));
    setRouteKeys(history.map(b64uEncode));
  } catch {
    /* storage unavailable: keyed codec stays off */
  }
})();

async function persistRoute(prefix: string): Promise<void> {
  try {
    await (await caches.open(ZL_ROUTE_CACHE)).put(
      ZL_ROUTE_KEY,
      new Response(JSON.stringify({ prefix, httpsUpgrade: isHttpsUpgrade(), navHandles: navHandlesEnabled() })),
    );
  } catch {
    /* storage unavailable: the in-memory rotation still works */
  }
}

/* Issue #31: an in-engine navigation must land on the engine-owned
   error page, never on a bare text/plain strand. Route decode
   failures, disabled sites and policy blocks are all
   navigation-capable; subresources keep the honest short text body
   (no UI, per issue #3). Every strand also lands in the netLog ring
   with a fresh trace id (status, reason, engine transport), so the
   failure is visible in the embedder's DevTools network panel and
   joinable with the diagnostics rings - a strand is never a silent
   404. */
function navOutcome(
  e: FetchEvent,
  url: URL,
  status: number,
  category: ErrorCategory,
  text: string,
): Response {
  const traceId = DIAG.trace();
  netLogPush({
    method: e.request.method,
    traceId,
    path: url.pathname + url.search,
    dest: url.href,
    status,
    rtype: classifyRtype(reqDest(e.request), ""),
    ms: 0,
    bytes: -1,
    err: text,
    verdict: "engine: navigation strand",
    transport: "engine",
    detail: { internalUrl: url.pathname + url.search, ttfb: 0 },
  });
  if (e.request.mode === "navigate") {
    return new Response(
      errorPage({
        route: url.pathname + url.search,
        category,
        engineVersion: ZEOLITE_VERSION,
        reason: text,
        traceId,
        status,
      }),
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  /* 1.5 Silicide: opaque schemes (blob:, data:, about:) are browser-native
     and never engine routes: createObjectURL media, blob workers and
     generated downloads pass through untouched. Checked before the
     origin test: their origin is "null" or a foreign blob origin, and
     they stay browser-owned in every case. */
  if (isOpaqueUrl(url)) return;
  /* Issue #34: cross-origin http(s) requests from controlled pages are
     engine work, not browser work. Every subresource a controlled page
     issues reaches this handler - only navigations are scope-bound, and
     those escapes are the #28 class - so answering the request here
     closes the whole browser-direct class (parser-inserted markup,
     CSS url(), srcset, runtime element properties, fetch/XHR,
     EventSource, sendBeacon, workers) with no page-side hook at all.
     The pipeline below serves the request through the transport, so
     the browser never talks to the target. Only requests from proxied
     documents are engine work; the embedder app's own pages keep the
     direct passthrough (see classifyForeign). */
  const foreign = url.origin !== self.location.origin;
  if (!foreign) {
    if (url.pathname.startsWith("/wisp/")) return; // transport endpoint: passthrough
    /* Extension routes: web-accessible resources and extension pages
       (/zl-ext/, #40) and the content-script bridge + declared
       script files (/zl-cs/). */
    if (url.pathname.startsWith(EXT_ROUTE) || url.pathname.startsWith(CS_ROUTE)) {
      e.respondWith(
        (async () => {
          /* Restart-safe: extension serving needs the restored
             registry (a restarted worker boots with none). */
          await initReady;
          /* #51: the requesting page destination, resolved like the
             #33 initiator (virtual context first, client URL decode
             as the fallback). Never page-supplied; when unknown the
             scoped-WAR gate inside getResource fails closed. */
          let pageUrl: string | null = null;
          try {
            const vctx = contextOf(VCTX, e.clientId);
            if (vctx) {
              pageUrl = vctx.currentUrl || null;
            } else if (e.clientId) {
              const client = await self.clients.get(e.clientId);
              if (client && client.url) {
                pageUrl = decodePath(new URL(client.url, self.location.origin).pathname);
              }
            }
          } catch {
            pageUrl = null;
          }
          return serveExtensionAsset(
            e.request,
            url,
            /* #40: extension-page access. Client ids are SW-observed
               FetchEvent fields, never page-supplied. */
            {
              /* #40: a navigation is mode "navigate"; the destination
                 field is the spec source (reqDest), because the
                 sec-fetch-dest header only appears when the browser
                 attaches Fetch Metadata, which browser-initiated and
                 popup navigations can lack (a live host window.open
                 to a minted page URL fell through to the WAR gate
                 because nav was computed false on a dest-less
                 request). */
              nav:
                e.request.mode === "navigate" ||
                reqDest(e.request) === "document",
              clientId: e.clientId || undefined,
              resultingClientId: e.resultingClientId || undefined,
              pageUrl,
            },
          );
        })().catch(
          (err) =>
            new Response("zeolite: extension asset failed: " + String(err), {
              status: 500,
              headers: { "content-type": "text/plain" },
            }),
        ),
      );
      return;
    }
  }
  /* Issue #17: the route classification below depends on the restored
     route shape, so it runs after routeReady. respondWith is armed
     synchronously first: a cold-start fetch (restore still pending)
     must still be intercepted, not fall through to the origin with the
     default route shape. */
  e.respondWith(
    (async () => {
      await routeReady;
      await initReady;
      /* Route computation. Three shapes reach this handler:
         - foreign-origin http(s) requests (#34): the whole URL is the
           destination. Only requests from proxied documents are
           engine work (classifyForeign gates on the requesting
           client's own URL); host-app traffic keeps the direct
           passthrough with the #30 telemetry row, and CORS preflights
           are answered by the engine for exactly what the page asked.
         - engine routes (isEnginePath): decode, then unwrap nested routes
           (the rewriter used to rewrap bound routes per pass, and older
           dists still emit /zl/<b64> chains bound to the target host).
         - everything else: engine assets pass through; other same-origin
           paths are escaped fetches from a rewritten page (finding 3):
           reroute them against the origin of the serving page. Issue #33:
           the requesting client's virtual context resolves first; the
           referrer decode survives as the compat fallback only. Neither
           resolves: passthrough. */
      let dest0: string | null;
      /* Issue #38: only an engine route encodes its destination
         WITHOUT the query (the query travels as the request's own
         search string). Every other shape - a foreign request's full
         URL, the nav marker target, a same-origin path resolved
         against the client's virtual context - is already a complete
         URL that carries its query. Appending url.search onto a
         complete URL doubled the query (the Anubis pass-challenge
         fetch carried it twice, joined by a literal "?"). */
      let routeCarriesQuery = false;
      if (foreign) {
        /* Issue #34. The client lookup is the only async part; the
           policy itself is pure and unit-tested. */
        let clientUrl: string | undefined;
        try {
          if (e.clientId) {
            const client = await self.clients.get(e.clientId);
            if (client) clientUrl = client.url;
          }
        } catch {
          /* lookup unavailable: the classifier fails closed */
        }
        const policy = classifyForeign({
          requestUrl: e.request.url,
          engineOrigin: self.location.origin,
          method: e.request.method,
          preflight: e.request.headers.has("access-control-request-method"),
          clientUrl,
          hasContext: !!contextOf(VCTX, e.clientId),
        });
        if (policy === "passthrough") {
          /* #30 escape telemetry, now scoped to host-app traffic (and
             honest residuals like blob workers): the browser handles
             it directly. status 0 with ms/bytes -1: the engine never
             sees the response and claims no timing for it. */
          let initiator: string | undefined;
          try {
            if (e.request.referrer) initiator = decodePath(new URL(e.request.referrer).pathname) || undefined;
          } catch {
            /* initiator stays unknown */
          }
          netLogPush({
            method: e.request.method,
            traceId: DIAG.trace(),
            path: url.pathname + url.search,
            dest: e.request.url,
            status: 0,
            rtype: classifyRtype(reqDest(e.request), ""),
            ms: -1,
            bytes: -1,
            verdict: "passthrough: cross-origin",
            transport: "browser",
            detail: { internalUrl: e.request.url, ttfb: -1, initiator },
          });
          return fetch(e.request);
        }
        if (policy === "preflight") {
          /* The engine answers the preflight locally; the actual
             request routes through the pipeline below it. */
          const h = preflightHeaders({
            requestMethod: e.request.headers.get("access-control-request-method"),
            requestHeaders: e.request.headers.get("access-control-request-headers"),
            credentials: e.request.credentials,
            engineOrigin: self.location.origin,
          });
          let pfInitiator: string | undefined;
          try {
            if (clientUrl) pfInitiator = decodePath(new URL(clientUrl, self.location.origin).pathname) || undefined;
          } catch {
            /* initiator stays unknown */
          }
          netLogPush({
            method: "OPTIONS",
            traceId: DIAG.trace(),
            path: url.href,
            dest: url.href,
            status: 204,
            rtype: classifyRtype(reqDest(e.request), ""),
            ms: 0,
            bytes: 0,
            verdict: "cors-preflight: answered by engine",
            transport: "engine",
            detail: { internalUrl: url.href, ttfb: 0, initiator: pfInitiator },
          });
          return new Response(null, { status: 204, headers: h });
        }
        dest0 = url.href;
      } else if (url.pathname.startsWith(NAV + "/")) {
        /* Issue #28: the bootstrap nav guard rewrites absolute
           cross-origin URLs (window.open, anchor/area/iframe/form/link
           property and setAttribute assignments) to this marker route,
           so the load or navigation reaches the engine instead of the
           browser going direct (cross-origin navigations never reach
           the fetch handler otherwise: SW interception is scope-bound).
           Issue #32: the target travels base64url-encoded in the path
           (same opacity level as every other engine route), so no
           plaintext destination appears in a DOM value, the address
           bar or history; only http(s) targets are accepted, anything
           else is a bad route.
           #62: the branch matched the bare marker path only
           (url.pathname === NAV), which never occurs - navEncode
           always appends "/" + tail - so every marker navigation fell
           into the escaped-path recovery and resolved the marker
           segment against the page's virtual origin. Fixed to match
           the emitted shape. */
        const navBytes = b64uDecode(url.pathname.slice(NAV.length + 1).split(/[?#]/)[0]);
        const nav = navBytes ? new TextDecoder().decode(navBytes) : null;
        /* #31: a bad marker target is a navigation strand - the error
           page replaces the bare 404 text for navigations. */
        if (!nav || !/^https?:\/\//.test(nav)) return navOutcome(e, url, 404, "route", "zeolite: bad route");
        dest0 = nav;
      } else if (url.pathname.startsWith(NAVH + "/")) {
        /* #63 (#54 design D): the opaque initial-navigation handle.
           The host asked for it over the host-gated zl:navHandle
           message; the tail is a keyed token (decodeNavHandle walks
           the route-key history, so a handle minted before a SW
           restart or a key rotation still navigates). An expired,
           tampered or wrong-key tail fails closed to the same
           navigation strand a bad route gets - never a guess. */
        const handleDest = decodeNavHandle(url.pathname.slice(NAVH.length + 1).split(/[?#]/)[0]);
        if (!handleDest) return navOutcome(e, url, 404, "route", "zeolite: bad or expired navigation handle");
        dest0 = handleDest;
      } else if (isEnginePath(url.pathname)) {
        let raw = decodePath(url.pathname);
        let carriesQuery = true;
        /* Concatenated-route recovery: the JS literal pass mints a
           keyed route for a string literal that is only a URL
           fragment, and runtime string concatenation appends the rest
           after the token (<token><plaintext>). decodePath rejects
           the whole tail; recoverPath retries every prefix as a
           MAC-verified token and appends the remainder verbatim -
           global by token shape, never by site. */
        if (!raw) raw = recoverPath(url.pathname);
        /* Relative-path recovery, subresources only: a relative URL
           the rewriter misses resolves against the doc route into
           /zl/<plaintext-tail>. Resolve it against the requesting
           client's virtual context, then the referrer - the same
           chain the escaped-path branch below uses. The tail stays
           directory-relative (no forced leading "/"): a document at
           /a/b/page.html referencing img/x.png means /a/b/img/x.png,
           not /img/x.png. Navigations and token-shaped tails keep the
           honest error: a rotated key or a garbage link is a
           user-visible strand, not something to guess about. relTail
           already carries url.search, so the query must not be
           appended a second time. */
        if (
          !raw &&
          e.request.mode !== "navigate" &&
          !looksKeyedToken(url.pathname)
        ) {
          /* Bare prefix keeps the old root-relative meaning: "" would
             resolve to the page's own URL, not the site root. */
          const stripped = url.pathname.slice(currentPrefix().length);
          const relTail = (stripped === "" ? "/" : stripped) + url.search;
          raw = resolveRelative(VCTX, e.clientId, relTail);
          if (!raw && e.request.referrer)
            raw = referrerDest(e.request.referrer, relTail);
          if (raw) carriesQuery = false;
        }
        /* #31: an undecodable engine route answers the error page for
           navigations (bad route), the short text for subresources.
           A token-shaped tail is almost certainly a route minted
           under a key this worker no longer holds - a key rotation
           strands every old route - so it gets its own reason instead
           of the generic bad-route text. */
        if (!raw)
          return navOutcome(
            e,
            url,
            404,
            "route",
            looksKeyedToken(url.pathname)
              ? "zeolite: undecodable keyed route (route key rotated?)"
              : "zeolite: bad route",
          );
        dest0 = unwrapDest(raw);
        routeCarriesQuery = carriesQuery;
      } else {
        if (isEngineAsset(url.pathname)) return fetch(e.request); // engine asset: passthrough
        /* #63: with the navHandles opt-in on, the plaintext ?url=
           embed is refused at the fetch handler - the destination must
           arrive via a zl:navHandle route instead, so no plaintext
           target is ever browser-visible on the deployment. Scope-root
           only (the embed page's own URL): the bare landing page with
           no ?url= keeps serving so an operator can read the hint. */
        if (
          navHandlesEnabled() &&
          e.request.mode === "navigate" &&
          url.pathname === new URL(self.registration.scope).pathname &&
          url.searchParams.get("url")
        ) {
          return navOutcome(e, url, 403, "blocked", "zeolite: plaintext ?url= embed refused (navHandles opt-in; use zl:navHandle)");
        }
        /* Issue #33: the requesting client's own virtual context is the
           primary recovery for an escaped same-origin path (right even
           with Referrer-Policy: no-referrer); referrer decoding
           survives only as the compat fallback. */
        const ctxDest = resolveRelative(VCTX, e.clientId, url.pathname + url.search);
        if (ctxDest) {
          dest0 = ctxDest;
        } else {
          const refDest = e.request.referrer
            ? referrerDest(e.request.referrer, url.pathname + url.search)
            : null;
          if (!refDest) return fetch(e.request); // unknown same-origin path: passthrough
          dest0 = refDest;
        }
      }
      // Fragments are client-side only. The rewriter keeps them out of the
      // encoded target, but older bundles or hand-built routes may carry
      // one: strip it so a sprite referenced as "...#a", "...#b", "...#c"
      // is one cache key, one wisp destination, one upstream identity.
      const bareDest = dest0.startsWith("http")
        ? dest0.split("#", 1)[0] || dest0
        : dest0;
      // Query string travels outside the encoded destination - engine
      // routes only (see routeCarriesQuery above).
      let target = routeCarriesQuery && url.search ? bareDest + url.search : bareDest;
      /* #53: the single upgrade choke point. Every destination
         shape (rewriter-emitted routes, navguard markers, escaped
         same-origin paths, foreign-origin requests) resolves here
         before cache or transport; mixed-content subresources and
         redirect targets pass the same seam on their own fetch. */
      target = httpsUpgraded(target, isHttpsUpgrade());
      /* #52 parity with the server-side anubis bridge: the challenge
         page's return URL was rewritten into an engine route, so the
         pass-challenge request carries redir pointing at the engine
         origin - and the upstream deployment rejects a redirect target
         outside its allowlist (redirect_domain_not_allowed), which
         fails the challenge UI right after it completes. Carry the
         decoded upstream page URL instead; the response hop chain
         maps the redirect back to an engine route through the
         ordinary pipeline. The CHALLENGE event is the log line hosts
         see when this fires. */
      if (isPassChallenge(target)) {
        const fixed = passChallengeRedirFixed(target);
        if (fixed && fixed !== target) {
          const ctid = DIAG.trace();
          DIAG.emit({
            requestId: ctid,
            traceId: ctid,
            category: "CHALLENGE",
            cause: "challenge",
            severity: "info",
            stage: "REQUEST_INTERCEPTED",
            message: "pass-challenge redir rewritten to the upstream page URL",
            url: target,
          });
          target = fixed;
        }
      }

      if (siteDisabled(target)) {
        /* #31: a disabled-site navigation lands on the error page
           ("blocked"), not a bare 403 strand. */
        return navOutcome(e, url, 403, "blocked", "zeolite: site disabled for this engine");
      }

      /* Issue #33: serving a document or worker script from a decodable
         engine route establishes the new client's virtual context
         atomically (built whole, one Map.set: rule 6). Navigations record
         under resultingClientId (the new document client); worker script
         loads record under the worker's own reserved client, so worker
         requests inherit an explicit context, never a page referrer
         (rule 5). Subresource routes never touch the entry. */
      if (e.request.mode === "navigate" || isWorkerDestination(e.request.destination)) {
        const newClient = e.resultingClientId || e.clientId;
        if (newClient && establishContext(VCTX, newClient, target)) capContexts(VCTX, VCTX_CAP);
      }

      return (async () => {
        const t0 = Date.now();
        const traceId = DIAG.trace();
        DIAG.stage(traceId, "REQUEST_INTERCEPTED", { url: target });
        /* Issue #34: a foreign-origin request has no engine-local path;
           the full URL is its internal identity (and the netLog path). */
        const internalUrl = foreign ? url.href : url.pathname + url.search;
        /* Initiator: the controlling page destination. Issue #33: the
           client's own virtual context is the primary source (right
           even with an empty referrer); the client URL decode remains
           the fallback (unknown after a restart, for instance). */
        let initiator: string | undefined;
        const ctx = contextOf(VCTX, e.clientId);
        if (ctx) initiator = ctx.currentUrl;
        if (initiator === undefined) {
          try {
            if (e.clientId) {
              const client = await self.clients.get(e.clientId);
              if (client) initiator = decodePath(new URL(client.url, self.location.origin).pathname) || undefined;
            }
          } catch {
            /* initiator stays unknown */
          }
        }
        const mkDetail = (resp?: Response): NetDetail => {
          const d: NetDetail = {
            internalUrl,
            ttfb: Date.now() - t0,
            initiator,
            reqHeaders: flatRed(e.request.headers),
          };
          if (foreign) d.crossOrigin = true;
          if (resp) {
            d.respHeaders = flatRed(resp.headers);
            /* Issue #10: set-cookie never survives Response construction
               (fetch spec: forbidden response-header name); the jar view
               carries it instead. */
            const jh = jarHeaders(resp);
            const getSetCookie = (jh as Headers & { getSetCookie?: () => string[] }).getSetCookie;
            const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(jh) : [];
            if (setCookies.length) d.cookies = setCookies.map((c) => c.split("=", 1)[0]);
          }
          return d;
        };
        /* NativeTransit decision: pre-fetch classification from the
           destination scheme + request destination; refined with the
           actual content type once the response arrives. */
        const dest = reqDest(e.request);
        const decision = decideTransport(target, dest);
        /* webNavigation.onBeforeNavigate: navigation-mode requests
           report the interception itself, before any cache or upstream
           work. */
        if (e.request.mode === "navigate") WEBNAV.beforeNavigate(target);
        /* Shared webRequest details for every hook below. */
        const wrDetails = {
          requestId: traceId,
          url: target,
          method: e.request.method,
          type: wrType(dest),
          timeStamp: Date.now(),
        };
        /* webRequest.onBeforeRequest: a blocking listener can cancel the
           request before cache or transport. */
        if (WEBREQ.beforeRequest(wrDetails)) {
          DIAG.emit({
            category: "BLOCKED",
            cause: "blocked",
            severity: "info",
            message: "request cancelled by extension webRequest",
            stage: "REQUEST_INTERCEPTED",
            url: target,
            traceId,
            requestId: traceId,
          });
          /* Issue E: no transitRecord on blocked exits - a cancelled
             request never completed, so it must not count as
             NativeTransit; the netLog row below carries the block. */
          netLogPush({
            method: e.request.method, traceId,
            path: internalUrl,
            dest: target,
            status: 403,
            rtype: classifyRtype(dest, ""),
            ms: Date.now() - t0,
            bytes: -1,
            verdict: "blocked",
            transport: decision.mode,
            fallbackReason: decision.fallbackReason,
            detail: mkDetail(),
          });
          return navOutcome(e, url, 403, "blocked", "zeolite: request blocked by extension");
        }
        /* Phase 1 (1.1 Oxide): rules engine + interception API. Data
           rules first, then programmatic handlers; a block from either
           wins, before cache and transport. See docs/interception.md. */
        const engineRules = await loadRules();
        const rtype = classifyRtype(dest, "").toLowerCase() as ResourceType;
        const ruleDec = applyRules(engineRules, target, rtype);
        const kinds: Exclude<InterceptKind, "response">[] = ["request"];
        if (e.request.mode === "navigate") kinds.push("navigation");
        if (rtype === "worker") kinds.push("worker");
        if (rtype === "websocket") kinds.push("websocket");
        if (rtype === "fetch") kinds.push("fetch");
        const flatReq: Record<string, string> = {};
        e.request.headers.forEach((v, k) => (flatReq[k] = v));
        const ic = runRequestInterception(kinds, {
          url: ruleDec.url ?? target,
          method: e.request.method,
          rtype,
          headers: flatReq,
        });
        const extraHeaders: Record<string, string> = {
          ...(ruleDec.headers ?? {}),
          ...(ic.headers ?? {}),
        };
        /* 1.2 Halide: opt-in rewrite tracing at the decision seams.
           Zero allocation while tracing is off. */
        if (ruleDec.action === "block")
          traceDecision({ subsystem: "rules", rule: ruleDec.matched, original: target, result: "blocked", resource: rtype, traceId });
        if (ic.block)
          traceDecision({ subsystem: "intercept", original: target, result: "blocked", resource: rtype, traceId });
        if (ruleDec.url)
          traceDecision({ subsystem: "rules", rule: "rewrite", original: target, result: ruleDec.url, resource: rtype, traceId });
        if (ic.url)
          traceDecision({ subsystem: "intercept", original: target, result: ic.url, resource: rtype, traceId });
        if (ruleDec.action === "block" || ic.block) {
          DIAG.emit({
            category: "BLOCKED",
            cause: "blocked",
            severity: "info",
            message:
              "request blocked by " +
              (ruleDec.action === "block"
                ? "rules (" + (ruleDec.matched ?? "") + ")"
                : "intercept handler"),
            stage: "REQUEST_INTERCEPTED",
            url: target,
            traceId,
            requestId: traceId,
          });
          /* Issue E: no transitRecord - blocked, never completed (the
             netLog row carries the block). */
          netLogPush({
            method: e.request.method, traceId,
            path: internalUrl,
            dest: target,
            status: 403,
            rtype: rtype.toUpperCase(),
            ms: Date.now() - t0,
            bytes: -1,
            verdict: ruleDec.action === "block" ? "blocked:rules" : "blocked:intercept",
            transport: decision.mode,
            fallbackReason: decision.fallbackReason,
            detail: mkDetail(),
          });
          return navOutcome(e, url, 403, "blocked", "zeolite: request blocked");
        }
        if (ruleDec.url || ic.url) target = httpsUpgraded(ic.url ?? ruleDec.url ?? target, isHttpsUpgrade());

        /* Cache-first for proxied GETs. */
        if (e.request.method === "GET") {
          const hit = await pageCacheMatch(e.request);
          if (hit) {
            const dec = refineWithContent(decision, hit.headers.get("content-type") ?? "", dest);
            transitRecord(traceId, target, dec);
            /* Bug-scout fix: cache-hit navigations used to skip the
               webNavigation lifecycle entirely. */
            if (
              e.request.mode === "navigate" &&
              (hit.headers.get("content-type") ?? "").includes("text/html")
            ) {
              WEBNAV.committed(target);
            }
            netLogPush({
              method: e.request.method, traceId,
              path: internalUrl,
              dest: target,
              status: hit.status,
              rtype: classifyRtype(dest, hit.headers.get("content-type") ?? ""),
              ms: Date.now() - t0,
              bytes: Number(hit.headers.get("content-length") ?? -1),
              verdict: "cache",
              rewritten:
                hit.status === 200 && isHtml(hit)
                  ? "html"
                  : hit.status === 200 && isCss(hit)
                    ? "css"
                    : hit.status === 200 && isJs(hit) && (dest === "script" || dest === "")
                      ? "js"
                      : undefined,
              transport: dec.mode,
              fallbackReason: dec.fallbackReason,
              detail: mkDetail(hit),
            });
            WEBREQ.completed({ ...wrDetails, statusCode: hit.status });
            /* Range replies (206/416) own their header surgery (slice
               length, content-range): serve them untouched. */
            if (hit.status !== 200) return hit;
            /* Legacy entries predate the content-encoding strip and
               carry a stale upstream encoding over a decoded body:
               fetch() consumers would decode plaintext a second time.
               The served view is always identity. */
            const hitHeaders = new Headers(hit.headers);
            hitHeaders.delete("content-encoding");
            hitHeaders.delete("content-length");
            /* A stored document/stylesheet is the raw upstream body: a
               cache hit must flow through the same streaming rewriter
               as a fresh response, or every second visit serves an
               unrewritten page (links escape the engine, no __ZL
               bootstrap, no cookie/storage virtualization). */
            if (isHtml(hit) && hit.body) {
              const chRules = await siteRules();
              const chRule = ruleFor(chRules, target);
              const csInject = csInjectUrls(target, e.request);
              const hitCt = hit.headers.get("content-type") ?? "text/html";
              /* Issue B: the served copy is re-encoded UTF-8. */
              hitHeaders.set("content-type", utf8ContentType(hitCt));
              return new Response(
                rewriteStream(hit.body, target, chRule, csInject, hitCt, () => {
                  if (e.request.mode === "navigate") WEBNAV.completed(target);
                }),
                { status: hit.status, headers: hitHeaders },
              );
            }
            if (isCss(hit) && hit.body) {
              const hitCt = hit.headers.get("content-type") ?? "text/css";
              hitHeaders.set("content-type", utf8ContentType(hitCt));
              return new Response(cssRewriteStream(hit.body, target, hitCt), {
                status: hit.status,
                headers: hitHeaders,
              });
            }
            return new Response(hit.body, { status: hit.status, headers: hitHeaders });
          }
        }
        const rules = await siteRules();
        const rule = ruleFor(rules, target);
        const plugins = rule.plugins;
        try {
          DIAG.stage(traceId, "UPSTREAM_REQUEST", { url: target });
          const fwd = forwardedHeaders(e.request, target, initiator);
          /* webRequest.onBeforeSendHeaders: blocking listeners may
             replace the outgoing header set (validated pairs only). */
          const replaced = WEBREQ.beforeSendHeaders(wrDetails, fwd);
          const sendHeaders = replaced ?? fwd;
          await applyOnRequest(plugins, target, sendHeaders);
          for (const [k, v] of Object.entries(extraHeaders)) sendHeaders.set(k, v);
          /* Per-site rules (zl:rules): the UA override lands on the
             outgoing header set the SW itself builds for the wisp
             transport (user-agent is a forbidden header for a browser
             fetch, but this request is engine-built). An active
             fingerprint profile still wins: the wire surface must match
             the spoofed document surface (1.8 Telluride). */
          const ruleUa = siteUaFor(target);
          if (ruleUa && !getFpProfile()) sendHeaders.set("user-agent", ruleUa);
          /* #80: a per-site FingerprintProfile from siteconfig data
             rides the same wire surfaces; it overrides the zl:rules
             UA (a full coherent surface beats one header), and the
             global profile still beats both. */
          if (!getFpProfile()) {
            const sp = await siteProfileFor(target);
            if (sp) {
              sendHeaders.set("user-agent", sp.p.userAgent);
              sendHeaders.set("accept-language", sp.p.languages.join(","));
            }
          }
          /* 2.2 Arsenide: initiator context for the opt-in SameSite
             policy. Issue #33: the initiator comes from the client's own
             virtual context first (a SW-assigned key, not a page-supplied
             string); the referrer decode is the compat fallback.
             Navigations are top-level for lax purposes. */
          const initCtx = contextOf(VCTX, e.clientId);
          const reqCtx: CookieRequestContext = {
            /* Issue #34: a foreign-origin request's initiator is the
               requesting page itself; the same-origin referrer fallback
               (path resolved against the page home) must not be applied
               to a foreign path - the page home suffices. */
            initiator:
              initCtx?.currentUrl ??
              (e.request.referrer
                ? referrerDest(e.request.referrer, foreign ? "/" : url.pathname + url.search) ?? undefined
                : undefined),
            /* Issue D: a top-level navigation is mode "navigate"
               (destination "document"); the header alone was false on
               browsers that omit Fetch Metadata, which dropped Lax
               cookies from cross-site logins under sameSite approx. */
            navigation: e.request.mode === "navigate" || dest === "document",
          };
          /* 1.4 Boride: the jar is the authoritative Cookie source for
             engine-initiated requests, written last so rules and
             interception cannot smuggle another origin's cookies. */
          const jarCookie = cookieHeaderFor(target, reqCtx);
          if (jarCookie) sendHeaders.set("cookie", jarCookie);
          else sendHeaders.delete("cookie");
          /* 2.2 Arsenide: the transport fetch adapter ignores the redirect
             option and surfaces 3xx responses, so hops followed inside
             the transport never reached the jar and dropped their
             Set-Cookie. The SW now follows the hop chain itself and
             captures Set-Cookie on every hop. 303 (and POST on 301/302)
             continues as GET per the fetch spec; 307/308 replay the
             method, which a one-shot stream body cannot do, so those
             surface to the page with a mapped Location (below) and the
             browser re-issues the request. */
          let hopUrl = target;
          let hopMethod = e.request.method;
          let hopBody: BodyInit | undefined | null = ["GET", "HEAD"].includes(e.request.method)
            ? undefined
            : e.request.body;
          let resp = await wispTransport.fetch(hopUrl, { method: hopMethod, headers: sendHeaders, body: hopBody });
          for (let hops = 0; resp.status >= 300 && resp.status < 400 && hops < MAX_REDIRECT_HOPS; hops++) {
            /* Capture this hop's Set-Cookie against the URL it came from.
               #35: any admission also pushes the jar view to the
               requesting client's docCookie port (see the main capture
               below). */
            const hopAdmitted = applySetCookie(hopUrl, jarHeaders(resp));
            if (hopAdmitted.some((r) => r.stored || r.deleted)) void pushDocCookieView(e.clientId);
            const loc = resp.headers.get("location");
            if (!loc) break; /* 3xx without Location: surface as-is */
            let next: string;
            try {
              next = new URL(loc, hopUrl).href;
            } catch {
              break; /* unresolvable Location: surface the 3xx as-is */
            }
            /* #53: the engine-side hop chain bypasses the fetch
               choke point, so each hop upgrades here too. */
            next = httpsUpgraded(next, isHttpsUpgrade());
            if (resp.status === 307 || resp.status === 308) {
              if (hopBody) break; /* one-shot stream: cannot replay */
            } else if (resp.status === 303 || hopMethod === "POST") {
              hopMethod = "GET";
              hopBody = undefined;
            } else if (hopBody) {
              break; /* one-shot stream: cannot replay */
            }
            /* The jar is per-origin: cookies for the hop target, not the
               original one. */
            const hopCookie = cookieHeaderFor(next, reqCtx);
            if (hopCookie) sendHeaders.set("cookie", hopCookie);
            else sendHeaders.delete("cookie");
            DIAG.stage(traceId, "REDIRECT_HOP", { url: hopUrl, message: "hop -> " + next });
            hopUrl = next;
            resp = await wispTransport.fetch(hopUrl, { method: hopMethod, headers: sendHeaders, body: hopBody });
          }
          DIAG.stage(traceId, "UPSTREAM_RESPONSE", { url: hopUrl, message: "upstream status " + resp.status });
          /* A 3xx that escaped the hop loop - cap reached, a hop whose
             one-shot body cannot replay, or no resolvable Location - is
             surfaced to the page with a mapped Location. For
             navigations the browser follows that Location itself, so
             a looping upstream chain shows up as repeated visible
             reloads (one surfaced hop per MAX_REDIRECT_HOPS engine
             hops, until the browser's own redirect cap kills the
             chain). Mark the surface so DevTools can explain the
             reload cycle instead of leaving it mysterious. */
          if (resp.status >= 300 && resp.status < 400) {
            DIAG.emit({
              traceId,
              requestId: traceId,
              category: "TRANSPORT",
              cause: "proxy",
              severity: "info",
              stage: "UPSTREAM_RESPONSE",
              message:
                "redirect surfaced to the page (hop cap " + MAX_REDIRECT_HOPS +
                " or unreplayable hop); the browser follows the mapped Location itself, " +
                "so a looping upstream chain reloads the page in cycles",
              url: target,
            });
          }
          /* Stage E: the SW-followed hop chain is the authority on the
             final destination; a transport-exposed final URL is the
             fallback. */
          const finalUrl = typeof resp.url === "string" ? resp.url : "";
          const finalDest = hopUrl !== target ? hopUrl : finalUrl && finalUrl !== target ? finalUrl : undefined;
          if (finalDest) {
            DIAG.stage(traceId, "REDIRECTED", { url: target, message: "final destination " + finalDest });
          }
          /* 1.4 Boride: capture Set-Cookie into the per-origin jar before
             hostile-header surgery strips it from the page view. A 3xx
             that surfaced (hop cap, unresolvable or unreplayable hop)
             still lands here, captured against its own hop URL. */
          const admitted = applySetCookie(finalDest ?? hopUrl, jarHeaders(resp));
          /* #35 (browser E2E): the page's document.cookie getter is
             synchronous, so the bootstrap keeps an optimistic copy; a
             Set-Cookie admitted on this fetch/XHR response was invisible
             to the page until its NEXT read. Push the fresh jar view to
             the requesting client's docCookie port right after
             admission, so the copy corrects itself. Unknown client
             (SW-initiated fetch, navigation) is a no-op inside. */
          if (admitted.some((r) => r.stored || r.deleted)) void pushDocCookieView(e.clientId);
          /* #52: a solved Anubis challenge hands its cookies back through
             the ordinary jar admission above; flag the handoff so hosts
             can react (detect-only, never a solve). */
          if (isPassChallenge(target) || (hopUrl !== target && isPassChallenge(hopUrl)))
            DIAG.emit({
              traceId,
              requestId: traceId,
              category: "CHALLENGE",
              cause: "challenge",
              severity: "info",
              stage: "UPSTREAM_RESPONSE",
              message: "challenge pass-through: cookies captured for " + target,
              url: target,
            });
          const headers = stripHostile(resp.headers);
          /* Issue #2: engine routes serve their own origin. The preserved
             target ACAO (e.g. "https://excalidraw.com") fails the CORS
             check Chromium applies to module and crossorigin script
             responses - they download but never execute. The engine's own
             CORS facts replace the target's; cross-origin consumers fail
             closed (see app/src/cors.ts). */
          applyEngineCors(headers, self.location.origin, e.request.credentials);
          /* webRequest.onHeadersReceived: blocking listeners may replace
             the response header set the page will see. */
          const rHeaders = WEBREQ.headersReceived(wrDetails, resp.status, headers);
          const outHeaders = rHeaders ?? headers;
          outHeaders.set("x-zl-proxy", "1");
          /* Finding 1: a 3xx that reached the page (hop cap reached, no
             Location, or a hop whose one-shot body cannot replay) must not
             hand the browser a target-host URL: map Location to an engine
             route so the follow stays inside the engine. The hop's
             Set-Cookie was already captured (hop loop or just above). */
          /* Any status that carries a Location (201/202 and any a webRequest
             listener re-added), not only surfaced 3xx: it names the target
             host, and a fetch() consumer resolving the mapped value
             against the engine origin gets a working engine route. */
          if (outHeaders.has("location")) {
            const loc = outHeaders.get("location");
            if (loc) {
              try {
                outHeaders.set("location", encodeDest(new URL(loc, finalDest ?? target).href));
              } catch {
                /* unreachable/relative Location: leave as-is */
              }
            }
          }
          /* #32 follow-up: Refresh is functional, not informational, so its
             url= is mapped to an engine route instead of stripped -
             a delayed refresh must stay inside the engine. Same-page
             refresh (no url=) carries no destination and passes. */
          mapRefreshHeader(outHeaders, finalDest ?? target);
          void applyOnResponse(plugins, target, resp.status, outHeaders);
          const dec = refineWithContent(decision, resp.headers.get("content-type") ?? "", dest);
          traceDecision({ subsystem: "transport", rule: dec.mode, original: target, result: dec.fallbackReason ?? dec.mode, resource: rtype, traceId });
          if (finalDest)
            traceDecision({ subsystem: "transport", rule: "redirect", original: target, result: finalDest, resource: rtype, traceId });
          transitRecord(traceId, target, dec);
          netLogPush({
            method: e.request.method, traceId,
            path: internalUrl,
            dest: target,
            status: resp.status,
            ms: Date.now() - t0,
            bytes: Number(resp.headers.get("content-length") ?? -1),
            verdict: plugins?.length ? "pass:" + plugins.length : undefined,
            rtype: classifyRtype(dest, resp.headers.get("content-type") ?? ""),
            rewritten: isHtml(resp) ? "html" : isCss(resp) ? "css" : isJs(resp) && (dest === "script" || dest === "") ? "js" : undefined,
            transport: dec.mode,
            fallbackReason: dec.fallbackReason,
            finalDest,
            detail: mkDetail(resp),
          });
          /* Opt-in response body transform (1.1): only when an intercept
             handler declared one AND the size gate passes. Documents and
             stylesheets are excluded (the streaming rewriter owns
             those); transformed responses are never page-cached. */
          const flatOut: Record<string, string> = {};
          outHeaders.forEach((v, k) => (flatOut[k] = v));
          const rIc = runResponseInterception({
            url: target,
            status: resp.status,
            rtype,
            headers: flatOut,
          });
          if (rIc.headers) {
            for (const [k, v] of Object.entries(rIc.headers)) outHeaders.set(k, v);
          }
          if (rIc.body && !isHtml(resp) && !isCss(resp)) {
            const clen = Number(resp.headers.get("content-length") ?? -1);
            if (clen >= 0 && clen <= BODY_LIMIT) {
              WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
              return new Response(rIc.body(await resp.text()), {
                status: resp.status,
                headers: outHeaders,
              });
            }
          }
          /* The upstream content type, used by the rewrite branches
             below (charset resolution, honest classification). */
          const respCt = resp.headers.get("content-type") ?? "";
          /* #35 (browser E2E): script/worker JS bodies flow through a
             serve-time transform below (specifier pass, worker
             prelude), and each of those branches stores its TRANSFORMED
             copy itself. Storing the raw body here as well would race
             the transformed put and could serve an unrewritten second
             visit, so the raw store skips exactly the union of the
             transformed branches. Documents and stylesheets keep the
             raw store: their cache hits re-run the streaming
             rewriter. Content-type-less document responses are never
             stored either: only the fresh path can sniff them (issue
             C), a cached copy would serve the second visit
             unrewritten. */
          const workerServe = isWorkerDestination(e.request.destination) && !!resp.body;
          /* #47: destination "" JS (fetch/XHR + eval) transforms too,
             so its raw store must be skipped exactly like script-dest
             JS - the branch below stores the transformed copy. */
          const scriptServe = (e.request.destination === "script" || e.request.destination === "") && isJs(resp) && !!resp.body;
          if (
            e.request.method === "GET" &&
            !workerServe &&
            !scriptServe &&
            !(DOC_DESTS.has(dest) && respCt === "")
          ) {
            void pageCacheStore(e.request, resp.clone());
          }
          if ((isHtml(resp) || (respCt === "" && DOC_DESTS.has(dest) && resp.body)) && resp.body) {
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "html rewrite stream wired" });
            traceDecision({ subsystem: "rewriter", rule: "html", original: target, result: "streaming", resource: rtype, traceId });
            /* Main-frame document loads feed the webNavigation bridge;
               subresource fetches do not arrive in navigate mode. */
            if (e.request.mode === "navigate") WEBNAV.committed(target);
            const csInject = csInjectUrls(target, e.request);
            const rewriteDone = () => {
              /* webNavigation.onCompleted + webRequest.onCompleted:
                 the document stream (and with it the navigation) is
                 done. */
              WEBNAV.completed(target);
              WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
            };
            if (respCt !== "") {
              /* Issue B: the rewritten body is re-encoded UTF-8; the
                 served content-type must say so, or a legacy upstream
                 charset corrupts the page. */
              outHeaders.set("content-type", utf8ContentType(respCt));
              return new Response(
                rewriteStream(resp.body, target, rule, csInject, respCt, rewriteDone),
                {
                  status: resp.status,
                  headers: outHeaders,
                },
              );
            }
            /* Issue C: a content-type-less response to a document
               destination is sniffed on its first chunk exactly the
               way the browser sniffs navigations: html joins the
               rewrite path (served as utf-8 html), anything else
               passes the raw bytes through untouched. */
            const sniffReader = resp.body!.getReader();
            const { value: sniffHead } = await sniffReader.read();
            if (sniffHead && sniffsAsHtml(sniffHead)) {
              outHeaders.set("content-type", "text/html; charset=utf-8");
              return new Response(
                rewriteStream(sniffReader, target, rule, csInject, "text/html", rewriteDone),
                {
                  status: resp.status,
                  headers: outHeaders,
                },
              );
            }
            return new Response(rawFrom(sniffHead, sniffReader), {
              status: resp.status,
              headers: outHeaders,
            });
          }
          if (isCss(resp) && resp.body) {
            /* 2.4 Bromide: standalone stylesheets stream through the wasm
               CSS rewriter (previously a one-shot pass over a fully
               buffered body). Completion events fire at stream end, like
               the HTML path. Issue B: decoded with the upstream charset,
               served UTF-8 with the header saying so. */
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "css rewrite stream wired" });
            traceDecision({ subsystem: "rewriter", rule: "css", original: target, result: "streaming", resource: rtype, traceId });
            outHeaders.set("content-type", utf8ContentType(respCt));
            return new Response(
              cssRewriteStream(resp.body, target, respCt, () => {
                DIAG.stage(traceId, "REWRITE_COMPLETED", { url: target, category: "REWRITE" });
                WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
              }),
              {
                status: resp.status,
                headers: outHeaders,
              },
            );
          }
          /* Module worker scripts (module scripts fetch with mode "cors",
             classic workers with same-origin): import specifiers cannot
             be routed from the prelude - they resolve before any script
             runs, and import() is host syntax - so the SW rewrites the
             specifiers in the body itself (2.3 Selenide). A text pass
             cannot run on a chunked stream, so the body is buffered;
             worker scripts are not first-paint documents. */
          if (isWorkerDestination(e.request.destination) && e.request.mode === "cors" && resp.body) {
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "module worker specifier pass" });
            traceDecision({ subsystem: "rewriter", rule: "worker-imports", original: target, result: "rewritten", resource: rtype, traceId });
            const src = rewriteModuleWorkerImports(currentPrefix(), target, self.location.origin, decodeBody(await resp.arrayBuffer(), respCt));
            /* Issue #32: no __ZL_WORKER_URL__ global (it handed the
               upstream URL to any worker script); the worker's own
               engine route is passed to the prelude init line and
               decoded inside its closure. #55: the init route is
               minted with the legacy codec on purpose - the prelude
               realm holds no route key, so a keyed token could never
               decode there (honest limit, issue text). */
            const wFp = getFpWorkerScript() ?? (await siteProfileFor(target))?.workerScript ?? "";
            const head =
              "self.__ZL_PREFIX__=" + JSON.stringify(currentPrefix()) + ";\n" +
              (await workerPrelude()) +
              "\nself.__zlPreludeInit&&self.__zlPreludeInit(" + JSON.stringify(encodeDestLegacy(target)) + ");\n" +
              (wFp ? "\n" + wFp : "");
            WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
            /* #35: the page cache holds the composed copy (specifiers
               rewritten, prelude prepended); a stored raw body would
               serve a second visit unrewritten. */
            /* Issue B: decode with the upstream charset (the fetch
               spec's text() is always UTF-8 and mangled legacy
               script bodies); the composed copy is re-encoded UTF-8
               and the served header says so. */
            outHeaders.set("content-type", utf8ContentType(respCt));
            const out = new Response(head + src, { status: resp.status, headers: outHeaders });
            if (e.request.method === "GET") void pageCacheStore(e.request, out.clone());
            return out;
          }
          if (isWorkerDestination(e.request.destination) && resp.body) {
            /* 1.6 Hydride: classic/shared worker scripts get the prelude
               prepended (importScripts routing, worker WebSocket bridge).
               2.3 Selenide: an active fingerprint profile is compiled
               into a worker-context init script and prepended too
               (WorkerNavigator + OffscreenCanvas surfaces). Streaming is
               preserved: everything prepended is one extra first chunk. */
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "worker prelude" });
            const preludeW = getFpWorkerScript() ?? (await siteProfileFor(target))?.workerScript ?? "";
            const prelude =
              "self.__ZL_PREFIX__=" + JSON.stringify(currentPrefix()) + ";\n" +
              (await workerPrelude()) +
              "\nself.__zlPreludeInit&&self.__zlPreludeInit(" + JSON.stringify(encodeDestLegacy(target)) + ");\n" +
              (preludeW ? "\n" + preludeW : "");
            const body = new ReadableStream<Uint8Array>({
              async start(c) {
                c.enqueue(new TextEncoder().encode(prelude));
                const rd = resp.body!.getReader();
                for (;;) {
                  const { done, value } = await rd.read();
                  if (done) break;
                  c.enqueue(value);
                }
                c.close();
              },
            });
            WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
            /* #35: clone() tees the composed stream, so the browser
               keeps its streaming path while the cache consumes the
               other fork. */
            const out = new Response(body, { status: resp.status, headers: outHeaders });
            if (e.request.method === "GET") void pageCacheStore(e.request, out.clone());
            return out;
          }
          /* #35 (browser E2E): page <script type="module"> bodies. An
             external module script folds its import specifiers against
             the document URL before any script runs, so "./mapi.js" in
             a proxied page resolved against the opaque engine route,
             missed the route table and 404'd. The same serve-time text
             pass the module workers get (2.3 Selenide) rewrites the
             specifiers here; dynamic import() in a classic script
             resolves the same way, so every script-destination JS body
             takes the pass (a no-op for bodies without specifiers).
             #47: destination "" JS (fetch/XHR + eval) takes it too -
             HTML and CSS rewrite by content type with no destination
             gate, JS alone was gated. Inline module scripts are a
             rewriter gap (#36): the parser path, not this seam. */
          if ((e.request.destination === "script" || e.request.destination === "") && isJs(resp) && resp.body) {
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "page script specifier + body pass" });
            traceDecision({ subsystem: "rewriter", rule: "script-imports", original: target, result: "rewritten", resource: rtype, traceId });
            let src = rewriteModuleWorkerImports(currentPrefix(), target, self.location.origin, decodeBody(await resp.arrayBuffer(), respCt));
            /* #46: external script bodies get the URL-literal +
               frame-buster pass inline scripts get. Specifiers run
               first: the routes they emit are root-relative, so the
               literal pass leaves them alone. A wasm load failure must
               not 502 the script - the specifier output still serves. */
            try {
              src = await rewriteJsBody(src, target);
            } catch (err) {
              DIAG.emit({
                category: "REWRITE",
                severity: "error",
                message: "script body pass failed",
                technicalReason: String(err),
                url: target,
              });
            }
            WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
            /* Issue B: the decoded-with-upstream-charset body is
               re-encoded UTF-8 by the string Response constructor;
               the served header must say so. */
            outHeaders.set("content-type", utf8ContentType(respCt));
            const out = new Response(src, { status: resp.status, headers: outHeaders });
            if (e.request.method === "GET") void pageCacheStore(e.request, out.clone());
            return out;
          }
          WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
          /* 1.7 Sulfide: attachment responses join the download
             registry. The body stays a stream - a counting passthrough
             forwards every chunk untouched, so the browser keeps
             writing the file to disk and nothing is buffered whole. */
          if (resp.body && (outHeaders.get("content-disposition") ?? "").toLowerCase().includes("attachment")) {
            const id = DL.begin(target, resp.headers, outHeaders.get("content-type") ?? "application/octet-stream", Number(resp.headers.get("content-length") ?? -1));
            return new Response(DL.wrap(id, resp.body), { status: resp.status, headers: outHeaders });
          }
          return new Response(resp.body, { status: resp.status, headers: outHeaders });
        } catch (err) {
          DIAG.failure({
            traceId,
            category: "TRANSPORT",
            cause: "upstream",
            stage: "REWRITE_FAILED",
            message: "proxied request failed",
            technicalReason: String(err),
            url: target,
          });
          WEBREQ.errorOccurred({ ...wrDetails, error: String(err) });
          /* Issue E: no transitRecord - errored, never completed (the
             netLog row carries the failure). */
          netLogPush({
            method: e.request.method, traceId,
            path: internalUrl,
            dest: target,
            status: 0,
            rtype: classifyRtype(dest, ""),
            ms: Date.now() - t0,
            bytes: -1,
            err: String(err),
            transport: decision.mode,
            fallbackReason: decision.fallbackReason,
            detail: mkDetail(),
          });
          /* Issue #3: failed navigations answer with the engine-owned
             error page (one honest category line, reason, trace id,
             retry, zl-error meta). Issue #32: the target URL is not
             printed - it lives in the privileged rings (netLog /
             diagnostics) and the embedder's devtools only, and the
             reason line is URL-redacted on the page. Every other
             destination keeps the honest 502 plain text body -
             subresources get no UI. */
          if (e.request.mode === "navigate") {
            return new Response(
              errorPage({
                route: url.pathname + url.search,
                category: classifyFailure(String(err)),
                engineVersion: ZEOLITE_VERSION,
                reason: String(err),
                traceId,
                status: 502,
              }),
              { status: 502, headers: { "content-type": "text/html; charset=utf-8" } },
            );
          }
          return new Response(`zeolite: upstream fetch failed: ${String(err)}`, {
            status: 502,
            headers: { "content-type": "text/plain" },
          });
        }
      })();
    })(),
  );
});

/** Per-request header surgery: drop hop-by-hop + engine-origin leaks,
    restore the real destination as Referer. */
function forwardedHeaders(req: Request, target: string, initiator?: string): Headers {
  const out = new Headers();
  const skip = new Set(["host", "connection", "referer", "origin", "cookie", "sec-fetch-site"]);
  for (const [k, v] of req.headers) {
    if (!skip.has(k.toLowerCase())) out.set(k, v);
  }
  if (req.referrer) {
    const refU = new URL(req.referrer, self.location.origin);
    /* Mirror routes carry the page query in the route URL's search
       (b64u encodes it inside the tail); the Referer must match what
       direct browsing sends (issue #20). */
    const ref = decodePath(refU.pathname);
    if (ref) out.set("referer", ref + refU.search);
    /* Scout report (2026-10-06): a referrer whose path is not a
       decodable engine route used to drop the Referer silently.
       Referrer-dependent CSRF and analytics then misbehave with no
       trace why. Sending the raw engine route would leak the proxy
       origin upstream, so the header stays omitted - but the event
       is recorded instead of being swallowed. */
    else DIAG.emit({
      category: "TRANSPORT",
      severity: "warning",
      message: "engine-route referrer did not decode; Referer omitted",
      url: req.referrer,
    });
  }
  /* Issue #23: the virtual origin. Every request the page makes is
     same-origin on the engine side, so the browser Origin and
     Sec-Fetch-Site carry engine facts upstream sites never issued;
     strict-origin checks reject those POSTs (chatgpt.com). Recompute
     both from the virtual initiator; unknown initiator sends none. */
  const vo = virtualOriginHeaders(initiator, target, req.method, req.mode);
  if (vo.origin) out.set("origin", vo.origin);
  if (vo.secFetchSite) out.set("sec-fetch-site", vo.secFetchSite);
  if (!out.has("accept-language")) out.set("accept-language", "en-US,en;q=0.9");
  /* 1.8 Telluride: while a profile is active, the wire surface must
     match the document surface, so its UA and languages win over
     whatever the page sent. */
  const profile = getFpProfile();
  if (profile) {
    out.set("user-agent", profile.userAgent);
    out.set("accept-language", profile.languages.join(","));
  }
  return out;
}

/* ---- Control plane (Phase 2 + Phase 4) ---------------------------- */

interface ControlMessage {
  type:
    | "zl:config"
    | "zl:mint"
    | "zl:navHandle"
    | "zl:rules"
    | "zl:jarProfile"
    | "zl:siteRoute"
    | "zl:teardown"
    | "zl:ping"
    | "zl:getNetLog"
    | "zl:ext"
    | "zl:tabs"
    | "zl:menuClick"
    | "zl:listMenus"
    | "zl:notifyEvent"
    | "zl:extPage"
    | "zl:openExtPage"
    | "zl:listExt"
    | "zl:getDiag"
    | "zl:installExt"
    | "zl:installExtFiles"
    | "zl:extEnable"
    | "zl:extInfo"
    | "zl:adblock"
    | "zl:tracing"
    | "zl:getTracing"
    | "zl:wsOpen"
    | "zl:docCookie"
    | "zl:downloads"
    | "zl:cancelDownload"
    | "zl:downloadState"
    | "zl:exportSession"
    | "zl:importSession"
    | "zl:sameSite"
    | "zl:fingerprint"
    | "zl:recordStart"
    | "zl:recordStop"
    | "zl:find"
    | "zl:getJars"
    | "zl:clearJar"
    | "zl:transport";
  extId?: string;
  msg?: unknown;
  prefix?: string;
  /** zl:config route scheme. Fixed "b64u" since #32; any other value
      is rejected (mirror removed). Kept optional for old embedders. */
  scheme?: string;
  /** zl:config: opt-in engine-side HTTPS upgrade (#53). Absent keeps
      the persisted choice; the ack echoes the live value. */
  httpsUpgrade?: boolean;
  /** zl:config: opt-in refusal of the plaintext ?url= initial
      navigation (#63). Absent keeps the persisted choice (legacy
      ?url= accepted, the migration window); the ack echoes the live
      value. Hosts that navigate via zl:navHandle set this so no
      plaintext embed can appear on the deployment afterwards. */
  navHandles?: boolean;
  /** zl:transport: engine selection (#64). Absent = a poll; the reply carries the live engine; "libcurl"|"epoxy" switches it on the next init(). */
  engine?: "libcurl" | "epoxy";
  /** zl:rules: default outgoing user-agent for hosts without an
      override (null/absent keeps the browser's own UA). */
  ua?: string | null;
  /** zl:rules: host-app per-site overrides, longest host suffix wins. */
  rules?: Array<{ host: string; adblock?: boolean; ua?: string | null }>;
  site?: string;
  enabled?: boolean;
  /** UI -> SW authoritative tab sync payload. */
  tabs?: UiTab[];
  /** Delta sync cursor for zl:getNetLog. */
  since?: number;
  /** zl:wsOpen: page WebSocket bridge destination + protocols. */
  url?: string;
  protocols?: string[];
  /** zl:docCookie / zl:wsOpen origin claim from the page. Bug-scout
      fix: the handlers never trust this field; any proxied page
      could claim another site's origin and reach its jar cookies or
      forge the WS handshake identity. The sender's own client
      route is the only source. Documents what pages still send. */
  origin?: string;
  set?: string;
  /** zl:cancelDownload: registry entry id. */
  id?: string;
  /** zl:exportSession / zl:importSession: blob passphrase. */
  passphrase?: string;
  /** zl:importSession: the encrypted session blob. */
  blob?: unknown;
  /** zl:importSession: "replace" (default) or "merge" (2.2 Arsenide). */
  mode?: "replace" | "merge";
  /** zl:importSession merge conflict rule. */
  rule?: string;
  /** zl:sameSite: jar SameSite policy knob ("off" | "approx"). */
  policy?: unknown;
  /** zl:exportSession: caller-supplied payload, encrypted whole. */
  extra?: unknown;
  /** zl:fingerprint: profile object, or null to return to native. */
  profile?: unknown;
  /** zl:recordStart: caller-supplied recording id. */
  recId?: string;
  /** zl:installExt: packaged (.xpi/.zip) bytes. */
  bytes?: Uint8Array;
  /** zl:installExtFiles: unpacked directory listing, path -> bytes. */
  files?: Array<[string, Uint8Array]>;
  /** zl:find (#29): destination of the addressed page, matched
      SW-side against the client whose route decodes to it. The
      findLoad message posted to the page carries no destination
      (#32: no page-visible surface echoes the target). */
  dest?: string;
  /** zl:find command: search, step or clear. */
  cmd?: "find" | "next" | "prev" | "clear";
  /** zl:find search pattern (cmd "find"). */
  pattern?: string;
  /** zl:find options: caseSensitive, wholeWord and wrap (default
      true), passed through to the page-side finder. */
  options?: { caseSensitive?: boolean; wholeWord?: boolean; wrap?: boolean };
}

/* #29 (zl:find): the compiled page-side finder ships to the page
   inside the findLoad message. The bundle is a sibling artifact of
   this worker (finder.js, built from src/finder.ts), fetched once
   per SW instance - worker-own fetches never re-enter this fetch
   handler - and cached in the closure. An unavailable bundle answers
   the find command honestly instead of pretending. */
let finderSource: Promise<string | null> | null = null;
function loadFinderSource(): Promise<string | null> {
  finderSource ??= fetch(new URL("finder.js", self.location.href))
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  return finderSource;
}

/* Bug-scout fix: control-plane messages used to trust msg.origin, so
   any proxied page could claim another site's origin; jar cookie
   reads and writes via zl:docCookie, a forged per-origin WS handshake
   identity via zl:wsOpen. The sender's real origin is recovered from
   its own client route instead; the claim is never read. Unknown or
   non-proxied senders fail closed (null). */
function senderOrigin(e: ExtendableMessageEvent): string | null {
  const client = e.source;
  if (client && "url" in client) {
    return senderVirtualOrigin(client.url, self.location.origin);
  }
  return null;
}

/* #35 (browser E2E): docCookie port registry. The page's synchronous
   document.cookie getter serves an optimistic copy refreshed over the
   zl:docCookie port; a Set-Cookie admitted on a proxied fetch/XHR
   response used to stay invisible until the page's next read. The
   fetch path pushes the fresh jar view over the same port right after
   admission. Keyed by client id; capped so a page that keeps
   re-opening docCookie channels cannot grow the map without bound
   (the oldest entry is dropped, its port simply stops receiving
   pushes - reads still refresh on demand). */
/* #41: jar control is host-only. Proxied pages are SW clients too,
   and zl:getJars must never hand one target site every other site's
   cookies: the sender must be a host page (adapter, devtools), not a
   proxied route or nav marker. #48: extension-origin pages are
   extension code, not host pages, so they are untrusted here too. */
function senderIsProxiedPage(e: ExtendableMessageEvent): boolean {
  const src = e.source as Client | null;
  if (!src || !src.url) return true;
  try {
    return senderIsProxiedPath(new URL(src.url, self.location.origin).pathname);
  } catch {
    return true;
  }
}

/* Page-facing control messages and the pathname half of the sender
   gate live in cpgate.ts (extracted for #63 so vitest can pin them). */

self.addEventListener("message", async (e: ExtendableMessageEvent) => {
  /* Issue #17: the restored route shape settles asynchronously; a
     cold-start ping must not report the default shape mid-restore.
     Registry-dependent answers also wait for the restart-safe
     init, so a just-restarted worker serves real state. */
  await routeReady;
  await initReady;
  const msg = e.data as ControlMessage;
  const port = e.ports[0];
  const reply = (payload: unknown) => port?.postMessage(payload);

  /* Bug-scout (#41): a proxied page must not drive the control plane
     (read the net log, flip the jar, tear the engine down). Page-facing
     messages only; everything else needs a host sender. #48:
     extension-origin pages are extension code, not host pages - the
     sole exception is zl:extPage, and only from the client registered
     as that exact extension's page (the case re-checks it). */
  if (senderIsProxiedPage(e) && !PAGE_MESSAGES.has(String(msg?.type))) {
    const src = e.source as Client | null;
    const srcId = src && src.url ? src.id : "";
    const isExtPageCall =
      msg?.type === "zl:extPage" &&
      typeof msg?.extId === "string" &&
      srcId !== "" &&
      pageClientOf(srcId) === msg.extId;
    if (!isExtPageCall) {
      reply({ ok: false, error: "host-only control message" });
      return;
    }
  }

  switch (msg?.type) {
    case "zl:ping":
      /* Issue #17: echo the live route shape so embedders can detect a
         revert to defaults (worker restart, storage wipe) and re-push
         their config. */
      reply({
        ok: true,
        version: ZEOLITE_VERSION,
        degraded: getEngineDegraded(),
        prefix: currentPrefix(),
        /* Fixed shape since #32 (mirror removed); kept in the reply so
           old embedder probes that compare it stay compatible. */
        scheme: "b64u",
        httpsUpgrade: isHttpsUpgrade(),
        /* #63: the live ?url= refusal choice, so an embedder detects a
           revert to defaults and re-pushes its config. */
        navHandles: navHandlesEnabled(),
        profile: jarProfileState(),
      });
      break;
    case "zl:config": {
      // Rotate the URL shape at runtime.
      /* Issue #32: the mirror scheme is gone (it placed the real
         destination inside every browser-visible route string);
         a non-default scheme is rejected so an embedder learns
         immediately instead of silently degrading. */
      if (typeof msg.scheme === "string" && msg.scheme !== "b64u") {
        reply({ ok: false, error: "scheme removed: routes are b64u only (#32)" });
        break;
      }
      /* #53: absent leaves the persisted choice (old embedders). */
      if (typeof msg.httpsUpgrade === "boolean") setHttpsUpgrade(msg.httpsUpgrade);
      /* #63: same migration-window rule for the ?url= refusal. */
      if (typeof msg.navHandles === "boolean") setNavHandles(msg.navHandles);
      setScheme(msg.prefix ?? "/j/");
      /* Issue #17: persist so a worker restart keeps the shape. */
      void persistRoute(currentPrefix());
      reply({ ok: true, prefix: currentPrefix(), scheme: "b64u", httpsUpgrade: isHttpsUpgrade(), navHandles: navHandlesEnabled() });
      break;
    }
    case "zl:mint": {
      /* #55/#54: mint an opaque route for a destination. The reply
         carries the route only, never the key: the key must not
         leave the worker realm. #54 residual 1 admits proxied
         pages to this case: a page can already construct a legacy
         route for any destination (the codec is page-public), so
         minting grants no new capability; mints are bounded to
         absolute http(s) destinations (mintableDest). With no key
         active (storage unavailable) this still answers, with a
         legacy route: the degraded mode, not an error. */
      if (typeof msg.dest !== "string" || !mintableDest(msg.dest)) {
        reply({ ok: false, error: "mint needs an absolute http(s) dest" });
        break;
      }
      reply({ ok: true, route: encodeDest(msg.dest) });
      break;
    }
    case "zl:navHandle": {
      /* #63 (#54 design D): mint the opaque initial-navigation
         handle. Host-only by the #41 gate: zl:navHandle is not in
         PAGE_MESSAGES, so a proxied-page sender is refused above
         before this case ever runs - a page must not be able to mint
         initial-navigation handles for arbitrary destinations. The
         handle is a keyed token with a short TTL, stateless by
         construction: nothing is persisted, so it survives a SW
         restart (decode walks the route-key history the same way
         routes do). Without a route key (storage unavailable) this
         refuses instead of answering a legacy-shape handle, which
         would carry the destination decodably - exactly the leak
         the handle exists to stop. */
      if (typeof msg.dest !== "string" || !mintableDest(msg.dest)) {
        reply({ ok: false, error: "navHandle needs an absolute http(s) dest" });
        break;
      }
      const token = encodeNavHandle(msg.dest);
      if (token === null) {
        reply({ ok: false, error: "navHandle unavailable: no route key (storage degraded); keep the legacy ?url= embed" });
        break;
      }
      reply({ ok: true, url: NAVH + "/" + token });
      break;
    }
    case "zl:adblock":
      /* Host toggle for the compiled rules (the migrated ad/tracker
         lists in /rules.json). Data stays loaded; decisions become
         no-ops while disabled. Resets to enabled on SW restart. */
      setRulesEnabled(msg.enabled !== false);
      reply({ ok: true });
      break;
    case "zl:rules":
      /* Host-app per-site rules (the rules chip / per-site settings):
         a host-scoped adblock override plus UA strings, evaluated per
         request against the target host (rules.ts). Ephemeral like
         zl:adblock: resets on SW restart, the host re-sends on boot. */
      reply({ ok: true, count: setSiteOverrides(msg.rules, msg.ua) });
      break;
    case "zl:jarProfile":
      /* Host-app jar identity (incognito): switch the whole cookie
         jar between the durable default profile and a throwaway
         session profile. Session cookies never touch IndexedDB and
         are dropped on the switch back (cookies.ts). Resets to
         default on SW restart; the host re-sends on boot, on the
         incognito toggle, and on controllerchange. */
      reply(setJarProfile(msg.profile));
      break;
    case "zl:getJars":
      /* #41: jar enumeration for the host (LobsterBrowse Settings
         renders and manages cookie-jar state). Host-only: the
         proxied-sender gate above refuses target-site pages. */
      reply({ ok: true, active: jarProfileState(), profiles: jarEnumeration() });
      break;
    case "zl:clearJar": {
      /* #41: clear the active (or named) jar profile, or one origin
         inside it. Refuses malformed input instead of coercing. */
      const r = jarClearScope(msg.profile, msg.origin);
      reply(r.ok ? { ok: true, jars: r.jars, cookies: r.cookies } : { ok: false, error: r.error });
      break;
    }
        case "zl:transport": {
      /* #64: host-side engine selection (the DevTools toggle).
         No engine = a poll (devtools keeps its select in
         sync, the same pattern as the tracing toggle); an
         invalid engine refuses honestly; a valid one
         switches the transport for the NEXT init(): the
         running client keeps its engine until the service
         worker restarts, and the switchEngine seam forces the
         re-init on the next request. Ephemeral like the
         other host toggles: resets to the deployment
         default (ZL_TRANSPORT) on SW restart. */
      const eng = (msg as { engine?: unknown }).engine;
      if (eng === undefined) {
        reply({ ok: true, engine: currentEngine() });
      } else if (eng !== "libcurl" && eng !== "epoxy") {
        reply({ ok: false, error: "transport needs engine libcurl|epoxy" });
      } else {
        wispTransport.switchEngine(eng);
        reply({ ok: true, engine: currentEngine() });
      }
      break;
    }
case "zl:tracing":
      /* 1.2 Halide: opt-in rewrite tracing ring. Off by default;
         resets to off on SW restart, so the host re-sends it. */
      setTracing(msg.enabled !== false);
      reply({ ok: true, enabled: msg.enabled !== false });
      break;
    case "zl:getTracing": {
      /* Delta poll, same cursor protocol as zl:getNetLog, generation
         included so a devtools that reconnected across a worker
         restart resets its tracing cursor like the netLog one. */
      const since = (msg as { since?: number }).since ?? 0;
      reply({ ok: true, generation: netLogGeneration(), ...tracingSnapshot(since) });
      break;
    }
    case "zl:siteRoute":
      if (!msg.site) {
        reply({ ok: false, error: "missing site" });
        break;
      }
      setSiteEnabled(msg.site, msg.enabled !== false);
      reply({ ok: true });
      break;
    case "zl:wsOpen": {
      /* 1.3 Carbide: the port IS the connection: events flow back on
         it, send/close flow forward on it. */
      if (!port || typeof msg.url !== "string" || !/^wss?:/i.test(msg.url)) {
        port?.postMessage({ ev: "error", error: "bad zl:wsOpen" });
        port?.postMessage({ ev: "close", code: 1006, clean: false });
        port?.close();
        break;
      }
      /* Issue #4: an all-cached page can open a WebSocket before any
         proxied fetch initialized the transport; openWebSocket would
         throw on the uninitialized client and every bridge ws closed
         1006. Wait for the transport here (sends queue at the bridge
         until the handshake completes). */
      try {
        await wispTransport.ready();
      } catch {
        port.postMessage({ ev: "error", error: "transport unavailable" });
        port.postMessage({ ev: "close", code: 1006, clean: false });
        port.close();
        break;
      }
      /* Deep-integration item 4: per-origin virtual WS identities. The
         handshake carries the initiator's virtual origin, the jar's
         cookies for the target and the per-site UA (an active
         fingerprint profile still wins), instead of the single
         bridge identity every proxied site used to share. The origin
         is an explicit message field when the sender knows it, else
         recovered from the controlling client's route - the same
         initiator recovery the fetch path uses (works for
         worker-relayed sockets too, since the relay runs in the page
         context). Headers are engine-built only: a page can never
         smuggle handshake headers onto the transport. */
      /* Bug-scout fix: msg.origin was a spoof vector (any proxied
         page could forge the per-origin handshake identity). The
         sender's own client route is the only source; worker-relayed
         sockets resolve to their page the same way. Unknown sender
         means no Origin header, honest absence. */
      let wsOrigin: string | null = senderOrigin(e);
      /* Issue #32: the page shim no longer retargets same-origin ws
         URLs (it never sees the real origin). An engine-origin ws URL
         carries no destination: the sender's own virtual context
         (#33) supplies the target; the sender's client route decodes
         as the restart fallback; an unknown sender fails closed.
         Cross-origin URLs pass through: the page named that host
         itself. Worker-relayed sockets arrive via their page's relay,
         so they resolve against the page context, same as before. */
      let wsUrl = msg.url;
      try {
        const u = new URL(msg.url);
        if (u.origin === self.location.origin) {
          let home = contextOf(VCTX, (e.source as { id?: string } | null)?.id)?.targetOrigin ?? null;
          if (!home) {
            const client = e.source;
            const cu = client && "url" in client ? decodePath(new URL((client as { url: string }).url, self.location.origin).pathname) : null;
            home = cu ? new URL(cu).origin : null;
          }
          if (!home) {
            port.postMessage({ ev: "error", error: "unknown ws context" });
            port.postMessage({ ev: "close", code: 1006, clean: false });
            port.close();
            break;
          }
          const t = new URL(u.pathname + u.search, home);
          t.protocol = u.protocol;
          wsUrl = t.href;
        }
      } catch {
        /* unparseable URL: the wss?: validation already answered */
      }
      const wsHeaders = wsIdentityHeaders(wsOrigin, wsUrl, {
        profile: getFpProfile(),
      });
      wsBridge.open(port as unknown as PortLike, wsUrl, Array.isArray(msg.protocols) ? msg.protocols : [], wsHeaders);
      break;
    }
    case "zl:docCookie": {
      /* 1.6 Hydride: single-channel document.cookie sync. The port
         is transferred once and kept; the initial message and every
         follow-up on the port is answered with the authoritative jar
         view, so the page-side cache stays eventually consistent
         without a fresh MessageChannel per read/write. */
      /* Bug-scout fix: msg.origin was a spoof vector; any proxied
         page could read or write another site's jar cookies by
         claiming its origin. The sender's own client route decides
         the jar; the claim is never read. */
      const origin = senderOrigin(e);
      if (!port || !origin) {
        reply({ ok: false, error: "bad zl:docCookie" });
        break;
      }
      const handle = (set?: unknown) => {
        if (typeof set === "string") documentCookieWrite(origin, set);
        port.postMessage({ ok: true, cookie: documentCookieRead(origin) });
      };
      handle(msg.set);
      port.onmessage = (ev) => handle((ev.data as { set?: unknown }).set);
      /* #35: keep the port so the fetch path can push jar updates
         (Set-Cookie on a proxied response) into this client's
         optimistic document.cookie copy. Same origin-trust rule as the
         reads above: the jar was fixed by senderOrigin, the page can
         claim nothing. */
      const cid = (e.source as { id?: string } | null)?.id;
      if (cid) registerDocCookiePort(cid, port, origin);
      break;
    }
    case "zl:fingerprint":
      /* 1.8 Telluride: resolve + compile the profile, or drop back to
         fully native surfaces. */
      reply(setFingerprint(msg.profile ?? null));
      break;
    case "zl:recordStart": {
      /* 1.9 Fullerene: deterministic session recording. Forcing the
         tracing ring on is a recording side effect, not a silent
         surveillance default: recording is always explicit. */
      if (rec) {
        reply({ ok: false, error: "recording already active: " + rec.id });
        break;
      }
      const snap = tracingSnapshot(0);
      rec = beginRecording({
        id: msg.recId,
        now: Date.now(),
        netCursor: netLogCursor(),
        traceCursor: snap.lastSeq,
        tracingWasEnabled: snap.enabled,
      });
      setTracing(true);
      reply({ ok: true, record: { id: rec.id, startedAt: rec.startedAt } });
      break;
    }
    case "zl:recordStop": {
      if (!rec) {
        reply({ ok: false, error: "no recording active" });
        break;
      }
      const r = rec;
      rec = null;
      const record = finishRecording(r, {
        now: Date.now(),
        engine: ZEOLITE_VERSION,
        netEntries: netLogSince(r.netCursor),
        traceEntries: tracingSnapshot(r.traceCursor).entries,
        cookieJar: [...jarSnapshot()],
      });
      setTracing(r.tracingWasEnabled);
      reply({ ok: true, record });
      break;
    }
    case "zl:find": {
      /* #29: in-page find. The SW cannot touch page DOM, so the
         command is forwarded to the page whose client route decodes
         to msg.dest exactly (addressing is fully SW-side; the
         findLoad message itself carries no destination, #32); that
         page runs the compiled finder, whose
         source is attached to the message and evaluated once per
         document by the bootstrap loader. Replies flow back on the
         transferred port; a page that never answers - no proxied
         document at dest, or one without the bootstrap - fails
         honestly on the timeout instead of hanging the find bar. */
      if (
        !port ||
        typeof msg.dest !== "string" ||
        (msg.cmd !== "find" && msg.cmd !== "next" && msg.cmd !== "prev" && msg.cmd !== "clear") ||
        (msg.cmd === "find" && typeof msg.pattern !== "string")
      ) {
        reply({ ok: false, error: "bad zl:find" });
        break;
      }
      e.waitUntil(
        (async () => {
          const code = await loadFinderSource();
          if (code === null) {
            reply({ ok: false, error: "finder bundle unavailable" });
            return;
          }
          const mc = new MessageChannel();
          let done = false;
          let timer: ReturnType<typeof setTimeout>;
          const finish = (payload: {
            ok: boolean;
            error?: string;
            matches?: number;
            ordinal?: number;
            highlight?: string;
          }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reply(payload);
            mc.port1.close();
          };
          timer = setTimeout(() => finish({ ok: false, error: "find: page did not answer" }), 10000);
          mc.port1.onmessage = (ev) => {
            const d = ev.data as {
              ok?: boolean;
              error?: string;
              matches?: number;
              ordinal?: number;
              highlight?: string;
            };
            finish(
              d && typeof d.ok === "boolean"
                ? { ok: d.ok, error: d.error, matches: d.matches, ordinal: d.ordinal, highlight: d.highlight }
                : { ok: false, error: "bad find reply" },
            );
          };
          const cs = await self.clients.matchAll({ type: "window" });
          let target: Client | null = null;
          for (const c of cs) {
            try {
              const cu = new URL(c.url, self.location.origin);
              if (decodePath(cu.pathname) + cu.search === msg.dest) {
                target = c;
                break;
              }
            } catch { /* not a routable client URL: skip */ }
          }
          if (!target) {
            finish({ ok: false, error: "find: no proxied page at dest" });
            return;
          }
          target.postMessage(
            { type: "zl:findLoad", cmd: msg.cmd, pattern: msg.pattern, options: msg.options, code },
            [mc.port2],
          );
        })(),
      );
      break;
    }
    case "zl:downloads":
      /* 1.7 Sulfide: registry snapshot, newest first. */
      reply({ ok: true, downloads: DL.snapshot() });
      break;
    case "zl:cancelDownload": {
      const id = msg.id;
      if (typeof id !== "string") {
        reply({ ok: false, error: "missing id" });
        break;
      }
      reply({ ok: DL.cancel(id) });
      break;
    }
    case "zl:downloadState": {
      /* #44: the UI host reports a zl:downloadOp handoff's progress
         or outcome (normally fire-and-forget, no reply port; a port
         gets the acknowledgement). Terminal states are final: later
         reports for the same id are refused. Delivery wakes the
         owning extension's background first, same as menu clicks. */
      const ds = msg as { id?: unknown; status?: unknown; received?: unknown; size?: unknown; error?: unknown };
      const applied =
        typeof ds.id === "number" && typeof ds.status === "string"
          ? DOWNLOADS.applyState(ds.id, ds.status, ds)
          : null;
      if (!applied) {
        reply({ ok: false, error: "unknown or finished download id" });
        break;
      }
      e.waitUntil(
        wakeExtension(applied.extId).then(() => DOWNLOADS.notify(applied.extId, applied.delta)),
      );
      reply({ ok: true });
      break;
    }
    case "zl:exportSession": {
      /* 1.7 Sulfide: encrypted session export (cookies + tabs +
         caller extras). The passphrase only ever lives in this
         message; the blob carries ciphertext. */
      const pass = msg.passphrase;
      if (typeof pass !== "string" || pass.length < 8) {
        reply({ ok: false, error: "passphrase must be at least 8 characters" });
        break;
      }
      e.waitUntil(
        (async () => {
          try {
            reply({
              ok: true,
              blob: await encryptSession(pass, {
                version: ZEOLITE_VERSION,
                created: Date.now(),
                cookies: [...jarSnapshot()],
                tabs: TABS.list(),
                extra: msg.extra ?? null,
              }),
            });
          } catch (err) {
            reply({ ok: false, error: String(err) });
          }
        })(),
      );
      break;
    }
    case "zl:importSession": {
      const pass = msg.passphrase;
      if (typeof pass !== "string" || msg.blob === null || typeof msg.blob !== "object") {
        reply({ ok: false, error: "missing passphrase or blob" });
        break;
      }
      e.waitUntil(
        (async () => {
          try {
            const data = (await decryptSession(pass, msg.blob)) as {
              cookies?: Array<[string, unknown[]]>;
              extra?: unknown;
            };
            if (!Array.isArray(data.cookies)) throw new Error("no cookies in session blob");
            /* 2.2 Arsenide: merge mode with a per-cookie conflict rule;
               replace stays the default so existing callers are
               unchanged. */
            if (msg.mode === "merge") {
              const rule: JarConflictRule =
                msg.rule === "import-wins" || msg.rule === "keep-newest" ? msg.rule : "keep-existing";
              const counts = jarMerge(data.cookies, rule);
              reply({ ok: true, extra: data.extra ?? null, merged: counts });
            } else {
              jarReplace(data.cookies);
              reply({ ok: true, extra: data.extra ?? null });
            }
          } catch (err) {
            reply({ ok: false, error: String(err) });
          }
        })(),
      );
      break;
    }
    case "zl:sameSite":
      /* 2.2 Arsenide: opt-in SameSite policy knob on the jar. Unknown
         values fall back to "off" and the reply reports the effective
         policy so the caller cannot believe a bogus knob landed. */
      reply({ ok: true, policy: setSameSitePolicy(msg.policy) });
      break;
    case "zl:teardown":
      e.waitUntil(
        (async () => {
          // Close every bridged WebSocket first: no dangling streams.
          wsBridge.closeAll();
          // 1.4 Boride: cookies do not survive an engine switch.
          jarClear();
          // Drop every cache this SW owns, then unregister. Existing
          // pages lose their controller on next navigation; the adapter
          // also reloads them.
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
          reply({ ok: true });
          await self.registration.unregister();
        })(),
      );
      break;
    case "zl:getNetLog": {
      // Delta sync: the devtools page sends the last seq it has seen and
      // gets only newer entries, so polling stays cheap at any ring size.
      const since = (msg as { since?: number }).since ?? 0;
      reply({ entries: netLogSince(since), lastSeq: netLogCursor(), generation: netLogGeneration(),
          version: ZEOLITE_VERSION, stats: transitStats() });
      break;
    }
    case "zl:getDiag": {
      /* UI -> SW: diagnostics delta poll. Same cursor protocol as
         zl:getNetLog so the devtools page can poll both cheaply. */
      const since = (msg as { since?: number }).since ?? 0;
      reply({ ok: true, ...DIAG.snapshot(since) });
      break;
    }
    case "zl:ext": {
      /* Content-script bridge traffic from a controlled page. Real
         host verification: the sender page's destination must match
         the extension's declared content-script patterns. */
      const em = msg as { extId?: string; msg?: unknown };
      const extId = em.extId;
      if (!extId) {
        reply({ ok: false, error: "missing extId" });
        break;
      }
      e.waitUntil(
        handleExtMessage(e, { extId, msg: em.msg }).then(
          (r) => reply(r),
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:tabs": {
      /* Authoritative tab list from the UI. The registry diffs it,
         fires tab events, and resolves pending extension ops. */
      if (!Array.isArray(msg.tabs)) {
        reply({ ok: false, error: "missing tabs" });
        break;
      }
      TABS.syncFromUi(msg.tabs);
      reply({ ok: true });
      break;
    }
    case "zl:listExt": {
      /* UI -> SW: the extensions toolbar panel wants the installed
         list. Summary only: no manifest, no permissions, no paths. */
      reply({
        ok: true,
        extensions: extensions.list().map((r) => ({
          id: r.id,
          name: r.name,
          version: r.version,
          state: r.state,
          enabled: r.enabled,
          lastError: r.lastError,
        })),
      });
      break;
    }
    case "zl:installExt": {
      /* UI -> SW: install a packaged extension. The manager owns every
         validation (zip limits, manifest parse, permission grants);
         a bad package lands that extension in ERROR, not the host. */
      const em = msg as { bytes?: Uint8Array };
      if (!(em.bytes instanceof Uint8Array)) {
        reply({ ok: false, error: "missing package bytes" });
        break;
      }
      e.waitUntil(
        extensions.installFromZip(em.bytes).then(
          async (r) => {
            /* A live worker never re-runs bootEnabled (activation
               only), so the fresh background boots right here. */
            await bootInstalled(r.id);
            reply({
              ok: true,
              id: r.id,
              warnings: r.warnings,
              unsupportedFields: r.unsupportedFields,
            });
          },
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:installExtFiles": {
      /* UI -> SW: install an unpacked extension (a directory listing
         the UI built from a picked folder). Same manager path. */
      const em = msg as { files?: Array<[string, Uint8Array]> };
      const map = new Map<string, Uint8Array>();
      if (Array.isArray(em.files)) {
        for (const entry of em.files) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1] instanceof Uint8Array) {
            map.set(entry[0], entry[1]);
          }
        }
      }
      if (map.size === 0) {
        reply({ ok: false, error: "no usable files" });
        break;
      }
      e.waitUntil(
        extensions.installFiles(map).then(
          async (r) => {
            /* Same as zl:installExt: boot the fresh background now. */
            await bootInstalled(r.id);
            reply({
              ok: true,
              id: r.id,
              warnings: r.warnings,
              unsupportedFields: r.unsupportedFields,
            });
          },
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:extEnable": {
      /* UI -> SW: enable/disable an installed extension. State
         persists in the manager's IndexedDB store. */
      if (!msg.extId || typeof msg.enabled !== "boolean") {
        reply({ ok: false, error: "bad zl:extEnable" });
        break;
      }
      e.waitUntil(
        extensions.setEnabled(msg.extId, msg.enabled).then(
          () => reply({ ok: true }),
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:extInfo": {
      /* UI -> SW: one extension's detail card. The panel already has
         the summary from zl:listExt; this adds the manifest surface
         the customize/options affordances need. */
      const rec = msg.extId ? extensions.get(msg.extId) : null;
      if (!rec) {
        reply({ ok: false, error: "no such extension" });
        break;
      }
      const manifest = rec.manifest as Record<string, unknown>;
      reply({
        ok: true,
        extension: {
          id: rec.id,
          name: rec.name,
          version: rec.version,
          description: typeof manifest.description === "string" ? manifest.description : "",
          state: rec.state,
          enabled: rec.enabled,
          lastError: rec.lastError,
          permissions: rec.permissions,
          hostPermissions: rec.hostPermissions,
          contentScripts: rec.contentScripts.length,
          optionsPath: rec.options ? rec.options.page : null,
        },
      });
      break;
    }
    case "zl:menuClick": {
      /* UI -> SW: a context-menu item was clicked on a proxied page.
         The tab is resolved through the tabs bridge so the extension
         gets a real permission-gated Tab object. */
      const em = msg as { extId?: string; msg?: unknown };
      const info = em.msg as { menuItemId?: unknown; pageUrl?: unknown } | undefined;
      if (
        !em.extId ||
        !info ||
        typeof info.menuItemId !== "string" ||
        typeof info.pageUrl !== "string"
      ) {
        reply({ ok: false, error: "bad menuClick" });
        break;
      }
      const rec = extensions.get(em.extId);
      if (!rec || !rec.enabled) {
        reply({ ok: false, error: "no such extension" });
        break;
      }
      const tab = TABS.list().find((t) => t.url === info.pageUrl) ?? null;
      /* Menu clicks wake an idle MV3 service-worker background; the
         click delivery itself must outlive this message handler. */
      e.waitUntil(
        wakeExtension(rec.id).then(() => {
          MENUS.click(
            rec.id,
            { menuItemId: String(info.menuItemId), pageUrl: String(info.pageUrl) },
            tab ? tabView(rec, tab) : null,
          );
        }),
      );
      reply({ ok: true });
      break;
    }
    case "zl:listMenus": {
      /* #45: the host lists registered context-menu items so it can
         render a real menu surface. Enabled extensions only; an
         explicit extId must resolve to an enabled extension. */
      const rec = msg.extId ? extensions.get(msg.extId) : null;
      if (msg.extId && (!rec || !rec.enabled)) {
        reply({ ok: false, error: "no such enabled extension" });
        break;
      }
      const recs = rec ? [rec] : extensions.list().filter((r) => r.enabled);
      reply({ ok: true, menus: recs.flatMap((r) => MENUS.itemsFor(r.id)) });
      break;
    }
    case "zl:notifyEvent": {
      /* #43: the host reports a rendered notification's interaction
         back (clicked / closed / buttonClicked). The entry must
         exist and belong to the named enabled extension; delivery
         wakes an idle MV3 background first, same as menu clicks. */
      const ne = msg as { extId?: string; msg?: unknown };
      const info = ne.msg as { id?: unknown; event?: unknown; buttonIndex?: unknown } | undefined;
      const extId = typeof ne.extId === "string" ? ne.extId : "";
      const nid = typeof info?.id === "string" ? info.id : "";
      const kind: "clicked" | "closed" | "buttonClicked" | null =
        info?.event === "clicked" || info?.event === "closed" || info?.event === "buttonClicked"
          ? (info.event as "clicked" | "closed" | "buttonClicked")
          : null;
      const btn = typeof info?.buttonIndex === "number" ? info.buttonIndex : undefined;
      if (!extId || !nid || !kind || (kind === "buttonClicked" && btn === undefined)) {
        reply({ ok: false, error: "bad notifyEvent" });
        break;
      }
      const erec = extensions.get(extId);
      if (!erec || !erec.enabled || !NOTIFY.exists(extId, nid)) {
        reply({ ok: false, error: "no such notification" });
        break;
      }
      e.waitUntil(wakeExtension(extId).then(() => NOTIFY.event(extId, nid, kind, btn)));
      reply({ ok: true });
      break;
    }
    case "zl:extPage": {
      /* #40: RPC from an extension-origin page (options/popup). The
         sender must be a client registered as that extension's page:
         client ids are SW-observed on the granted navigation, so a
         hostile proxied page cannot forge one. The API subset is
         enforced in handleExtPageCall. */
      const ep = msg as { extId?: unknown; msg?: unknown };
      const src = e.source as Client | null;
      const extId = typeof ep.extId === "string" ? ep.extId : "";
      const srcId = src && src.url ? src.id : "";
      const srcUrl = src && src.url ? src.url : null;
      if (!extId || !srcId || pageClientOf(srcId) !== extId) {
        reply({ ok: false, error: "not an extension page" });
        break;
      }
      const erec = extensions.get(extId);
      if (!erec || !erec.enabled) {
        reply({ ok: false, error: "no such extension" });
        break;
      }
      const call = (ep.msg ?? {}) as { path?: unknown; args?: unknown };
      const path = Array.isArray(call.path) ? call.path : [];
      /* runtime.sendMessage needs the background booted to have
         listeners; other page calls answer from the shared context. */
      const wake =
        path[0] === "runtime" && path[1] === "sendMessage"
          ? wakeExtension(extId)
          : Promise.resolve();
      e.waitUntil(
        wake
          .then(() => handleExtPageCall(erec, srcUrl, call))
          .then(reply)
          .catch((err: unknown) => reply({ ok: false, error: String(err) })),
      );
      break;
    }
    case "zl:openExtPage": {
      /* #40: host-only. Resolves an extension's options or popup
         page, mints a 5-minute page token and answers the /zl-ext/
         URL the host should navigate a tab to. The token is the only
         way a first navigation gets past the WAR gate for a non-WAR
         page. */
      const op = msg as { extId?: unknown; which?: unknown };
      const which = op.which === "popup" ? "popup" : "options";
      const extId = typeof op.extId === "string" ? op.extId : "";
      const orec = extId ? extensions.get(extId) : null;
      const raw = which === "popup" ? orec?.action?.defaultPopup : orec?.options?.page;
      const norm = raw ? normalizeExtensionPath(raw.startsWith("/") ? raw : "/" + raw) : null;
      if (!orec || !orec.enabled || !norm) {
        reply({ ok: false, error: "no such " + which + " page" });
        break;
      }
      reply({ ok: true, url: EXT_ROUTE + orec.id + norm + "?zlPageTok=" + mintPageToken(orec.id, norm) });
      break;
    }
    default:
      reply({ ok: false, error: "unknown message" });
  }
});

/** Extension messages from content-script bridges. Deliver to the
    extension's background listeners or storage areas after verifying
    the sender page actually matches the extension's declared
    content_scripts. */
async function handleExtMessage(
  ev: ExtendableMessageEvent,
  m: { extId: string; msg: unknown },
): Promise<{ ok: boolean; response?: unknown; error?: string }> {
  const src = ev.source as Client | null;
  if (!src || !src.url) return { ok: false, error: "unknown sender" };
  const su = new URL(src.url, self.location.origin);
  const dest = decodePath(su.pathname) + su.search;
  if (!dest) return { ok: false, error: "unknown sender page" };
  const rec = extensions.get(m.extId);
  if (!rec || !rec.enabled) return { ok: false, error: "no such extension" };
  const matched = rec.contentScripts.some(
    (s) => contentScriptMatches(s, dest, false) || contentScriptMatches(s, dest, true),
  );
  if (!matched) {
    return { ok: false, error: "extension content scripts do not match this page" };
  }
  const msg = m.msg as Record<string, unknown> | null;
  if (msg && typeof msg === "object" && typeof msg.__zlTabReply === "string") {
    /* Content-script reply to a tabs.sendMessage: route it back to
       the pending promise (unknown nonces are ignored). */
    TABS.resolveTabMessage(String(msg.__zlTabReply), msg.response);
    return { ok: true };
  }
  if (msg && typeof msg === "object" && typeof msg.__zlTabError === "string") {
    TABS.rejectTabMessage(
      String(msg.__zlTabError),
      String(msg.error ?? "zeolite: content-script message failed"),
    );
    return { ok: true };
  }
  if (msg && typeof msg === "object" && typeof msg.__zlDomLoaded === "string") {
    /* Page-world bridge reports DOM readiness: the only honest
       onDOMContentLoaded source (see ./bridge). */
    WEBNAV.domContentLoaded(String(msg.__zlDomLoaded));
    return { ok: true };
  }
  if (msg && typeof msg === "object" && typeof msg.__zlStorage === "string") {
    if (!rec.permissions.includes("storage")) {
      return { ok: false, error: "storage permission not granted" };
    }
    const ctx = await getExtensionContext(rec);
    const area = (ctx.storage as unknown as Record<string, ExtensionStorageArea>)[
      String(msg.__zlStorage)
    ];
    if (!area) return { ok: false, error: "no such storage area" };
    const op = String(msg.op ?? "");
    let r: Promise<unknown>;
    if (op === "get") r = area.get(msg.keys as string | string[] | null);
    else if (op === "set") r = area.set(msg.items as Record<string, unknown>);
    else if (op === "remove") r = area.remove(msg.keys as string | string[]);
    else if (op === "clear") r = area.clear();
    else return { ok: false, error: "bad storage op" };
    return { ok: true, response: await r };
  }
  /* Wake an idle-terminated MV3 service-worker background so it can
     receive this message (persistent backgrounds are already live,
     and a crashed worker is never restarted). */
  await wakeExtension(rec.id);
  const response = await MESSENGER.sendMessage(rec.id, {
    extensionId: rec.id,
    context: "content",
    url: dest,
  }, m.msg);
  return { ok: true, response };
}


