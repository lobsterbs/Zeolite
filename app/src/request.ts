/* Zeolite request engine: the proxied request lifecycle, extracted
   from the service worker entrypoint (issue #82). Everything a
   request touches lives here - route decoding and resolution, the
   page cache, policy and transport selection, upstream execution
   with the SW-followed redirect hop chain, header surgery, the
   streaming rewrite branches, download adoption, strand/error
   handling and the netLog/diagnostics rows - with no externally
   observable change. sw.ts (the entrypoint and composition root)
   wires browser events to handleFetch and injects the worker's boot
   promise through initEngine.

   The transit decision surface is deliberately NOT reshaped here: a
   formal decision engine over NativeTransit is issue #94's scope;
   this module keeps calling decideTransport/refineWithContent at the
   same seams the old handler did. */
/// <reference lib="webworker" />
import { b64uDecode, b64uEncode, decodeNavHandle, decodePath, encodeDest, encodeDestLegacy, isEngineAsset, isEnginePath, isOpaqueUrl, isWorkerDestination, looksKeyedToken, NAVH, passChallengeRedirFixed, recoverPath, referrerDest, setRouteKeys, setScheme, unwrapDest, currentPrefix } from "./codec";

import { decodeBody, mapRefreshHeader, stripHostile, utf8ContentType } from "./headers";
import { loadRouteHistory, saveRouteKey } from "./routekey";
import { classifyForeign, preflightHeaders } from "./foreign";
import { NAV } from "./bootstrap/navguard";

import { planRange, ZL_RANGE_MAX } from "./range";
import { applyEngineCors } from "./cors";
import { classifyFailure, errorPage, type ErrorCategory } from "./errorpage";
import { rewriteModuleWorkerImports } from "./worker-imports";
import { decideTransport, refineWithContent, reasonOf, sniffsAsHtml, transitRecord, DOC_DESTS, JS_TRANSFORM_DESTS, type TransitDecision } from "./transit";
import { cssRewriteStream, isCss, isHtml, isJs, rawFrom, rewriteJsBody, rewriteStream, workerPrelude } from "./transform";
import { httpsUpgraded } from "./config";
import { ruleFor, siteRules } from "./siteconfig";
import { applyOnRequest, applyOnResponse } from "./plugins";
import { applyRules, loadRules, siteUaFor, type ResourceType } from "./rules";
import { runRequestInterception, runResponseInterception, BODY_LIMIT, type InterceptKind } from "./intercept";
import { DIAG, classifyStageFailure, type DiagStage } from "./diag";
/* #90: the adoptResponse seam lives in ./downloads; the downloads
   subsystem owns its own state and the request engine stays unaware
   of download tracking internals. */
import { adoptResponse } from "./downloads";
/* #89: the network inspector ring lives in ./netlog (bounded storage,
   redaction, generation stamp); the engine and the control plane are
   call sites. */
import { flatRed, netLogPush, type NetDetail } from "./netlog";
import { traceDecision } from "./tracing";

import { wispTransport } from "./transport";



import { virtualOriginHeaders } from "./origin";
import { capContexts, contextOf, establishContext, resolveRelative, VCTX_CAP } from "./vctx";
import { applySetCookie, cookieHeaderFor, isPassChallenge, jarHeaders, type CookieRequestContext } from "./cookies";
/* #87: the shared service-worker runtime state (per-client virtual
   contexts, route-shape toggles, route key, fingerprint profile +
   per-site profile cache) lives in ./swstate; the engine and the
   control plane are call sites. */
import { getFpProfile, getFpWorkerScript, isHttpsUpgrade, navHandlesEnabled, pushDocCookieView, setHttpsUpgrade, setNavHandles, setRouteKey, siteDisabled, siteProfileFor, VCTX, ZEOLITE_VERSION } from "./swstate";

import { CS_ROUTE, EXT_ROUTE, WEBNAV, WEBREQ, wrType, extensions, resolveContentScripts, serveExtensionAsset } from "./extensions";


declare const self: ServiceWorkerGlobalScope;

/* #82: sw.ts injects the worker's boot promise (netLog generation
   stamp, jar restore, download registry restore, extension startup)
   once it defines it; the engine awaits it at exactly the points the
   old handler did. A null-tolerant seam: the entrypoint always
   injects before any fetch event can arrive. */
