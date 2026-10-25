Warning: truncated output (original token count: 53227)
Total output lines: 4353

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

import { altConfigured, altEndpoint, altRegister, altWispFetch, canReplayAfterFailure, wispTransport } from "./transport";
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
      const strongTag = !ifRange.startsWith("W/") && !etag?.startsWith("W/");
      const ok = (strongTag && !!etag && ifRange === etag) || (!!lm && ifRange === lm);
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
    headers.delete("content-length");
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

/** A route search JOINS the decoded destination's own query - union,
    outer params overriding inner ones per key. Page JS appending a
    runtime param onto an opaque token picks "?" as the separator
    precisely because the token hides its own query (MSAL live strand:
    "authorize?client_id=..." + "?iframe-request-id=" lost client_id
    upstream, AAD answered AADSTS900144), so replace semantics dropped
    params the upstream needs. A pure append keeps the token query
    bytes exact; only a key conflict resolves through a canonical
    rebuild. A query-free decode keeps plain concat - the ordinary
    #38 route shape, and the old "...?a=1?b=2" double-? mangling
    (Brave Ask live strand: the new question never reached the page)
    stays dead either way. */
export function mergeRouteSearch(dest: string, search: string): string {
  if (!search) return dest;
  if (!search.startsWith("?")) search = "?" + search;
  const qi = dest.indexOf("?");
  if (qi < 0) return dest + search;
  const inner = dest.slice(qi + 1);
  if (!inner) return dest.slice(0, qi) + search;
  const innerP = new URLSearchParams(inner);
  const outer = new URLSearchParams(search);
  let conflict = false;
  for (const k of outer.keys()) {
    if (innerP.has(k)) {
      conflict = true;
      break;
    }
  }
  if (!conflict) return dest + "&" + search.slice(1);
  for (const [k, v] of outer) innerP.set(k, v);
  return dest.slice(0, qi) + "?" + innerP.toString();
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
  if (init.signal?.aborted) {
    throw init.signal.reason ?? new DOMException("request aborted", "AbortError");
  }
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
        /* #444: a failed alternate transport may already have delivered
           the write. An outer fallback must honor the same replay gate
           as the transport's own retry, including one-shot bodies and
           cancellation. Only a proven pre-send failure permits a
           replayable non-idempotent method to try another endpoint. */
        if (
          init.signal?.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          !canReplayAfterFailure(init, err)
        ) {
          DIAG.emit({
            traceId, requestId: traceId, category: "TRANSPORT", cause: "proxy",
            severity: "warning", stage: "UPSTREAM_REQUEST", url: dest,
            message: 'policy route "wisp" failed: fallback refused because delivery is unknown, the body is one-shot, or the caller cancelled',
            technicalReason: String(err),
          });
          throw err;
        }
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
    exists t…23227 tokens truncated… status " + resp.status });
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
          /* #288: webRequest response/completion events carry the URL
             of the hop that produced this response; an extension's
             host permissions are then evaluated against the REAL
             response URL, so a redirect from A to B can no longer hand
             B's headers/status to an extension only permitted for A. */
          const wrDetailsFinal = { ...wrDetails, url: finalDest ?? hopUrl };
          if (finalDest) {
            DIAG.stage(traceId, "REDIRECTED", { url: target, message: "final destination " + finalDest });
            /* #110: the hop chain is also the authority on where the
               served document actually lives. The context established
               before the upstream fetch carries the pre-redirect target,
               so a navigation that landed on a different origin
               (google.com -> www.google.com is the live case) left every
               relative URL the page builds resolving against the
               pre-redirect origin, and origin-specific upstream endpoints
               (google.com/async/hpba 404s where www.google.com serves the
               AI Mode panel batch) silently die. Replace the client's
               context with the final destination - the same atomic
               establish-or-update the pre-fetch establishment is, at the
               seam where the truth is first known. Subresource redirects
               keep the document's entry (rule: subresource routes never
               touch it). */
            if (
              e.request.mode === "navigate" ||
              isWorkerDestination(e.request.destination)
            ) {
              const navClient = e.resultingClientId || e.clientId;
              if (navClient && establishContext(VCTX, navClient, finalDest))
                capContexts(VCTX, VCTX_CAP);
            }
          }
          /* 1.4 Boride: capture Set-Cookie into the per-origin jar before
             hostile-header surgery strips it from the page view. A 3xx
             that surfaced (hop cap, unresolvable or unreplayable hop)
             still lands here, captured against its own hop URL. */
          const admitted = credsEligible(finalDest ?? hopUrl) ? applySetCookie(finalDest ?? hopUrl, jarHeaders(resp), cookieClientId) : [];
          /* #35 (browser E2E): the page's document.cookie getter is
             synchronous, so the bootstrap keeps an optimistic copy; a
             Set-Cookie admitted on this fetch/XHR response was invisible
             to the page until its NEXT read. Push the fresh jar view to
             the requesting client's docCookie port right after
             admission, so the copy corrects itself. Unknown client
             (SW-initiated fetch, navigation) is a no-op inside. */
          if (admitted.some((r) => r.stored || r.deleted)) {
            void pushDocCookieView(e.clientId);
            /* #254: keep the jar write alive past this fetch event. */
            e.waitUntil(flushJarPersist());
          }
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
          const rHeaders = WEBREQ.headersReceived(wrDetailsFinal, resp.status, headers);
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
          /* #256 contract: onResponse hooks are best-effort observers,
             fired without awaiting (edits ignored, throws isolated). */
          void applyOnResponse(plugins, target, resp.status, outHeaders);
          let dec = refineWithContent(decision, resp.headers.get("content-type") ?? "", dest);
          /* #138: a policy rule with route "native" demotes the JS
             literal pass for a host proven to work with raw
             bodies: runtime navigation already flows through the
             patched fetch/XHR/WS seams, so literal hits there are
             dead code. Workers keep their passes (prelude and
             specifiers are behavioral, not cosmetic); documents
             and stylesheets are not demotable at all. */
          if (
            dec.mode === "RewriteFallback" &&
            dec.reason === "JS_LITERAL_REWRITE_REQUIRED" &&
            policyRule &&
            policyRule.route === "native" &&
            (dest === "script" || dest === "")
          ) {
            dec = { mode: "NativeTransit", reason: "POLICY_NATIVE", ruleId: policyRule.id };
            traceDecision({ subsystem: "policy", rule: policyRule.id, original: target, result: "native", resource: rtype, traceId });
          }
          /* Cloudflare's /cdn-cgi/ edge namespace (challenge-platform
             scripts, flow API answers, Turnstile wiring): the upstream
             verifies those bytes. A URL-literal pass over the
             orchestration script or the document bootstrap injected
             into an HTML-typed flow answer corrupts the challenge
             protocol, and the widget dies on its own "unable to
             connect" for every visitor. ScramJet never transforms
             subresource bodies and Cloudflare sites work through it;
             cdn-cgi responses serve verbatim, live and from the
             cache. */
          const cdnCgiNative = isCdnCgiUrl(target);
          if (cdnCgiNative && dec.mode === "RewriteFallback") {
            dec = { mode: "NativeTransit", reason: "CDN_CGI_NATIVE" };
          }
          /* #95: same explainable-decision event on the response path
             (every document, stylesheet and transformed script body
             lands here, so the reason is in the diag stream, not just
             the opt-in tracing ring). */
          if (dec.mode === "RewriteFallback")
            DIAG.stage(traceId, "TRANSPORT_FALLBACK", { url: target, message: dec.reason + (dec.ruleId ? " (policy " + dec.ruleId + ")" : "") });
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
            rewritten: DOC_DESTS.has(dest) && isHtml(resp) ? "html" : isCss(resp) ? "css" : isJs(resp) && (dest === "script" || dest === "") ? "js" : undefined,
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
          if (rIc.body && !(DOC_DESTS.has(dest) && isHtml(resp)) && !isCss(resp)) {
            const clen = Number(resp.headers.get("content-length") ?? -1);
            if (clen >= 0 && clen <= BODY_LIMIT) {
              WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
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
          const policyNativeJs = dec.mode === "NativeTransit" && dec.reason === "POLICY_NATIVE";
          const scriptServe =
            JS_TRANSFORM_DESTS.has(e.request.destination) && isJs(resp) && !!resp.body && !policyNativeJs && !cdnCgiNative;
          if (
            e.request.method === "GET" &&
            !workerServe &&
            !scriptServe &&
            !(DOC_DESTS.has(dest) && respCt === "")
          ) {
            void pageCacheStore(e.request, resp.clone(), false, finalDest, cookieClientId);
          }
          /* #158/#159: script and worker destinations must never
             receive an HTML or CSS body: module scripts hard-fail the
             whole graph on the MIME mismatch, classic scripts execute
             the body as JS (live: claude's bundle SyntaxError), and SPA
             catch-alls answer missing module paths with a 200 HTML
             document. When the upstream body is explicitly HTML or CSS
             the script destination gets an honest JS-typed comment
             carrying the upstream status and type instead, so module
             loading reports a clean failure and the rest of the graph
             proceeds. JS bodies, typeless responses and every other
             destination stay untouched. */
          const sct = resp.headers.get("content-type") ?? "";
          if (needsScriptBodyMask(dest, e.request.destination, sct)) {
            recordMaskedScript(target, e.request.referrer, target);
            WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
            return maskedScriptResponse(resp.status, sct);
          }
          /* #414: HTML MIME alone does not make a document. PHP APIs
             and HTML-fragment fetches are application data: document
             rewriting would inject bootstrap scripts into their return
             values. The cached path uses this same destination gate. */
          if (DOC_DESTS.has(dest) && (isHtml(resp) || respCt === "") && resp.body && !cdnCgiNative) {
            curStage = "REWRITE_STARTED";
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "html rewrite stream wired" });
            traceDecision({ subsystem: "rewriter", rule: "html", original: target, result: "streaming", resource: rtype, traceId });
            /* Main-frame document loads feed the webNavigation bridge;
               subresource fetches do not arrive in navigate mode. */
            if (e.request.mode === "navigate") WEBNAV.committed(target);
            const csInject = csInjectUrls(target, e.request, e.request.referrer);
            const rewriteDone = () => {
              /* webNavigation.onCompleted + webRequest.onCompleted:
                 the document stream (and with it the navigation) is
                 done. */
              WEBNAV.completed(target);
              WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
            };
            if (respCt !== "") {
              /* Issue B: the rewritten body is re-encoded UTF-8; the
                 served content-type must say so, or a legacy upstream
                 charset corrupts the page. */
              outHeaders.set("content-type", utf8ContentType(respCt));
              return new Response(
                rewriteStream(resp.body, finalDest ?? target, rule, csInject, respCt, rewriteDone),
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
                rewriteStream(sniffReader, finalDest ?? target, rule, csInject, "text/html", rewriteDone),
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
          if (isCss(resp) && resp.body && !cdnCgiNative) {
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
              cssRewriteStream(resp.body, finalDest ?? target, respCt, () => {
                DIAG.stage(traceId, "REWRITE_COMPLETED", { url: target, category: "REWRITE" });
                WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
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
              "self.__ZL_SITE__=" + JSON.stringify(siteToken(target)) + ";\n" +
              (await workerPrelude()) +
              "\nself.__zlPreludeInit&&self.__zlPreludeInit(" + JSON.stringify(encodeDestLegacy(target)) + ");\n" +
              (wFp ? "\n" + wFp : "");
            WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
            /* #35: the page cache holds the composed copy (specifiers
               rewritten, prelude prepended); a stored raw body would
               serve a second visit unrewritten. */
            /* Issue B: decode with the upstream charset (the fetch
               spec's text() is always UTF-8 and mangled legacy
               script bodies); the composed copy is re-encoded UTF-8
               and the served header says so. */
            outHeaders.set("content-type", utf8ContentType(respCt));
            const out = new Response(head + src, { status: resp.status, headers: outHeaders });
            if (e.request.method === "GET")
              void pageCacheStore(e.request, out.clone(), false, finalDest, cookieClientId);
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
              "self.__ZL_SITE__=" + JSON.stringify(siteToken(target)) + ";\n" +
              (await workerPrelude()) +
              "\nself.__zlPreludeInit&&self.__zlPreludeInit(" + JSON.stringify(encodeDestLegacy(target)) + ");\n" +
              (preludeW ? "\n" + preludeW : "");
            /* #201: a cancelled consumer must reach the upstream reader;
               the reader locks the body, so hoist it and cancel
               through it. */
            const rd = resp.body!.getReader();
            let wpCancelled = false;
            const body = new ReadableStream<Uint8Array>({
              async start(c) {
                c.enqueue(new TextEncoder().encode(prelude));
                try {
                  for (;;) {
                    const { done, value } = await rd.read();
                    if (done) break;
                    c.enqueue(value);
                  }
                  c.close();
                } catch (e) {
                  /* #201: enqueue/close on a cancelled controller is
                     teardown, not failure. */
                  if (!wpCancelled) throw e;
                }
              },
              async cancel() {
                wpCancelled = true;
                try {
                  await rd.cancel();
                } catch {
                  /* already gone */
                }
              },
            });
            WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
            /* #35: clone() tees the composed stream, so the browser
               keeps its streaming path while the cache consumes the
               other fork. */
            const out = new Response(body, { status: resp.status, headers: outHeaders });
            if (e.request.method === "GET")
              void pageCacheStore(e.request, out.clone(), false, finalDest, cookieClientId);
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
          if (JS_TRANSFORM_DESTS.has(e.request.destination) && isJs(resp) && resp.body && !policyNativeJs && !cdnCgiNative) {
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
            WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
            /* Issue B: the decoded-with-upstream-charset body is
               re-encoded UTF-8 by the string Response constructor;
               the served header must say so. */
            outHeaders.set("content-type", utf8ContentType(respCt));
            const out = new Response(src, { status: resp.status, headers: outHeaders });
            if (e.request.method === "GET")
              void pageCacheStore(e.request, out.clone(), false, finalDest, cookieClientId);
            return out;
          }
          WEBREQ.completed({ ...wrDetailsFinal, statusCode: resp.status });
          /* #96: surfaceNotModified above - a SW-served 304 cannot
             complete a page fetch, so the revalidation result is
             converted to a marked 200. */
          if (resp.status === 304) return surfaceNotModified(outHeaders);
          /* #102: a 204/205 answering a navigation commits an empty
             document - the embedder sees a blank frame and no error,
             the exact intermittent-blank the beta reported. No
             Content is not a navigable response; surface the honest
             error page instead of the silent empty commit. */
          if (e.request.mode === "navigate" && (resp.status === 204 || resp.status === 205))
            return new Response(
              errorPage({
                route: url.pathname + url.search,
                category: "route",
                engineVersion: ZEOLITE_VERSION,
                reason: "upstream answered the navigation with " + resp.status + " No Content",
                traceId,
                status: 502,
              }),
              { status: 502, headers: { "content-type": "text/html; charset=utf-8" } },
            );
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
          WEBREQ.errorOccurred({ ...wrDetails, url: lastHopUrl, error: String(err) });
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
                attribution: failure.cause === "upstream" ? "upstream" : "engine",
                httpProceed: httpProceedHref(url) ?? undefined,
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
  })();
  e.respondWith(responsePromise);
  void responsePromise.then(finishGhosteryHold, finishGhosteryHold);
}

/** #112 follow-up: dereference a route token embedded in an UPSTREAM
    destination. A proxied page's JS reads location.pathname, which is
    the opaque engine route, so an absolute URL built as <real origin> +
    location.pathname carries the token as the target path and 404s
    upstream. The engine can decode its own routes: when the embedded
    path is a decodable route (keyed token, with recoverPath covering
    token+plaintext concatenations, or a nav handle inside its TTL) and
    the decoded origin equals the destination's own origin, the page
    meant the decoded page - fetch the decoded path with the request's
    own query, exactly like a normal engine route. Token decode is
    MAC-verified, so a foreign path that merely looks like a route
    fails closed and passes through untouched. */
/** LB #76 HTTPS-only: the proceed-anyway link for a navigation that
    failed after the upgrade. The route still encodes the original
    cleartext destination, so the page can offer exactly one
    escape: reload this route with zlHttpOk=1, which exempts the
    host for the session and fetches it over cleartext. Null when
    the upgrade is off, the route does not decode to a cleartext
    destination, or the host is already exempt. */
export function httpProceedHref(url: URL): string | null {
  if (!isHttpsUpgrade()) return null;
  let orig: string | null = null;
  try {
    if (url.pathname.startsWith(NAVH + "/")) {
      const t = url.pathname.slice(NAVH.length + 1).split(/[?#]/)[0];
      orig = decodeNavHandle(t.split("/")[0]);
    } else if (isEnginePath(url.pathname)) {
      orig = decodePath(url.pathname);
      if (!orig) orig = recoverPath(url.pathname);
    }
  } catch {
    orig = null;
  }
  if (!orig || !orig.startsWith("http://")) return null;
  if (httpExemptHas(orig)) return null;
  const sep = url.search ? "&" : "?";
  return url.pathname + url.search + sep + "zlHttpOk=1";
}

/** #143 follow-up: recover the destination of a NAVH-prefix tail that
    is not a bare handle token. Suffix-bearing tails (<token>/<suffix>)
    are page-built appends to location.pathname: resolve the suffix
    against the page-path append base (the client virtual context URL,
    the token own destination as the fallback), NOT directory
    semantics - the page meant <real page path>/<suffix>. Bare tails
    are relative fetches the URL parser resolved against the opaque
    location (which drops the token): resolve with ordinary URL
    semantics against the context. A token-shaped bare tail that does
    not decode returns null - the honest strand. Pure: the caller owns
    the navigation gate and the 404. */
export function navhTailDest(
  tail: string,
  contextUrl: string | null,
  tokenShaped: boolean,
  tokenDest: (token: string) => string | null,
): string | null {
  const pageBase = (u: string | null): string | null => {
    if (!u) return null;
    try {
      const p = new URL(u);
      return p.origin + p.pathname;
    } catch {
      return null;
    }
  };
  const resolved = (base: string): string | null => {
    try {
      return new URL(tail, base).href;
    } catch {
      return null;
    }
  };
  const slash = tail.indexOf("/");
  if (slash >= 0) {
    const head = tail.slice(0, slash);
    const tokenBase = pageBase(tokenDest(head));
    if (tokenBase || tokenShaped) {
      /* <token>/<suffix>: a page-built append to the opaque route -
         the URL parser drops the token segment whenever it resolves
         a relative input, so a token-bearing tail is never a
         parser resolution. */
      /* #144: a new-shape handle parks the page at
         <handle>/<token>/<real path>, so a page append arrives as
         <real path>/<append> - an ABSOLUTE path from the root, not a
         relative one. When the client context confirms it (the
         context's own path prefixes the tail), resolve against the
         context ORIGIN; the append base below would double the
         path. Legacy tails (an append to a bare token) never match
         their own context path this way. */
      if (!tokenBase && contextUrl) {
        try {
          const cu = new URL(contextUrl);
          /* the parked tail has no leading slash (it follows the
             token segment), the context path does: compare stripped. */
          const cp = cu.pathname.startsWith("/") ? cu.pathname.slice(1) : cu.pathname;
          const abs = tail.slice(slash + 1);
          if (cp !== "" && (abs === cp || abs.startsWith(cp + "/"))) {
            return new URL(abs, cu.origin + "/").href;
          }
        } catch {
          /* fall through to the append base */
        }
      }
      /* #395: a token-shaped head that does not decode (an expired
         handle) still parks the page on the handle form, so the tail
         after the token is a full path from the root: resolve against
         the context ORIGIN. The old page-path base treated the
         document path as a directory and doubled it
         (/dir/page/dir/assets/x.js 404s upstream). */
      let base = tokenBase;
      if (!base && contextUrl) {
        try {
          base = new URL(contextUrl).origin + "/";
        } catch {
          base = null;
        }
      }
      if (!base) return null;
      if (!base.endsWith("/")) base += "/";
      try {
        return new URL(tail.slice(slash + 1), base).href;
      } catch {
        return null;
      }
    }
    /* Parser-resolved relative against the opaque location: the URL
       parser dropped the token, so ordinary URL semantics against
       the page context are the page intent. */
    return contextUrl ? resolved(contextUrl) : null;
  }
  /* Bare tail: a token-shaped one that did not decode is a rotation
     strand (null); a path-like one resolves against the context. */
  if (contextUrl && !tokenShaped) return resolved(contextUrl);
  return null;
}

export function derefSelfRoute(target: string, engineOrigin: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol)) return target;
  if (u.origin === engineOrigin) return target;
  const p = currentPrefix();
  if (
    !u.pathname.startsWith(NAVH + "/") &&
    !u.pathname.startsWith(p) &&
    !u.pathname.startsWith("/zl/")
  )
    return target;
  let decoded: string | null = null;
  if (u.pathname.startsWith(NAVH + "/")) {
    decoded = decodeNavHandlePath(u.pathname.slice(NAVH.length + 1).split(/[?#]/)[0]);
  } else {
    decoded = decodePath(u.pathname);
    if (!decoded) decoded = recoverPath(u.pathname);
  }
  if (!decoded) return target;
  let du: URL;
  try {
    du = new URL(decoded);
  } catch {
    return target;
  }
  /* Cross-origin decode is the AI-overview asset class: the rewriter
     minted this route for an asset on a sibling host (gstatic et al)
     and page JS rebuilt it as <page origin> + location.pathname. The
     token is MAC-authenticated, so dereferencing to the minted
     destination adds no capability: the page could fetch the same
     route on the engine origin directly. */
  return du.origin + du.pathname + (u.search || du.search);
}

/** #112: reCAPTCHA's enterprise endpoints validate the site key against
    the co= param (base64 of the embedding page's origin, '=' padded as
    '.'). The page's JS computes it from window.location.origin, which
    the engine can never virtualize (LegacyUnforgeable), so every
    proxied embed sends the engine origin and the widget answers
    "Invalid domain for site key". This seam rewrites a co= that names
    this deployment to the virtual origin of the embedding page (the
    browser-observed client context, with the decoded referrer as
    fallback). An unknown embedding origin stays unmodified (#436). Rendering fidelity only: the challenge
    itself is never solved or bypassed. */
export function virtualRecaptchaCo(target: string, referrer: string, engineOrigin: string, initiator?: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol)) return target;
  if (u.host !== "www.google.com" && u.host !== "www.recaptcha.net") return target;
  if (!u.pathname.startsWith("/recaptcha/")) return target;
  const m = /([?&])co=([^&]*)/.exec(u.search);
  if (!m || !m[2]) return target;
  let dec: string;
  try {
    dec = atob(percentDecode(m[2]).replace(/\./g, "="));
  } catch {
    return target;
  }
  /* Only a co= that names THIS deployment is ours to fix; any other
     value is an origin the page genuinely chose. */
  if (dec !== engineOrigin && dec !== engineOrigin + ":443" && dec !== engineOrigin + ":80")
    return target;
  const home = referrerOrigin(referrer, initiator);
  if (!home) return target;
  let vu: URL;
  try {
    vu = new URL(home);
  } catch {
    return target;
  }
  const port = vu.port ? "" : vu.protocol === "https:" ? ":443" : ":80";
  const co = btoa(vu.origin + port).replace(/=+$/, (p) => ".".repeat(p.length));
  return u.href.replace(m[0], m[1] + "co=" + co);
}

/** The Google apps widget (ogs.google.com /widget/) receives an
    origin= built by page JS from window.location.origin
    (LegacyUnforgeable, the #112 co= class), so upstream always sees
    the engine origin and the widget never renders. Virtualize an
    origin= that names this deployment at the seam the engine owns;
    rendering fidelity only. */
export function virtualOgsOrigin(target: string, referrer: string, engineOrigin: string, initiator?: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol)) return target;
  if (u.host !== "ogs.google.com") return target;
  if (!u.pathname.startsWith("/widget/")) return target;
  const m = /([?&])origin=([^&]*)/.exec(u.search);
  if (!m || !m[2]) return target;
  let dec: string;
  try {
    dec = decodeURIComponent(m[2]);
  } catch {
    return target;
  }
  /* Only an origin= that names THIS deployment is ours to fix; any
     other value is an origin the page genuinely chose. */
  if (dec !== engineOrigin && dec !== engineOrigin + ":443" && dec !== engineOrigin + ":80")
    return target;
  /* Without a verified page origin there is no honest widget-side
     fallback, so the request passes through unchanged. */
  const parent = referrerOrigin(referrer, initiator);
  if (!parent) return target;
  return u.href.replace(m[0], m[1] + "origin=" + encodeURIComponent(parent));
}

/** The hCaptcha widget (newassets.hcaptcha.com frames,
    api.hcaptcha.com config/challenge endpoints) receives a host= built
    by page JS from window.location.hostname (LegacyUnforgeable, the
    #112 co= class): hCaptcha validates it against the sitekey's
    registered hostnames, so a virtualized page names the engine host
    and the widget never renders (#433). Virtualize a host= that
    names this deployment at the seam the engine owns; rendering
    fidelity only. */
export function virtualHcaptchaHost(target: string, referrer: string, engineOrigin: string, initiator?: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol)) return target;
  if (u.host !== "newassets.hcaptcha.com" && u.host !== "api.hcaptcha.com")
    return target;
  if (u.host === "newassets.hcaptcha.com" && !u.pathname.startsWith("/captcha/"))
    return target;
  if (
    u.host === "api.hcaptcha.com" &&
    !u.pathname.startsWith("/checksiteconfig") &&
    !u.pathname.startsWith("/getcaptcha")
  )
    return target;
  const m = /([?&])host=([^&]*)/.exec(u.search);
  if (!m || !m[2]) return target;
  let dec: string;
  try {
    dec = decodeURIComponent(m[2]);
  } catch {
    return target;
  }
  /* Only a host= that names THIS deployment is ours to fix; any other
     value is a hostname the page genuinely chose. The SDK sends
     window.location.hostname; host and origin forms are accepted so
     a page that built the value differently still gets its real
     host back. */
  let engineHost = "";
  let engineHostname = "";
  try {
    const eo = new URL(engineOrigin);
    engineHost = eo.host;
    engineHostname = eo.hostname;
  } catch {
    return target;
  }
  if (
    dec !== engineHostname &&
    dec !== engineHost &&
    dec !== engineOrigin &&
    dec !== engineOrigin + ":443" &&
    dec !== engineOrigin + ":80" &&
    dec !== engineHost + ":443" &&
    dec !== engineHost + ":80"
  )
    return target;
  /* No honest widget-side fallback exists: without a decoded page
     origin hCaptcha cannot validate the request, so it passes
     through unchanged. */
  const parent = referrerOrigin(referrer, initiator);
  if (!parent) return target;
  let vu: URL;
  try {
    vu = new URL(parent);
  } catch {
    return target;
  }
  return u.href.replace(m[0], m[1] + "host=" + encodeURIComponent(vu.hostname));
}

/** #431: MSAL and sibling OAuth SPAs compute redirect_uri from
    window.location.origin (LegacyUnforgeable, the #112 co= class):
    the AAD authorize request names the ENGINE origin, the token
    round-trip lands on a native engine-origin URL the proxy never
    re-enters, and the login chain ends on a blank content-origin
    page (Outlook). Virtualize a redirect_uri whose origin names
    this deployment on the Microsoft authorize endpoints; the path
    and query stay (MSAL appends its own routes to the origin it
    was given) and the state param round-trips untouched. Auth
    fidelity only. */
export function virtualAuthorizeRedirect(target: string, referrer: string, engineOrigin: string, initiator?: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol)) return target;
  if (
    u.host !== "login.microsoftonline.com" &&
    u.host !== "login.microsoft.com" &&
    u.host !== "login.live.com"
  )
    return target;
  if (!u.pathname.includes("/oauth2/") || !u.pathname.endsWith("/authorize"))
    return target;
  const m = /([?&])redirect_uri=([^&]*)/.exec(u.search);
  if (!m || !m[2]) return target;
  let dec: string;
  try {
    dec = decodeURIComponent(m[2]);
  } catch {
    return target;
  }
  /* The value is a full URL: only a redirect_uri whose ORIGIN names
     THIS deployment is ours to fix (the #112 match set, compared
     post-parse so explicit default-port forms normalize); any other
     value is a page the app genuinely registered. */
  let du: URL;
  let eo: URL;
  try {
    du = new URL(dec);
    eo = new URL(engineOrigin);
  } catch {
    return target;
  }
  if (du.origin !== eo.origin) return target;
  /* No honest fallback exists: without a decoded page origin the
     token round-trip has nowhere honest to land, so the request
     passes through unchanged. */
  const parent = referrerOrigin(referrer, initiator);
  if (!parent) return target;
  return u.href.replace(
    m[0],
    m[1] + "redirect_uri=" + encodeURIComponent(parent + du.pathname + (du.search || "")),
  );
}

