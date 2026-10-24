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
import { b64uDecode, b64uEncode, buildNavHandleUrl, buildQueryHandleUrl, decodeClientUrl, decodeExpiredNavHandle, decodeLegacyRoute, decodeNavHandle, decodeNavHandlePath, decodeNavHandleRoot, decodePath, decodeQueryHandle, encodeDest, encodeDestLegacy, encodeNavHandle, isEngineAsset, isEnginePath, isOpaqueUrl, isWorkerDestination, legacyRouteShaped, looksKeyedToken, NAVH, NAVH_TTL_MS, NAVQ_PARAM, passChallengeRedirFixed, queryHandlePathShaped, queryHandleToken, recoverPath, referrerDest, setRouteKeys, setScheme, unwrapDest, currentPrefix, restoreLeadingSlashes } from "./codec";

import { decodeBody, mapRefreshHeader, stripHostile, utf8ContentType } from "./headers";
import { parseKdl } from "./kdl";
import { loadRouteHistory, saveRouteKey } from "./routekey";
import { classifyForeign, preflightHeaders } from "./foreign";
import { NAV, NAVP } from "./bootstrap/navguard";

import { planRange, ZL_RANGE_MAX } from "./range";
import { applyEngineCors } from "./cors";
import { classifyFailure, errorPage, type ErrorCategory } from "./errorpage";
import { rewriteModuleWorkerImports } from "./worker-imports";
import { decideTransport, isCdnCgiUrl, refineWithContent, reasonOf, sniffsAsHtml, transitRecord, relayRecord, wispRecord, DOC_DESTS, JS_TRANSFORM_DESTS, type TransitDecision } from "./transit";
import { loadPolicy, policyMatch, transportMatch, type CompiledPolicy } from "./policy";
import { relayAvailable, relayFetch, requestRelayReRegister } from "./relayfetch";
import { cssRewriteStream, isCss, isHtml, isJs, rawFrom, rewriteJsBody, rewriteStream, workerPrelude } from "./transform";
import { ruleFor, siteRules } from "./siteconfig";
import { applyOnRequest, applyOnResponse } from "./plugins";
import { applyRules, loadRules, siteUaFor, type GhosteryRedirect, type ResourceType } from "./rules";
import { ghosteryLoadInProgress } from "./ghostery";
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
import { siteToken } from "./pageload";

import { altConfigured, altEndpoint, altRegister, altWispFetch, wispTransport } from "./transport";
import { normalizeWispUrl, primaryWispOverrideValue, setPrimaryWispOverride } from "./config";
import { raceBoot } from "./lifecycle";



import {PROXY_INJECTED_HEADERS, acceptLanguageValue, applyChUa, navigationAccept, secFetchHeaders, virtualOriginHeaders, virtualRefererFallback} from "./origin";
import { capContexts, contextOf, establishContext, resolveRelative, VCTX_CAP } from "./vctx";
import { assetBaseCount, isRecoverableAssetDest, isRecoverableAssetPath, recordAssetBase, recoverFlatAsset, recordScriptUrl, recoverFlagSurgeryScript, type FlatFetch } from "./assetbases";
import { anySessionProfileActive, applySetCookie, cookieHeaderFor, flushJarPersist, inheritJarClient, isPassChallenge, jarClientHasRoot, jarHeaders, jarProfilesReady, jarProfileState, markJarClientUnbound, pruneJarClients, type CookieRequestContext } from "./cookies";
/* #87: the shared service-worker runtime state (per-client virtual
   contexts, route-shape toggles, route key, fingerprint profile +
   per-site profile cache) lives in ./swstate; the engine and the
   control plane are call sites. */
import { destUpgraded, getFpProfile, getFpWorkerScript, httpExemptAdd, httpExemptHas, isHttpsUpgrade, navHandlesEnabled, pushDocCookieView, queryRoutesEnabled, setHttpsUpgrade, setNavHandles, setRouteKey, siteDisabled, siteProfileFor, VCTX, ZEOLITE_VERSION } from "./swstate";

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
/* 2.3: a navigate-mode upstream fetch carries a first-byte deadline
   (#107: the http-entry 301 strand could hang as a committed blank
   frame - respondWith had answered, so the browser committed an
   empty document and waited forever on an upstream that never sent
   first bytes). The rejection lands in the same catch that turns
   transport failures into the error page, so a hung upstream
   surfaces honestly instead of a silent blank frame. Subresources
   keep no deadline: the page owns their failure handling. The
   transport fetch keeps running after a deadline rejection; its
   answer is dropped, never served. */
const NAV_TTFB_DEADLINE_MS = 30_000;

/* Wave-32 wedge class (ai117 churn probe): several awaits run BEFORE
   the navigation deadline arms (boot gate steps, client lookups, the
   page-cache match), so a HUNG browser API call there - a clients.get()
   that never settles mid-churn, a wedged Cache Storage open/match/delete -
   wedges the request with no bound at all: the reload never commits and
   a hung UI-asset request parks the tab empty. raceBoot (#249) bounds
   each; past the bound the caller proceeds on the same degraded path an
   exception already takes, and DIAG names the wedged step. */
const PRE_DEADLINE_BOUND_MS = 1_500;

/* #140: settle guarantee for page-initiated subresource bodies. A
   transport stream can stall mid-body (live: a lazy image request
   on search.brave.com/videos stayed pending past 30s and held the
   embedder loading indicator on through zl:loadState). Navigation keeps the TTFB deadline
   for its headers and this idle bound for its body (#200);
   event-stream and long-poll responses
   are long-lived by design, so only IDLE stalls are killed, never
   total duration: a stream that keeps sending bytes stays alive. */
const BODY_STALL_DEADLINE_MS = 20_000;