let engineReady: Promise<void> | null = null;

export function initEngine(ready: Promise<void>): void {
  engineReady = ready;
}

/* ---- Header surgery ------------------------------------------------
   stripHostile() and mapRefreshHeader() live in ./headers (unit-gated
   in __tests__/leak.test.ts); the SW is the call-site layer. */
/* 2.2 Arsenide: bound on SW-followed redirect hops (the transport
   surfaces 3xx; the loop follows). Past the cap the 3xx is surfaced to
   the page with a mapped Location instead of looping forever. */
const MAX_REDIRECT_HOPS = 10;

/* ---- Page cache (ported from the v3 worker) -------------------- */
/* Cache-first for proxied GETs with stale-while-revalidate. Freshness
   honors Cache-Control: max-age when present (no-store skips the cache
   entirely); the fallback TTL is 10 minutes. 60-entry cap, FIFO
   eviction. x-zl-cached-at carries the stored-at time. */


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
      /* #94: ONE copy of the JS-transform destination set (the refresh
         skip must match the serve-time transform branches). */
      const jsServe =
        isWorkerDestination(req.destination) ||
        (JS_TRANSFORM_DESTS.has(req.destination) && isJs(hit));
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

/** #96: a service worker can never hand the page a bare 304: the
    browser's own cache completes wire 304s by splicing in a stored
    body (that is how it turns a revalidation into a cached 200),
    and a SW-served 304 has no stored body to splice, so it cannot
    complete a page fetch. The engine page cache is cache-first and
    never stores a copy for the resource being revalidated (only
    fresh 200s enter it), so there is no stored body to splice here
    either. The honest conversion is a synthesized 200 with a null
    body, the preserved validator headers, and an x-zl-not-modified
    marker consumers can check. */