/** A frame fragment is browser-only and never reaches handleFetch.
    zl:mint still sees the original URL, so a verified sender can
    normalize the hCaptcha frame's host= there before route encoding.
    Reuse the query helper's identity checks; edit only the matched
    fragment value so unrelated query/hash bytes stay untouched. */
export function virtualHcaptchaFrameFragment(target: string, engineOrigin: string, initiator?: string): string {
  if (!initiator) return target;
  let u: URL;
  try { u = new URL(target); } catch { return target; }
  if (!/^https?:$/.test(u.protocol) || u.host !== "newassets.hcaptcha.com") return target;
  if (!u.pathname.startsWith("/captcha/") || !u.pathname.endsWith("/hcaptcha.html")) return target;
  const cut = target.indexOf("#");
  if (cut < 0) return target;
  const fragment = target.slice(cut);
  const m = /([#&])host=([^&]*)/.exec(fragment);
  if (!m || !m[2]) return target;
  const probe = u.origin + u.pathname + "?host=" + m[2];
  const fixed = virtualHcaptchaHost(probe, "", engineOrigin, initiator);
  if (fixed === probe) return target;
  const host = new URL(fixed).searchParams.get("host");
  if (!host) return target;
  return target.slice(0, cut) + fragment.replace(m[0], m[1] + "host=" + encodeURIComponent(host));
}

/** #120: challenge-widget frame URLs (reCAPTCHA, hCaptcha, Turnstile
    - the shapes whose FRAMES are the challenge UI a human solves).
    The google hosts are scoped to /recaptcha/ so ordinary
    google.com embeds (maps, players) keep routing through the
    engine; every path on challenges.cloudflare.com is a challenge
    surface. Script and XHR requests to these hosts are not frame
    navigations and route as before. */
export function isChallengeFrameUrl(target: string): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname;
  if (h === "www.google.com" || h === "www.recaptcha.net" || h === "recaptcha.net") {
    return u.pathname.startsWith("/recaptcha/");
  }
  return (
    h === "challenges.cloudflare.com" || h === "hcaptcha.com" || h === "newassets.hcaptcha.com"
  );
}

/** The virtual origin of the page that embedded a recaptcha frame:
    decode its engine-route referrer (keyed route or nav handle). */
function referrerOrigin(referrer: string, initiator?: string): string | null {
  /* #436: browser-owned client context survives no-referrer/origin-only
     policies and expired route tokens. Unknown context falls back to
     a verified route; a page-supplied origin claim is never used. */
  if (initiator) {
    try {
      const u = new URL(initiator);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch { /* malformed context falls through */ }
  }
  if (!referrer) return null;
  try {
    const refU = new URL(referrer, "https://zl.invalid/");
    let ref = decodePath(refU.pathname);
    if (!ref && refU.pathname.startsWith(NAVH + "/"))
      ref = decodeNavHandlePath(refU.pathname.slice(NAVH.length + 1));
    /* Injector phase 2: a query-shape referrer carries its token in
       the search; the path is the real destination path. */
    if (!ref && queryHandleToken(refU.search) !== null)
      ref = decodeQueryHandle(refU)?.destination ?? null;
    /* #113: legacy /zl/ routes from cold starts or pre-#113 dists
       also fail decodePath when the prefix is not configured yet.
       decodeLegacyRoute recovers them at the escape seam. */
    if (!ref) {
      ref = decodeLegacyRoute(refU.pathname);
    }
    return ref ? new URL(ref).origin : null;
  } catch {
    return null;
  }
}

/** Percent-decode a query value without form '+' semantics: the co=
    payload is base64 and '+' inside it is data, not a space. */
function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  } catch {
    return s;
  }
}