export function withBodyStallDeadline(resp: Response, ms: number, traceId: string, url: string): Response {
  if (!(ms > 0) || !resp.body) return resp;
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/event-stream")) return resp;
  const reader = resp.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("body stall: no bytes for " + ms + "ms")), ms);
          reader.read().then(resolve, reject);
        });
        clearTimeout(timer);
        if (chunk.done) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        clearTimeout(timer);
        DIAG.emit({
          traceId,
          requestId: traceId,
          category: "TRANSPORT",
          cause: "proxy",
          severity: "warning",
          stage: "UPSTREAM_RESPONSE",
          message: "body stall deadline: upstream stopped sending, stream errored for the page",
          url,
        });
        try {
          await reader.cancel();
        } catch {
          /* already gone */
        }
        controller.error(err);
      }
    },
    cancel() {
      return reader.cancel();
    },
  });
  const out = new Response(stream, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  /* #10: Response construction drops set-cookie (forbidden
     response-header name), and the cookie jar reads the transport
     rawHeaders pairs - carry them onto the wrapped response so
     upstream cookies still land in the jar. */
  const raw = (resp as Response & { rawHeaders?: Array<[string, string]> }).rawHeaders;
  if (Array.isArray(raw)) {
    (out as Response & { rawHeaders?: Array<[string, string]> }).rawHeaders = raw;
  }
  return out;
}