export function surfaceNotModified(h: Headers): Response {
  const out = new Headers(h);
  out.set("x-zl-not-modified", "1");
  return new Response(null, { status: 200, headers: out });
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
export function reqDest(req: Request): string {
  if (req.destination) return req.destination;
  return (req.headers.get("sec-fetch-dest") ?? "").toLowerCase() || "empty";
}

/** Classify a request by destination plus response content-type.
    The devtools network panel filters on this; honest fallbacks only:
    unknown destinations and unknown content types report OTHER. */
export function classifyRtype(destHeader: string, contentType: string): string {
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
/* #82: computed per call, not at module eval, so the engine module
   stays importable under vitest (node has no self.registration);
   the value is identical for the worker lifetime (the registration
   scope never changes mid-evaluation). */
const routeKeyUrl = () => new URL("route-config.json", self.registration.scope).href;
export const routeReady: Promise<void> = (async () => {
  try {
    const hit = await (await caches.open(ZL_ROUTE_CACHE)).match(routeKeyUrl());
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

export async function persistRoute(prefix: string): Promise<void> {
  try {
    await (await caches.open(ZL_ROUTE_CACHE)).put(
      routeKeyUrl(),
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

/* #82: the engine's fetch entry point. The entrypoint (sw.ts)
   registers this directly on the fetch event. respondWith is armed
   here, not in the entrypoint, because the lifecycle needs
   clientId / resultingClientId alongside the request, and the
   synchronous passthrough checks (opaque schemes, the wisp
   endpoint, extension routes) run before respondWith is armed -
   the old listener's exact shape, one module away. */
export function handleFetch(e: FetchEvent): void {
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
          await engineReady;
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
      await engineReady;
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
          /* #94: the deny is an explicit transit decision, not just a
             verdict string: the row reads the same discriminated
             model the transport decision uses. */
          const webreqDecision: TransitDecision = { mode: "Blocked", reason: "BLOCKED_WEBREQUEST" };
          netLogPush({
            method: e.request.method, traceId,
            path: internalUrl,
            dest: target,
            status: 403,
            rtype: classifyRtype(dest, ""),
            ms: Date.now() - t0,
            bytes: -1,
            verdict: "blocked",
            transport: webreqDecision.mode,
            fallbackReason: reasonOf(webreqDecision),
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
          /* #94: the deny is an explicit transit decision (rules vs
             programmatic intercept gate). */
          const blockDecision: TransitDecision = { mode: "Blocked", reason: ruleDec.action === "block" ? "BLOCKED_RULES" : "BLOCKED_INTERCEPT" };
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
            transport: blockDecision.mode,
            fallbackReason: reasonOf(blockDecision),
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
            /* #95: a decision that leaves the native path is an
               explainable event on the always-on diag stream (the
               fallback ring + netLog row stay the per-request record;
               native is the default and stays row-only). */
            if (dec.mode === "RewriteFallback")
              DIAG.stage(traceId, "TRANSPORT_FALLBACK", { url: target, message: dec.reason });
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
              fallbackReason: reasonOf(dec),
              detail: mkDetail(hit),
            });
            WEBREQ.completed({ ...wrDetails, statusCode: hit.status });
            /* Range replies (206/416) own their header surgery (slice
               length, content-range): serve them untouched. */
            /* Defensive: the store gate only admits 200s, so a cached
               304 should be impossible - if one ever surfaces (legacy
               entries), serve it through the same marked-200
               conversion instead of hanging the page. */
            if (hit.status === 304) return surfaceNotModified(hit.headers);
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
        /* #95: track where the upstream lifecycle currently is, so a
           failure names the stage it broke at instead of one generic
           label (the hop chain, response surgery and every rewrite
           branch shared a single REWRITE_FAILED stage before). */
        let curStage: DiagStage = "UPSTREAM_REQUEST";
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
          curStage = "UPSTREAM_RESPONSE";
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
          if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
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
          /* #95: same explainable-decision event on the response path
             (every document, stylesheet and transformed script body
             lands here, so the reason is in the diag stream, not just
             the opt-in tracing ring). */
          if (dec.mode === "RewriteFallback")
            DIAG.stage(traceId, "TRANSPORT_FALLBACK", { url: target, message: dec.reason });
          traceDecision({ subsystem: "transport", rule: dec.mode, original: target, result: reasonOf(dec) ?? dec.mode, resource: rtype, traceId });
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
            fallbackReason: reasonOf(dec),
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
          const scriptServe = JS_TRANSFORM_DESTS.has(e.request.destination) && isJs(resp) && !!resp.body;
          if (
            e.request.method === "GET" &&
            !workerServe &&
            !scriptServe &&
            !(DOC_DESTS.has(dest) && respCt === "")
          ) {
            void pageCacheStore(e.request, resp.clone());
          }
          if ((isHtml(resp) || (respCt === "" && DOC_DESTS.has(dest) && resp.body)) && resp.body) {
            curStage = "REWRITE_STARTED";
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
            curStage = "REWRITE_STARTED";
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
            curStage = "REWRITE_STARTED";
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
            curStage = "REWRITE_STARTED";
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
          if (JS_TRANSFORM_DESTS.has(e.request.destination) && isJs(resp) && resp.body) {
            curStage = "REWRITE_STARTED";
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
          /* #96: surfaceNotModified above - a SW-served 304 cannot
             complete a page fetch, so the revalidation result is
             converted to a marked 200. */
          if (resp.status === 304) return surfaceNotModified(outHeaders);
          /* 1.7 Sulfide: attachment responses join the download
             registry. #90: the detection + registration now live in the
             downloads subsystem (adoptResponse); the body stays a
             stream - a counting passthrough forwards every chunk
             untouched, so the browser keeps writing the file to disk
             and nothing is buffered whole. */
          const dl = adoptResponse(target, resp, outHeaders, resp.status);
          if (dl) return dl;
          return new Response(resp.body, { status: resp.status, headers: outHeaders });
        } catch (err) {
          /* #95: the failure names the stage the request actually
             broke at; the classifier maps that stage to an honest
             category and cause (a rewrite failure was mislabeled
             TRANSPORT/upstream before). */
          const failure = classifyStageFailure(curStage);
          DIAG.failure({
            traceId,
            category: failure.category,
            cause: failure.cause,
            stage: curStage,
            message: "proxied request failed at " + curStage.toLowerCase().replace(/_/g, " "),
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
            fallbackReason: reasonOf(decision),
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
}

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