/* #158/#159 made visible (2026-10-14 report): the script-body mask is
   a stopgap for URL-resolution misses; every masked response is a
   broken module in disguise. Pure decision + counter so the
   regression harness can prove the zero-mask shapes and the
   diagnostics name the real wrong-URL cases (requested path,
   referrer, resolved route) instead of hiding them. */
export function needsScriptBodyMask(dest: string, destination: string, contentType: string): boolean {
  if (dest !== "script" && !isWorkerDestination(destination)) return false;
  return contentType.includes("text/html") || contentType.includes("text/css");
}

export function maskedScriptResponse(status: number, contentType: string): Response {
  return new Response(
    "/* upstream " + status + " " + (contentType.split(";")[0] || "non-JS") + " */",
    {
      status,
      headers: { "content-type": "application/javascript; charset=utf-8" },
    },
  );
}

let maskedScriptResponses = 0;
export function maskedScriptCount(): number {
  return maskedScriptResponses;
}

export function recordMaskedScript(requested: string, referrer: string, route: string): void {
  maskedScriptResponses++;
  DIAG.emit({
    category: "REWRITE",
    severity: "warning",
    message: "masked non-JS body served to a script destination (wrong-URL class; every one counted)",
    url: requested,
    technicalReason: "referrer=" + referrer + " resolved-route=" + route,
  });
}