export function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  msg: string,
  abort?: AbortController,
): Promise<T> {
  if (!(ms > 0)) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      /* Abort the underlying fetch too: the deadline must not leave
         the upstream request running past the failure it reported. */
      abort?.abort(new Error(msg));
      reject(new Error(msg));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/* ---- Page cache (ported from the v3 worker) -------------------- */
/* Cache-first for proxied GETs with stale-while-revalidate. Freshness
   honors Cache-Control: max-age when present (no-store and no-cache
   skip the cache entirely); the fallback TTL is 10 minutes. 60-entry cap, FIFO
   eviction. x-zl-cached-at carries the stored-at time. */


const ZL_PAGES = "zeolite-pages-v2";
/* v1 may contain responses cached by the old worker without per-client
   credential context. Never reuse those entries after profile isolation. */
const ZL_PAGES_PRE_CLIENT_ISOLATION = "zeolite-pages-v1";
let legacyPageCacheCleanup: Promise<void> | null = null;

function discardLegacyPageCache(): Promise<void> {
  /* Best-effort cleanup: a context whose caches surface is missing
     or partial (the test harness stubs caches without delete) must
     never turn the fetch path into a synchronous failure. The call
     rides a then callback so any throw becomes a caught rejection. */
  legacyPageCacheCleanup ??= Promise.resolve()
    .then(() => caches?.delete?.(ZL_PAGES_PRE_CLIENT_ISOLATION))
    .then(() => undefined)
    .catch(() => undefined);
  return legacyPageCacheCleanup;
}
const ZL_CACHED_AT = "x-zl-cached-at";
/* #184: the final URL after redirect hops rides stored entries. */
const ZL_FINAL_URL = "x-zl-final-url";
/* #338: internal bookkeeping headers never reach the page. They stay
   on the stored entry (TTL checks and final-URL recovery read them)
   and are stripped from every served copy. */
function stripInternalHeaders(h: Headers): Headers {
  const out = new Headers(h);
  out.delete(ZL_CACHED_AT);
  out.delete(ZL_FINAL_URL);
  return out;
}
const ZL_DEFAULT_TTL = 10 * 60 * 1000;
const ZL_PAGE_LIMIT = 60;
/* #195: bodies above this size never enter the page cache (the
   clone() tee buffers them whole in memory). */
const ZL_PAGE_STORE_MAX = 4 * 1024 * 1024;
/* One in-flight stale refresh per cache key: concurrent stale hits
   coalesce into a single upstream fetch instead of one each. */
const staleRefreshInFlight = new Map<string, Promise<void>>();

export function cacheTtl(headers: Headers): number {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  /* #115: no-cache is stored but always stale (zero TTL, revalidated
     before every use); no-store is never stored at all. Both read as a
     zero TTL; storability is decided by cacheStorable below. */
  if (/\bno-store\b|\bno-cache\b/.test(cc)) return 0;
  const m = /(?:^|[,\s])max-age=(\d+)/.exec(cc);
  if (m) return Math.min(Number(m[1]) * 1000, 24 * 60 * 60 * 1000);
  return ZL_DEFAULT_TTL;
}

/** #115: only no-store is uncacheable. A no-cache response is stored
    (zero TTL) and revalidated before every use; an entry without
    validators revalidates as an unconditional probe. */
export function cacheStorable(headers: Headers): boolean {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  /* #179: private responses never enter the shared page cache (it
     spans jar profiles and sessions), and neither do responses that
     vary on Cookie. */
  if (/\bno-store\b/.test(cc)) return false;
  if (/\bprivate\b/.test(cc)) return false;
  /* #346: the lookup keys on the URL alone, so any response that varies
     on a request header (Cookie, User-Agent, Accept-Language, Origin, ...)
     would be served to requests that differ in that header. Until the
     entry stores its Vary list and compares it on lookup, a varying
     response is not stored. */
  if ((headers.get("vary") ?? "").trim() !== "") return false;
  return true;
}

/* #94 + #35: ONE copy of the JS-transform destination set - the
   refresh and no-cache revalidation skips must both match the
   serve-time transform branches: a raw upstream body must never
   overwrite the composed copy such an entry stores. */
function cacheRefreshSkipsEntry(req: Request, hit: Response): boolean {
  return (
    isWorkerDestination(req.destination) ||
    (JS_TRANSFORM_DESTS.has(req.destination) && isJs(hit))
  );
}

export async function pageCacheMatch(
  req: Request,
  keepAlive: (p: Promise<unknown>) => void = () => {},
): Promise<Response | null> {
  let hit: Response | undefined;
  try {
    hit = await (await caches.open(ZL_PAGES)).match(req);
  } catch {
    return null;
  }
  if (!hit) return null;
  const at = Number(hit.headers.get(ZL_CACHED_AT) ?? 0);
  const ttl = cacheTtl(hit.headers);
  /* #115: a stored no-store view can only be a legacy entry; it stays
     unserved. */
  const cc = (hit.headers.get("cache-control") ?? "").toLowerCase();
  if (/\bno-store\b/.test(cc)) return null;
  const rangeHeader = req.headers.get("range");
  /* #115: no-cache revalidates BEFORE use (RFC 9111): the conditional
     fetch blocks this response, and only a wire 304 hands the page the
     stored body. A failed revalidation never falls back to the stale
     copy - the request bypasses to the live path and surfaces the
     honest transport result. A Range request bypasses too: the origin
     owns range semantics, the pre-#115 behavior. */
  if (/\bno-cache\b/.test(cc)) {
    if (rangeHeader) return null;
    /* #35/#94 parity: a transformed-JS entry is dropped, never
       revalidated - the raw upstream 200 must not overwrite the
       composed copy the next hit would serve. */
    if (cacheRefreshSkipsEntry(req, hit)) {
      try { await (await caches.open(ZL_PAGES)).delete(req); } catch { /* no storage */ }
      return null;
    }
    return await revalidateBeforeUse(req, hit);
  }
  if (!ttl) return null;
  if (Date.now() - at >= ttl) {
    /* Stale: serve it now, refresh without blocking the response.
       The refresh used to be awaited inline, so a stale hit paid the
       full upstream latency before the page saw its first byte. The
       keepAlive callback hands the promise to the fetch event's
       waitUntil, so the worker outlives the refresh instead of the
       refresh dying with the worker the moment the response is
       served. Torture report (stale SWR): concurrent stale hits
       for one entry used to each pay their own upstream fetch; one
       in-flight refresh per cache key coalesces them into a single
       round trip. */
    let refresh = staleRefreshInFlight.get(req.url);
    if (!refresh) {
      refresh = (async () => {
        try {
          /* #35: a background refresh fetches the RAW upstream body. For
             serve-time-transformed JS (worker/script destinations) the
             composed copy is built on the fetch path, which this refresh
             bypasses - storing raw here would regress the entry. Drop the
             stale entry instead: this hit serves from memory, the next
             request re-fetches and re-transforms. */
          /* #94: ONE copy of the JS-transform destination set (the refresh
             skip must match the serve-time transform branches). */
          const jsServe = cacheRefreshSkipsEntry(req, hit);
          if (jsServe) {
            await (await caches.open(ZL_PAGES)).delete(req);
          } else {
            /* #115: the refresh carries the stored validators so the
               origin can answer 304; a 304 keeps the stored body and
               bumps the stored-at time instead of transferring a new
               copy. #184: a redirected entry refreshes against its
               stored final URL and the fetch chases the hops, so the
               entry can actually be updated. */
            const { resp: fresh, finalUrl: freshUrl } = await wispFetchCacheBypass(
              req,
              {
                etag: hit.headers.get("etag"),
                lastModified: hit.headers.get("last-modified"),
              },
              hit.headers.get(ZL_FINAL_URL) ?? undefined,
            );
            if (fresh.status === 304) {
              await bumpStoredEntry(req, fresh);
            } else if (fresh.ok) {
              await pageCacheStore(req, fresh, false, freshUrl);
            }
          }
        } catch {
          /* offline: the stale copy stays served */
        }
      })();
      staleRefreshInFlight.set(req.url, refresh);
      /* the IIFE never rejects: its whole body is one try/catch. */
      void refresh.then(() => staleRefreshInFlight.delete(req.url));
    }
    keepAlive(refresh);
  }
  /* Issues #13 + #18: a Range request is answered from the stored full
     entry only when exactly one byte range names a slice the engine can
     serve (plain body under the size cap). Everything else bypasses the
     cache so the origin owns range semantics; forwardedHeaders passes
     the header to the wisp path. */
  /* #204: a rewritable entry (HTML, CSS, JS) is never sliced: the
     stored copy is the raw upstream body for document and stylesheet
     hits (the serve-time rewrite owns those), so a 206 slice hands
     the page unrewritten bytes. The origin owns range semantics. */
  if (rangeHeader) {
    if (isHtml(hit) || isCss(hit) || isJs(hit)) return null;
    /* #341: If-Range gates the slice on the stored validator. A
       mismatch means the client's view may be newer than the entry,
       so the origin owns the range semantics. Strong-compare etags (a
       W/ tag mismatches) and exact Last-Modified strings; anything
       else fails closed to a bypass. */
    const ifRange = req.headers.get("if-range");
    if (ifRange) {
      const etag = hit.headers.get("etag");
      const lm = hit.headers.get("last-modified");
      const strong = ifRange.replace(/^W\//, "");
      const ok = (!!etag && strong === etag) || (!!lm && ifRange === lm);
      if (!ok) return null;
    }
    return await rangeFromEntry(hit, rangeHeader);
  }
  return hit;
}

/** Issue #18: slice a single-range request out of a stored full 200.
    206 + content-range on success, 416 when unsatisfiable, null to
    bypass (multi-range, compressed or oversized entries). */
export async function rangeFromEntry(hit: Response, rangeHeader: string): Promise<Response | null> {
  /* A compressed body cannot be sliced: the range would cut the
     encoded stream, not the resource. */
  if (hit.headers.get("content-encoding")) return null;
  /* #314: an entry that announces more than the range cap is refused
     BEFORE its body is buffered: a huge stored body must not be
     copied into memory only to be rejected. An uncompressed entry's
     content-length matches its stored body, so this can only refuse
     sooner, never differently; without the header, measure as before. */
  const announced = Number(hit.headers.get("content-length") ?? "");
  if (Number.isFinite(announced) && announced > ZL_RANGE_MAX) return null;
  const body = new Uint8Array(await hit.arrayBuffer());
  if (body.byteLength > ZL_RANGE_MAX) return null;
  const plan = planRange(rangeHeader, body.byteLength);
  if (plan.kind === "bypass") return null;
  /* #338: the slice view serves without internal headers. */
  const headers = stripInternalHeaders(hit.headers);
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

/** #179: the page cache is shared across jar profiles and sessions, so
    a request carrying credentials (an Authorization header or a jar
    cookie for the target) bypasses it in both directions. */
function requestHasCredentials(req: Request, dest: string, clientId?: string): boolean {
  if (clientId && jarProfileState(clientId) !== "default") return true;
  if (req.headers.has("authorization")) return true;
  return !!cookieHeaderFor(dest, { clientId });
}

/** A route search replaces the decoded destination's own query - the
    resolution a browser applies to a query-only relative navigation
    ("?x" keeps the path, swaps the query). JS-literal mints and legacy
    full-dest tokens encode their query inside the token, so gluing the
    outer search on produced "...?a=1?b=2" (Brave Ask live strand: the
    new question never reached the page). A query-free decode keeps
    plain concat - the ordinary #38 route shape. */
export function mergeRouteSearch(dest: string, search: string): string {
  if (!search) return dest;
  const qi = dest.indexOf("?");
  return (qi >= 0 ? dest.slice(0, qi) : dest) + search;
}

/** #184: a redirected entry rewrites against the final URL it was
    served from, not the pre-redirect key it is cached under. */
export function cacheRewriteBase(hit: Response, target: string): string {
  return hit.headers.get(ZL_FINAL_URL) ?? target;
}

/** Store a 200 in the page cache. With keepView the caller also serves
    the returned surgered view to the page (the cache consumes a clone,
    both forks stream concurrently); without it the view's body is
    consumed by the cache and the return value must not be served. */
export async function pageCacheStore(
  req: Request,
  resp: Response,
  keepView = false,
  finalUrl?: string,
  clientId?: string,
): Promise<Response | null> {
  /* #115: no-cache entries are stored too - cacheTtl gives them a zero
     TTL, so every use revalidates - and only no-store is never stored. */
  if (!cacheStorable(resp.headers) || resp.status !== 200) return null;
  /* #179: credential-bearing requests never feed the shared page
     cache (Authorization header or a jar cookie for the target). */
  {
    const su = new URL(req.url);
    let sroute = decodePath(su.pathname);
    /* #296 class: script-src split routes decode only via recoverPath
       (token prefix + visible path tail). */
    if (!sroute) sroute = recoverPath(su.pathname);
    if (requestHasCredentials(req, sroute ? mergeRouteSearch(sroute, su.search) : su.href, clientId)) return null;
  }
  /* #195: big bodies never enter the page cache - the clone() tee
     buffers them whole in memory while the cache write trails the page
     read. The length header is authoritative when present; a missing
     one is usually a chunked dynamic document, which stays cacheable.
     ponytail: unknown-length streams stay stored; a counting wrapper
     is the upgrade if a live site lands multi-MB chunked docs here. */
  const clen = Number(resp.headers.get("content-length") ?? NaN);
  if (clen > ZL_PAGE_STORE_MAX) return null;
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
    mapRefreshHeader(storedHeaders, croute ? mergeRouteSearch(croute, cu.search) : cu.href);
    const stored = new Response(resp.body, { status: 200, headers: storedHeaders });
    stored.headers.set(ZL_CACHED_AT, String(Date.now()));
    /* #184: the final URL after redirect hops rides the entry so a
       cache hit rewrites against the base the document was actually
       served from. */
    if (finalUrl) stored.headers.set(ZL_FINAL_URL, finalUrl);
    await cache.put(req, keepView ? stored.clone() : stored);
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
    return stored;
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
    return null;
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
  /* #338: the served 304 view carries no internal headers. */
  const out = stripInternalHeaders(h);
  out.set("x-zl-not-modified", "1");
  return new Response(null, { status: 200, headers: out });
}

/** Re-fetch a cached request straight through the wisp transport. The
    transport adapter ignores the fetch redirect option (3xx responses
    surface to the caller), so no redirect hint is passed. #115: when
    the stored entry carries validators, the fetch is conditional
    (If-None-Match / If-Modified-Since) so the origin can answer 304. */
/* #137: the transport choke point for every upstream fetch. A rule
   with route "relay" moves the fetch onto the embedder's network
   stack (native TLS): duckduckgo.com-class hosts block the wasm TLS
   ClientHello shapes at the handshake, so wisp cannot carry them.
   Everything else rides wisp exactly as before. ponytail: relayed
   bodies are strings/ArrayBuffers only; stream bodies fall back to
   wisp (relayFetch answers null) and the fetch stays honest. #145: the
   caller's AbortSignal rides both paths so a page abort cancels the
   upstream request instead of letting it finish unseen. */
/* #155: a POST body that reaches the transport as a ReadableStream
   can neither ride the embedder relay (#137: string/ArrayBuffer
   bodies only) nor survive the transport's single connect-class
   retry (#74: the retry re-reads an already-consumed stream and
   the fetch dies as "Failed to construct Request: ReadableStream is
   disturbed" - youtube.com innertube POSTs, chatgpt/deepseek/twitch
   API calls all 502 this exact way while GETs ride the relay fine).
   Buffer a stream body ONCE at this choke point: the relay can then
   carry it and the retry can replay it. A body that announces a
   Content-Length over the cap keeps the one-shot streaming behavior
   (huge uploads never buffer); an unannounced body that overflows
   the cap fails honestly instead of sending a truncated body. */
const REPLAY_BODY_CAP = 32 * 1024 * 1024;

/* #354: how long a channel-less relay-routed fetch waits for the
   embedder to re-register after the SW broadcast zl:relayLost. */
const RELAY_RE_REGISTER_MS = 3_000;

/* #155 + the 2026-10-14 report: how often the replay cap tripped
   (announced bodies too big to buffer, unannounced overflow mid-read).
   A counter, not silence: the streaming tradeoff is visible. */
let replayCapTripCount = 0;
export function replayCapTrips(): number {
  return replayCapTripCount;
}

/** #155 + the 2026-10-14 report: return an init whose stream body is
    replaced by a buffered ArrayBuffer, but only when a replay path can
    actually fire for this request: a relay rule with a registered
    channel (the relay carries string/ArrayBuffer only), or a
    Content-Length-announced body the single connect-class retry can
    replay, or a redirect hop chain that replays the body on every
    hop (hopReplay). An unannounced body with no relay (the chunked/duplex class)
    streams one-shot instead of buffering or dying past the cap - the
    retry is honestly unavailable for it. Non-stream bodies and
    oversized announced bodies pass through untouched; an overflow
    mid-read throws so the caller serves the honest error strand,
    never a corrupted body. */
export async function replayableInit(
  init: { method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal },
  opts: { relayPossible?: boolean; hopReplay?: boolean } = {},
): Promise<{ method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal }> {
  const body = init.body;
  if (body == null || typeof (body as ReadableStream).getReader !== "function") return init;
  const clRaw = init.headers?.get("content-length") ?? "";
  if (/^\d+$/.test(clRaw)) {
    if (Number(clRaw) > REPLAY_BODY_CAP) {
      /* Huge announced upload: buffer-free one-shot streaming, the
         retry cannot replay it anyway. Counted, not silent. */
      replayCapTripCount++;
      DIAG.emit({
        category: "TRANSPORT",
        severity: "info",
        message: "announced body over the replay cap: streaming one-shot, no transport retry for this request",
      });
      return init;
    }
  } else if (!opts.relayPossible && !opts.hopReplay) {
    return init;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > REPLAY_BODY_CAP) {
      replayCapTripCount++;
      DIAG.emit({
        category: "TRANSPORT",
        severity: "warning",
        message: "request body exceeds the replay buffer cap; serving the honest error strand",
      });
      try {
        await reader.cancel();
      } catch {
        /* the stream is already gone */
      }
      throw new Error("zeolite: request body exceeds the replay buffer cap");
    }
    parts.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    buf.set(part, off);
    off += part.byteLength;
  }
  return { ...init, body: buf.buffer };
}

async function upstreamFetch(
  dest: string,
  init: { method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal },
  policy: CompiledPolicy,
  rtype: ResourceType,
  traceId: string,
): Promise<Response> {
  /* #154: the transport-side match. Behavior rules (native, rewrite)
     must not capture the wire: a native host rule composes with the
     transport rules instead of falling onto the default wisp stack. */
  const rule = transportMatch(policy, dest, rtype);
  /* #155 + 2026-10-14 report: buffer a stream body only when a replay
     path can actually fire for this request (a relay rule with a
     registered channel, or an announced body the single retry can
     replay); otherwise it streams one-shot. */
  /* #354: an idle worker restart drops the registered relay port and
     controllerchange never fires, so relay-routed hosts degraded to
     the wasm transport (the SSL error 35 class). Before falling back,
     ask the embedder to re-register once and wait, bounded. */
  if (rule && rule.route === "relay" && !relayAvailable()) {
    await requestRelayReRegister(RELAY_RE_REGISTER_MS, traceId, dest);
  }
  const relayPossible = !!rule && rule.route === "relay" && relayAvailable();
  /* #168: a wisp rule rides the secondary wasm client when the
     embedder announced a public endpoint; its bodies are
     strings/ArrayBuffers too, so the same replay buffering gate
     applies. */
  const wispPossible = !!rule && rule.route === "wisp" && altConfigured();
  init = await replayableInit(init, { relayPossible: relayPossible || wispPossible });
  if (rule && rule.route === "relay") {
    const rr = await relayFetch(dest, init, traceId);
    if (rr) {
      traceDecision({ subsystem: "policy", rule: rule.id, original: dest, result: "relay", resource: rtype, traceId });
      relayRecord();
      return rr;
    }
    DIAG.emit({
      traceId,
      requestId: traceId,
      category: "TRANSPORT",
      cause: "proxy",
      severity: "warning",
      stage: "UPSTREAM_REQUEST",
      message: 'policy route "relay" without an embedder channel: fetch falls back to the wisp transport',
      url: dest,
    });
  }
  /* #168: hosts the operator routed "wisp" ride the secondary wasm
     client through the announced public endpoint (the brave-search
     class: the relay transport is refused, the wasm ClientHello is
     accepted). No endpoint announced, or a failed wisp-route fetch:
     fall through to the default path, never a silent gap. */
  if (rule && rule.route === "wisp") {
    if (!wispPossible) {
      DIAG.emit({
        traceId,
        requestId: traceId,
        category: "TRANSPORT",
        cause: "proxy",
        severity: "warning",
        stage: "UPSTREAM_REQUEST",
        message: 'policy route "wisp" without an announced public endpoint: fetch falls back to the default transport',
        url: dest,
      });
    } else {
      try {
        const wr = await altWispFetch(dest, init);
        traceDecision({ subsystem: "policy", rule: rule.id, original: dest, result: "wisp", resource: rtype, traceId });
        wispRecord();
        return wr;
      } catch (err) {
        DIAG.emit({
          traceId,
          requestId: traceId,
          category: "TRANSPORT",
          cause: "proxy",
          severity: "warning",
          stage: "UPSTREAM_REQUEST",
          message: 'policy route "wisp" fetch failed: falling back to the default transport',
          technicalReason: String(err),
          url: dest,
        });
      }
    }
  }
  /* #226: thread the trace id so cooldown relay failures are
     attributed in the diagnostics ring. */
  return wispTransport.fetch(dest, init, traceId);
}

/** #290 residual (2026-10-20 sorry-page report): recovery candidates
    are upstream fetches and must ride the same relay/wisp transport
    decision as the page's own subresources. A lambda over the raw
    wisp client here died on relay-only embedders (their password-
    authed /wisp/ endpoint) and took the whole flag-surgery and
    flat-asset retry path down with it. */
export function recoveryUpstream(
  policy: CompiledPolicy,
  rtype: ResourceType,
  traceId: string,
): FlatFetch {
  return (u, init) => upstreamFetch(u, init, policy, rtype, traceId);
}

/** #381: Ghostery's list fetches ride the same relay/wisp transport
    decision as page subresources instead of a raw wisp lambda: on
    relay-only embedders (password-authed /wisp/) the raw lambda is
    auth-refused, remote lists silently never loaded and only the
    built-in local rules stayed active. Hop following and the SSRF
    judgment stay with upstreamFetch and the embedder edge. */
export function ghosteryListFetch(dest: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  return loadPolicy().then((policy) =>
    upstreamFetch(dest, { method, headers }, policy, "fetch", DIAG.trace()),
  );
}

/** #179: the page cache spans jar profiles and sessions; clearing the
    jar or switching profile drops it so one account's cached pages
    never surface for another. */
export async function pageCacheClear(): Promise<void> {
  try {
    await discardLegacyPageCache();
    const cache = await caches.open(ZL_PAGES);
    for (const k of await cache.keys()) await cache.delete(k);
  } catch {
    /* no storage: nothing to clear */
  }
}

async function wispFetchCacheBypass(
  req: Request,
  validators?: { etag?: string | null; lastModified?: string | null },
  destOverride?: string,
): Promise<{ resp: Response; finalUrl: string }> {
  /* Issue #38: engine routes keep the query outside the encoded
     destination; a foreign (#34) cached entry is keyed by the full
     target URL, and its pathname is not a decodable route. Compose
     the destination per shape - the old form glued a null decode of
     a foreign path onto its query. #184: a redirected entry carries
     its final URL and refreshes there; the fetch follows hops so the
     refresh can actually update the entry. */
  const u = new URL(req.url);
  let route = decodePath(u.pathname);
  /* #296 class: script-src split routes decode only via recoverPath. */
  if (!route) route = recoverPath(u.pathname);
  let dest = destOverride ?? (route ? mergeRouteSearch(route, u.search) : u.href);
  let finalUrl = dest;
  /* ponytail: five hops, the same practical ceiling as the live hop
     chain; the honest 3xx surfaces beyond it. */
  for (let hop = 0; ; hop++) {
    const headers = new Headers();
    /* 1.4 Boride: cache refreshes carry the jar's Cookie header too. */
    const jarCookie = cookieHeaderFor(dest);
    if (jarCookie) headers.set("cookie", jarCookie);
    /* #115: send the stored validators so the origin can answer 304
       (they belong to the original destination only). */
    if (hop === 0) {
      if (validators?.etag) headers.set("if-none-match", validators.etag);
      if (validators?.lastModified) headers.set("if-modified-since", validators.lastModified);
    }
    const resp = await wispTransport.fetch(dest, { method: "GET", headers });
    const loc = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && loc && hop < 5) {
      /* #201 hygiene: the redirect body is never read - cancel it. */
      if (resp.body) void resp.body.cancel().catch(() => {});
      /* #376: each refresh hop passes the upgrade and block gates the
         live hop chain applies (destUpgraded, siteDisabled, rules). A
         blocked hop throws: the stale copy stays served and nothing
         unchecked is stored. */
      const next = destUpgraded(new URL(loc, dest).href);
      const hopRule = applyRules(await loadRules(), next, classifyRtype(next, "").toLowerCase() as ResourceType);
      if (siteDisabled(next) || hopRule.action === "block") {
        throw new Error("cache refresh stopped by a block rule on a redirect hop");
      }
      finalUrl = next;
      dest = finalUrl;
      continue;
    }
    return { resp, finalUrl };
  }
}

/** #115: a wire 304 answering a conditional fetch keeps the stored
    body. Re-match the entry (a fresh stream of the same stored body),
    carry over any updated validators from the 304, bump the
    stored-at time, and put the same body back. No bytes are
    re-transferred and nothing is buffered: the body streams from the
    stored entry into the cache. */
async function bumpStoredEntry(req: Request, notModified: Response): Promise<void> {
  try {
    const cache = await caches.open(ZL_PAGES);
    const cur = await cache.match(req);
    if (!cur) return;
    const h = new Headers(cur.headers);
    const etag = notModified.headers.get("etag");
    const lm = notModified.headers.get("last-modified");
    if (etag) h.set("etag", etag);
    if (lm) h.set("last-modified", lm);
    h.set(ZL_CACHED_AT, String(Date.now()));
    await cache.put(req, new Response(cur.body, { status: 200, headers: h }));
  } catch {
    /* offline or storage failure: the copy already served is unaffected */
  }
}

/** #115: the no-cache revalidate-before-use path. The conditional
    fetch is awaited: a 304 serves the stored view, a 200 stores and
    serves the surgered fresh view (the jar is not fed on this branch,
    same as the SWR refresh - capture happens on the live path), and
    anything else (transport failure included) returns null so the
    request bypasses to the live path and gets an honest result.
    ponytail: no coalescing here - concurrent no-cache hits each pay
    their own conditional fetch; a shared in-flight probe keyed by URL
    is the upgrade path if a hot no-cache resource measurably hurts. */
async function revalidateBeforeUse(req: Request, hit: Response): Promise<Response | null> {
  try {
    /* #184: a redirected entry revalidates against its stored final
       URL, and the probe follows hops like the SWR refresh. */
    const { resp: probe, finalUrl: probeUrl } = await wispFetchCacheBypass(
      req,
      {
        etag: hit.headers.get("etag"),
        lastModified: hit.headers.get("last-modified"),
      },
      hit.headers.get(ZL_FINAL_URL) ?? undefined,
    );
    if (probe.status === 304) {
      await bumpStoredEntry(req, probe);
      return hit;
    }
    if (probe.ok) return (await pageCacheStore(req, probe, true, probeUrl)) ?? null;
    return null;
  } catch {
    return null;
  }
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
  /* #103: iframe/frame/fencedframe/embed/object/xslt are document
     destinations too (a subframe entry navigation carries
     sec-fetch-dest "iframe"); DOC_DESTS is the one classification
     table, shared with the transit refinement. */
  if (DOC_DESTS.has(d)) return "DOCUMENT";
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
export function csInjectUrls(target: string, req: Request, parentUrl?: string): string[] {
  const exts = extensions.list();
  if (exts.length === 0) return [];
  const dest = reqDest(req);
  let subframe = dest === "iframe" || dest === "object";
  /* An engine document embedded by the host app is the browsing
     pane main surface, not a genuine in-page subframe: declared
     scripts without all_frames must run there. The frame keeps
     subframe semantics unless its parent is a parseable non-about
     URL on neither a NAVH route nor an engine route (a host page);
     absent or unparseable parents fail closed. */
  if (subframe && parentUrl) {
    try {
      const pu = new URL(parentUrl);
      const hostParent =
        pu.protocol !== "about:" &&
        !pu.pathname.startsWith(NAVH + "/") &&
        !isEnginePath(pu.pathname) &&
        /* Injector phase 2: a query-shape parent is a proxied page. */
        queryHandleToken(pu.search) === null;
      if (hostParent) subframe = false;
    } catch {
      /* ponytail: unparseable parent keeps subframe semantics */
    }
  }
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
const routeKeyUrl = () => new URL("route-config.kdl", self.registration.scope).href;
/* The pre-KDL deployment persisted the shape as JSON; the restore
   still reads that entry, the persist writes KDL only. */
const routeKeyUrlLegacy = () => new URL("route-config.json", self.registration.scope).href;
const routeRestore: Promise<void> = (async () => {
  try {
    const cache = await caches.open(ZL_ROUTE_CACHE);
    const hit = await cache.match(routeKeyUrl());
    if (hit) {
      /* KDL shape: route-config prefix "/j/" https-upgrade #true nav-handles #false */
      const [node] = parseKdl(await hit.text());
      if (node && node.name === "route-config") {
        setScheme(typeof node.props.prefix === "string" ? node.props.prefix : "/j/");
        if (typeof node.props["https-upgrade"] === "boolean") setHttpsUpgrade(node.props["https-upgrade"]);
        if (typeof node.props["nav-handles"] === "boolean") setNavHandles(node.props["nav-handles"]);
        /* 2026-10-15: the announced public wisp endpoint persists with
           the route shape so an idle-killed worker instance restores
           it on restart - the embedder re-announces only on
           controllerchange, which never fires for an instance
           restart; without this the wisp route vanished after the
           first ~30s idle kill. */
        if (typeof node.props["wisp-endpoint"] === "string") altRegister(node.props["wisp-endpoint"]);
        /* LobsterBrowse primary endpoint choice (zl:wispPrimary). State
           only: the libcurl client is not up yet at restore time. */
        if (typeof node.props["wisp-primary"] === "string") {
          const p = normalizeWispUrl(node.props["wisp-primary"]);
          if (p) setPrimaryWispOverride(p);
        }
      }
    } else {
      const legacy = await cache.match(routeKeyUrlLegacy());
      if (legacy) {
        const cfg = (await legacy.json()) as { prefix?: string; httpsUpgrade?: boolean; navHandles?: boolean };
        setScheme(cfg.prefix ?? "/j/");
        if (typeof cfg.httpsUpgrade === "boolean") setHttpsUpgrade(cfg.httpsUpgrade);
        if (typeof cfg.navHandles === "boolean") setNavHandles(cfg.navHandles);
      }
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
    if (history === null) {
      /* #399: the read failed (not empty) - one retry after a beat; a
         transient IDB failure at boot must not be mistaken for first
         boot, and minting over it would replace the decode set with
         the fresh key alone. */
      await new Promise((r) => setTimeout(r, 150));
      history = await loadRouteHistory();
    }
    if (history === null) {
      /* still failing: keyed codec stays off for this worker lifetime
         (the documented degraded mode); nothing is overwritten and
         the next restart recovers fully. */
      return;
    }
    if (history.length === 0) {
      const fresh = crypto.getRandomValues(new Uint8Array(16));
      await saveRouteKey(fresh);
      /* #395-class honesty note: saveRouteKey preserves the stored
         history, so the re-read restores the FULL decode set instead
         of the fresh key alone; a failing re-read falls back to the
         fresh key. */
      history = (await loadRouteHistory()) ?? [fresh];
    }
    setRouteKey(b64uEncode(history[0]!));
    setRouteKeys(history.map(b64uEncode));
  } catch {
    /* storage unavailable: keyed codec stays off */
  }
})();
/* #249: bounded - a hung Cache Storage open must not wedge every
   fetch that awaits the route shape. */
export const routeReady: Promise<void> = raceBoot(routeRestore, "route shape restore").then(() => undefined);

export async function persistRoute(prefix: string): Promise<void> {
  try {
    await (await caches.open(ZL_ROUTE_CACHE)).put(
      routeKeyUrl(),
      new Response(
        "route-config prefix " +
          JSON.stringify(prefix) +
          " https-upgrade " +
          (isHttpsUpgrade() ? "#true" : "#false") +
          " nav-handles " +
          (navHandlesEnabled() ? "#true" : "#false") +
          (altEndpoint() ? " wisp-endpoint " + JSON.stringify(altEndpoint()) : "") +
          (primaryWispOverrideValue() ? " wisp-primary " + JSON.stringify(primaryWispOverrideValue()) : ""),
      ),
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
/** #101/#157: resolve a <parent route>/__zl_prel__/<encoded input>
    path to its destination. The parent may be a scheme route or a
    NAVH handle (decodeClientUrl) or a NAV navigation route (legacy
    b64 marker payload). Null = bad route, never a guess. */
export function navpResolve(pathname: string, engineOrigin?: string): string | null {
  /* #157/#159: emitters that predate the own-origin re-anchor (or
     unpatched realms) can still pass an absolute engine-origin URL
     as the tail; resolved as absolute it would fetch the engine
     origin root. The strip happens at the shared decode so every
     emitter is covered; tests inject the origin, the SW passes
     none. */
  const eo = engineOrigin ?? (typeof self !== "undefined" && self.location ? self.location.origin : "");
  const cut = pathname.indexOf(NAVP);
  if (cut < 0) return null;
  const parent = pathname.slice(0, cut);
  let base: string | null = null;
  if (parent.startsWith(NAV + "/")) {
    const b = b64uDecode(parent.slice(NAV.length + 1).split(/[?#]/)[0]);
    try {
      const d = b ? new TextDecoder().decode(b) : null;
      base = d && /^https?:\/\//.test(d) ? d : null;
    } catch {
      base = null;
    }
  } else {
    try {
      /* the base origin never matters: decodeClientUrl reads only
         the pathname and the search */
      base = decodeClientUrl(new URL(parent, "https://engine.invalid"));
    } catch {
      base = null;
    }
    /* #393: a NAVH parent past its TTL decodes to nothing here, so a
       prel tail under it 404'd before the clean-form re-mint (#385)
       could run. The MAC-verified expired decode recovers the parent
       destination - the navigation then lands on a FRESH handle via
       navhCleanFromPrel, and prel fetches keep resolving too. A
       tampered or wrong-key token still decodes to nothing: no
       widened reach. */
    if (!base && parent.startsWith(NAVH + "/")) {
      base =
        decodeExpiredNavHandle(parent.slice(NAVH.length + 1).split("/")[0])
          ?.destination ?? null;
    }
  }
  if (!base) return null;
  let rel: string | null = null;
  try {
    const after = pathname.slice(cut + NAVP.length);
    /* the emitted shape is <NAVP>/<encoded input>: drop the
       separator slash so a root-relative input stays
       root-relative instead of turning protocol-relative, and a
       relative input keeps directory semantics */
    rel = decodeURIComponent((after.startsWith("/") ? after.slice(1) : after).split(/[?#]/)[0]);
  } catch {
    return null;
  }
  try {
    const dest = new URL(rel, base);
    /* #157/#159: an engine-origin absolute tail re-resolves as its
       path against the parent destination: the page meant the
       site's path, not the engine origin root. */
    if (eo && dest.origin === eo && (dest.protocol === "https:" || dest.protocol === "http:")) {
      const re = new URL(dest.pathname + dest.search, base);
      return re.protocol === "https:" || re.protocol === "http:" ? re.href : null;
    }
    return dest.protocol === "https:" || dest.protocol === "http:" ? dest.href : null;
  } catch {
    return null;
  }
}
/** #290-class URL fidelity (the Google sei reload): a navigation
    that arrives on a NAVP tail decodes correctly, but the document
    would then park on an opaque pathname with its real path and
    query folded inside the prel segment, so every page-side URL
    re-read (location.search, new URL(location.href)) misparses and
    self-refresh flows re-trigger. Rebuild the same destination on
    the visible handle form the initial navigation minted (#144):
    token + real path + real query. Null = the destination does
    not parse, or no handle can be minted and no parent token
    exists to fall back on (the prel decode then serves it). */
export function navhCleanFromPrel(pathname: string, dest: string): string | null {
  const cut = pathname.indexOf(NAVP);
  if (cut < 0) return null;
  const parent = pathname.slice(0, cut);
  /* #383: a NAVH parent keeps its token lineage (host-root
     binding); a non-NAVH parent has no token, but the prel decode
     already resolved the full destination, so the fresh mint
     below still yields the readable handle form. */
  const token = parent.startsWith(NAVH + "/")
    ? parent.slice(NAVH.length + 1).split("/")[0] || null
    : null;
  let u: URL;
  try {
    u = new URL(dest);
  } catch {
    return null;
  }
  /* Injector phase 2: with queryRoutes on, the clean form rides the
     query shape (<real path>?<real query>&zlNavh=<token>) so the
     reloaded document owns a natively readable pathname - the same
     mint the zl:navHandle verb uses. A mint-refused collision
     (engine-internal path) or missing route key falls through to the
     NAVH path form below; the #383 fail-closed contract is intact. */
  if (queryRoutesEnabled()) {
    const q = buildQueryHandleUrl(
      dest,
      NAVH_TTL_MS,
      token ? decodeNavHandleRoot(token) ?? undefined : undefined,
    );
    if (q !== null) return q;
  }

  /* #385: mint a FRESH handle for the clean form: the parent token
     can be past its TTL at reload time, and a reused token inherits
     the expiry, so the redirected navigation would 404 one hop
     later. The fresh token carries the same destination and the
     parent's host-root binding; a failed mint (no route key) keeps
     the parent token - a short-lived clean URL still beats parking
     on the opaque prel form. */
  const fresh = encodeNavHandle(
    dest,
    NAVH_TTL_MS,
    token ? decodeNavHandleRoot(token) ?? undefined : undefined,
  );
  const use = fresh ?? token;
  /* #383: no parent token and no mintable key: keep the prel
     decode (null) rather than guessing a clean form. */
  if (!use) return null;
    /* #202: surplus leading slashes are percent-escaped in the visible
     path exactly like buildNavHandleUrl, so the clean form decodes
     back through the same seam. */
  const path =
    u.pathname === "/"
      ? ""
      : u.pathname.replace(/^\/(\/+)/, (_s: string, run: string) => "/" + "%2F".repeat(run.length));
  return NAVH + "/" + use + path + u.search;
}
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

function ghosteryRedirectResponse(
  redirect: GhosteryRedirect,
  credentials: string,
  method: string,
): Response {
  const rawType = redirect.contentType;
  const validType =
    rawType.length <= 256 &&
    /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=(?:[\w!#$&^_.+-]+|"[^"\r\n]*"))*$/.test(rawType);
  const headers = new Headers({
    "content-type": validType ? rawType : "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  applyEngineCors(headers, self.location.origin, credentials);
  return new Response(method === "HEAD" ? null : redirect.body, { status: 200, headers });
}

/* #82: the engine's fetch entry point. The entrypoint (sw.ts)
   registers this directly on the fetch event. respondWith is armed
   here, not in the entrypoint, because the lifecycle needs
   clientId / resultingClientId alongside the request, and the
   synchronous passthrough checks (opaque schemes, the wisp
   endpoint, extension routes) run before respondWith is armed -
   the old listener's exact shape, one module away. */
let jarPruneTicks = 0;
let jarPruneInFlight = false;

/* Exported for the #366 prune-options regression test only. */
export function scheduleJarClientPrune(): void {
  if (++jarPruneTicks % 128 !== 0 || jarPruneInFlight) return;
  jarPruneInFlight = true;
  void self.clients
    /* #366: the matchAll default type is "window", which would leave
       worker and shared-worker clients out of the live set and prune
       their jar-root bindings every 128 fetches; "all" counts them. */
    .matchAll({ includeUncontrolled: true, type: "all" })
    .then((clients) => pruneJarClients(new Set(clients.map((client) => client.id))))
    .catch(() => undefined)
    .finally(() => { jarPruneInFlight = false; });
}

export function handleFetch(e: FetchEvent): void {
  const url = new URL(e.request.url);
  let cookieClientId = inheritJarClient(
    e.clientId || undefined,
    e.resultingClientId || undefined,
    url.href,
  );
  async function recoverJarClientRoot(): Promise<void> {
    if (!e.clientId || jarClientHasRoot(e.clientId)) return;
    try {
      const sourceClient = await self.clients.get(e.clientId);
      if (sourceClient) {
        cookieClientId = inheritJarClient(
          e.clientId,
          e.resultingClientId || undefined,
          sourceClient.url,
        );
        try {
          const sourceUrl = new URL(sourceClient.url);
          if (
            !jarClientHasRoot(e.clientId) &&
            (isEnginePath(sourceUrl.pathname) ||
              sourceUrl.pathname.startsWith(NAVH + "/") ||