/** Per-request header surgery: drop hop-by-hop + engine-origin leaks,
    restore the real destination as Referer. */
/* #194: a cross-origin redirect hop recomputes what may travel:
   the page-minted Referer and every header injected for the previous
   host by rules, interception or plugins stay behind. Deliberately
   strict: the page's Referrer-Policy is not captured here, so the
   Referer drops entirely instead of degrading to the origin - it
   never leaks more than the strictest policy would. */
export function stripCrossOriginHopHeaders(sendHeaders: Headers, injectedKeys: Iterable<string>): void {
  sendHeaders.delete("referer");
  for (const k of injectedKeys) sendHeaders.delete(k);
}

export function forwardedHeaders(req: Request, target: string, initiator?: string): Headers {
  const out = new Headers();
  /* Sec-Fetch headers are never copied: the SW-visible values
     describe the engine iframe's fetch, not the virtual page's
     request (and are absent on browsers that hide them, #40).
     They are rebuilt below from the virtual facts. */
  const skip = new Set([
    "host",
    "connection",
    "referer",
    "origin",
    "cookie",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
    "upgrade-insecure-requests",
    /* The engine-observed physical value is never forwarded; a
       persona of Chrome 133 or newer gets Sec-Fetch-Storage-Access
       synthesized below from the persona claim instead. */
    "sec-fetch-storage-access",
    /* Proxy-injected hop headers (#160): the reverse proxy in front
       of the SW origin adds x-forwarded-* to the inbound request;
       copying them upstream is a proxy tell no real browser sends. */
    ...PROXY_INJECTED_HEADERS,
  ]);
  for (const [k, v] of req.headers) {
    if (!skip.has(k.toLowerCase())) out.set(k, v);
  }
  if (req.referrer) {
    const refU = new URL(req.referrer, self.location.origin);
    /* Mirror routes carry the page query in the route URL's search
       (b64u encodes it inside the tail); the Referer must match what
       direct browsing sends (issue #20). */
    let ref = decodePath(refU.pathname);
    let queryReferrer = false;
    /* #112: a nav-handle document keeps the real destination inside
       its keyed token, so decodePath fails on the navh route and
       every subresource from that page lost the Referer upstream.
       The reCAPTCHA anchor on google's /sorry validates the site key
       against exactly that header and answers "Invalid domain for
       site key" when it is missing. Decode the handle with the same
       key that minted it. ponytail: the navh TTL still applies, so a
       page on a navh route past its window degrades to an omitted
       Referer again. */
    if (!ref && refU.pathname.startsWith(NAVH + "/")) {
      /* #144: the handle route carries the real path after the token
         (the real query is the route search, appended below), so the
         Referer is the full upstream page URL. */
      ref = decodeNavHandlePath(refU.pathname.slice(NAVH.length + 1));
    }
    /* Injector phase 2: a query-shape referrer carries its token in
       the search; the path is the real destination path. */
    if (!ref && queryHandleToken(refU.search) !== null) {
      ref = decodeQueryHandle(refU)?.destination ?? null;
      queryReferrer = ref !== null;
    }
    /* #113: legacy /zl/ routes from cold starts or pre-#113 dists
       also fail decodePath when the prefix is not configured yet.
       decodeLegacyRoute recovers them at the escape seam. */
    if (!ref) {
      ref = decodeLegacyRoute(refU.pathname);
    }
    /* #435: query decoding already removed the verified engine
       component. Never reattach the physical zlNavh search. */
    if (ref) out.set("referer", queryReferrer ? ref : mergeRouteSearch(ref, refU.search));
    /* #127: a page with an origin-only referrer policy (google.com
       serves one) sends the engine ORIGIN root as Referer, which no
       route decode recovers, so every subresource from that page
       lost the Referer upstream - and google's reCAPTCHA anchor on
       /sorry validates the site key against exactly this header. The
       browser already told us the policy stripped the referrer to
       the origin; the virtual equivalent is the controlling page's
       origin. Restore it. The Scout-report warning (2026-10-06)
       stays for the case where even the initiator is unknown:
       sending the raw engine route would leak the proxy origin
       upstream, so the header stays omitted there - but the event is
       recorded instead of being swallowed. */
    else {
      const refererFallback = virtualRefererFallback(initiator);
      if (refererFallback) out.set("referer", refererFallback);
      else
        DIAG.emit({
          category: "TRANSPORT",
          severity: "warning",
          message: "engine-route referrer did not decode; Referer omitted",
          url: req.referrer,
        });
    }
  }
  /* Issue #23: the virtual origin. Every request the page makes is
     same-origin on the engine side, so the browser Origin and
     Sec-Fetch-Site carry engine facts upstream sites never issued;
     strict-origin checks reject those POSTs (chatgpt.com). Recompute
     both from the virtual initiator; unknown initiator sends none. */
  const vo = virtualOriginHeaders(initiator, target, req.method, req.mode);
  if (vo.origin) out.set("origin", vo.origin);
  const sf = secFetchHeaders(initiator, target, req.method, req.mode, req.destination);
  if (sf.site) out.set("sec-fetch-site", sf.site);
  if (sf.mode) out.set("sec-fetch-mode", sf.mode);
  if (sf.dest) out.set("sec-fetch-dest", sf.dest);
  if (sf.user) out.set("sec-fetch-user", sf.user);
  if (sf.upgradeInsecureRequests) out.set("upgrade-insecure-requests", "1");
  if (!out.has("accept-language")) out.set("accept-language", "en-US,en;q=0.9");
  /* 1.8 Telluride: while a profile is active, the wire surface must
     match the document surface, so its UA and languages win over
     whatever the page sent. */
  const profile = getFpProfile();
  if (profile) out.set("accept-language", acceptLanguageValue(profile.languages));
  if (profile && profile.matchUserAgent !== false) {
    out.set("user-agent", profile.userAgent);
    /* The navigation Accept must match the CLAIMED major, not the
       physical browser's: a Chrome 124 persona carrying image/jxl
       (a Chrome 155+ format) contradicts its own UA. */
    if (req.mode === "navigate") {
      const navAccept = navigationAccept(profile.userAgent);
      if (navAccept) out.set("accept", navAccept);
    }
    /* Storage Access Headers ship in Chrome 133: a persona of that
       major or newer must carry Sec-Fetch-Storage-Access on exactly
       the requests a real one sends it on (cross-site, credentials
       include). The persona claim is "none": a proxied page has no
       unpartitioned storage access to the target origin. */
    const personaMajor = /(?:Chrome|Chromium)\/(\d+)/.exec(profile.userAgent);
    if (
      req.credentials === "include" &&
      out.get("sec-fetch-site") === "cross-site" &&
      personaMajor &&
      parseInt(personaMajor[1], 10) >= 133
    ) {
      out.set("sec-fetch-storage-access", "none");
    }
  }
  return out;
}


