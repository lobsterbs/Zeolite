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
import { b64uDecode, b64uEncode, decodeClientUrl, decodeLegacyRoute, decodeNavHandle, decodeNavHandlePath, decodePath, encodeDest, encodeDestLegacy, isEngineAsset, isEnginePath, isOpaqueUrl, isWorkerDestination, looksKeyedToken, NAVH, passChallengeRedirFixed, recoverPath, referrerDest, setRouteKeys, setScheme, unwrapDest, currentPrefix } from "./codec";

import { decodeBody, mapRefreshHeader, stripHostile, utf8ContentType } from "./headers";
import { parseKdl } from "./kdl";
import { loadRouteHistory, saveRouteKey } from "./routekey";
import { classifyForeign, preflightHeaders } from "./foreign";
import { NAV, NAVP } from "./bootstrap/navguard";

import { planRange, ZL_RANGE_MAX } from "./range";
import { applyEngineCors } from "./cors";
import { classifyFailure, errorPage, type ErrorCategory } from "./errorpage";
import { rewriteModuleWorkerImports } from "./worker-imports";
import { decideTransport, refineWithContent, reasonOf, sniffsAsHtml, transitRecord, relayRecord, wispRecord, DOC_DESTS, JS_TRANSFORM_DESTS, type TransitDecision } from "./transit";
import { loadPolicy, policyMatch, type CompiledPolicy } from "./policy";
import { relayAvailable, relayFetch, requestRelayReRegister } from "./relayfetch";
import { cssRewriteStream, isCss, isHtml, isJs, rawFrom, rewriteJsBody, rewriteStream, workerPrelude } from "./transform";
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
import { siteToken } from "./pageload";

import { altConfigured, altEndpoint, altRegister, altWispFetch, wispTransport } from "./transport";
import { raceBoot } from "./lifecycle";



import {PROXY_INJECTED_HEADERS, acceptLanguageValue, applyChUa, navigationAccept, secFetchHeaders, virtualOriginHeaders, virtualRefererFallback} from "./origin";
import { capContexts, contextOf, establishContext, resolveRelative, VCTX_CAP } from "./vctx";
import { assetBaseCount, isRecoverableAssetDest, isRecoverableAssetPath, recordAssetBase, recoverFlatAsset, recordScriptUrl, recoverFlagSurgeryScript } from "./assetbases";
import { anySessionProfileActive, applySetCookie, cookieHeaderFor, flushJarPersist, inheritJarClient, isPassChallenge, jarClientHasRoot, jarHeaders, jarProfileState, markJarClientUnbound, pruneJarClients, type CookieRequestContext } from "./cookies";
/* #87: the shared service-worker runtime state (per-client virtual
   contexts, route-shape toggles, route key, fingerprint profile +
   per-site profile cache) lives in ./swstate; the engine and the
   control plane are call sites. */
import { destUpgraded, getFpProfile, getFpWorkerScript, httpExemptAdd, httpExemptHas, isHttpsUpgrade, navHandlesEnabled, pushDocCookieView, setHttpsUpgrade, setNavHandles, setRouteKey, siteDisabled, siteProfileFor, VCTX, ZEOLITE_VERSION } from "./swstate";

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
    const sroute = decodePath(su.pathname);
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
  const rule = policyMatch(policy, dest, rtype);
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
  const route = decodePath(u.pathname);
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
      finalUrl = new URL(loc, dest).href;
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
        !isEnginePath(pu.pathname);
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
          (altEndpoint() ? " wisp-endpoint " + JSON.stringify(altEndpoint()) : ""),
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
            (isEnginePath(sourceUrl.pathname) || sourceUrl.pathname.startsWith(NAVH + "/"))
          ) markJarClientUnbound(e.clientId);
        } catch {
          /* An unparseable client URL cannot establish a proxied root. */
        }
        /* #366: a worker client whose owner root cannot be established
           (an opaque blob worker script carries neither an engine path
           nor a NAVH handle) would otherwise fall back to the shared
           default jar and read or write cookies across profiles. Fail
           closed while any session profile is active: the client rides
           the cookie-free unbound namespace until its host rebinds it. */
        const ctype = (sourceClient as { type?: string }).type;
        if (
          (ctype === "worker" || ctype === "sharedworker") &&
          !jarClientHasRoot(e.clientId) &&
          anySessionProfileActive()
        ) {
          markJarClientUnbound(e.clientId);
        }
      }
    } catch {
      /* No client URL means no recoverable NAVH root; the jar seam
         keeps the existing default-profile behavior for that client. */
    }
  }
  scheduleJarClientPrune();
  /* 1.5 Silicide: opaque schemes (blob:, data:, about:) are browser-native
     and never engine routes: createObjectURL media, blob workers and
     generated downloads pass through untouched. Checked before the
     origin test: their origin is "null" or a foreign blob origin, and
     they stay browser-owned in every case. */
  if (isOpaqueUrl(url)) {
    /* #171: opaque WORKER scripts still execute engine-prepended
       prelude bytes, so their realm is engine-shaped; without a baked
       site token the worker's indexedDB/caches/BroadcastChannel stay
       raw (unscoped). Derive the creating page's site identity from
       the creating client and bake it into the prelude head. Every
       other opaque request stays browser-owned, as before. */
    if (!isWorkerDestination(e.request.destination) || e.request.method !== "GET") return;
    e.respondWith(
      (async () => {
        let site = "";
        try {
          const client = e.clientId ? await self.clients.get(e.clientId) : null;
          if (client) {
            const cu = new URL(client.url);
            site = siteToken(decodeClientUrl(cu) ?? recoverPath(cu.pathname) ?? "");
          }
        } catch { /* honest fallback: an empty token still isolates */ }
        const resp = await fetch(e.request);
        const ct = resp.headers.get("content-type") ?? "";
        const src = decodeBody(await resp.arrayBuffer(), ct);
        const head =
          "self.__ZL_PREFIX__=" + JSON.stringify(currentPrefix()) + ";\n" +
          "self.__ZL_SITE__=" + JSON.stringify(site) + ";\n" +
          (await workerPrelude()) +
          "\nself.__zlPreludeInit&&self.__zlPreludeInit(" + JSON.stringify(encodeDestLegacy(e.request.url) ?? "") + ");\n";
        return new Response(head + src, {
          status: resp.status,
          headers: { "content-type": utf8ContentType(ct) },
        });
      })(),
    );
    return;
  }
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
          if (engineReady) await raceBoot(engineReady, "extension subsystem boot");
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
      /* Route-key restoration is needed to authenticate the NAVH host
         binding. Re-run this after the cold-start gate before any
         cookie or cache decision. */
      cookieClientId = inheritJarClient(
        e.clientId || undefined,
        e.resultingClientId || undefined,
        url.href,
      );
      await recoverJarClientRoot();
      await discardLegacyPageCache();
      /* #249: a wedged boot step (storage, extension boot) must not
         hang the whole fetch path; serve degraded past the
         deadline. */
      if (engineReady) await raceBoot(engineReady, "engine boot");
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
      } else if (url.pathname.includes(NAVP)) {
        /* #101: a root-relative or relative input re-emitted by the
           page or a guarded child realm as <parent route>/<NAVP>/
           <encoded input>; the parent decodes to its destination and
           the tail resolves against it. #157: this branch runs BEFORE
           the NAV and NAVH branches (a NAVH parent carries the marker
           inside its plaintext suffix, where the handle branch would
           resolve it into the upstream path), and the parent decode
           covers scheme routes, NAVH handles and NAV navigation
           routes. A bad route is never guessed. */
        const navpDest = navpResolve(url.pathname);
        if (!navpDest) return navOutcome(e, url, 404, "route", "zeolite: bad route");
        dest0 = navpDest;
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
        const navhTail = url.pathname.slice(NAVH.length + 1).split(/[?#]/)[0];
        /* #63 unchanged contract first: a bare, unexpired handle is
           the navigation itself (and a bare subresource fetch of the
           handle route keeps serving the handle destination). A tail
           with a "/" cannot be a token: the URL parser drops the
           token segment whenever it resolves a relative input, so
           <token>/<suffix> is always a page-built path. */
        const handleDest = navhTail.includes("/") ? null : decodeNavHandle(navhTail);
        if (handleDest) {
          dest0 = handleDest;
          /* #144: the real query rides in the route search; the merge
             seam replaces a full-dest token's own query with it
             (browser "?x" semantics), so a legacy token that carries
             one keeps its query only while the route has none. */
          routeCarriesQuery = true;
        } else if (e.request.mode === "navigate") {
          /* #144: pathname-routed SPAs parked on the opaque handle
             route push location.pathname-built URLs as
             <handle>/<suffix> navigations. Recover them with the
             same tail semantics the fetch strand uses (#143): the
             suffix appends to the token destination own page
             path, the requesting client context as the base when
             one exists. A bare expired or rotated handle keeps
             the honest 404 strand, and a suffix that recovers to
             nothing strands too - never a guess. */
          const navhNavSlash = navhTail.indexOf("/");
          const navhNavCtx = navhNavSlash >= 0 ? contextOf(VCTX, e.clientId) : null;
          const navhNavRec =
            navhNavSlash >= 0
              ? navhTailDest(
                  navhTail,
                  navhNavCtx ? navhNavCtx.currentUrl : null,
                  looksKeyedToken(currentPrefix() + navhTail.slice(0, navhNavSlash)),
                  decodeNavHandle,
                )
              : null;
          if (!navhNavRec)
            return navOutcome(e, url, 404, "route", "zeolite: bad or expired navigation handle");
          dest0 = navhNavRec;
          /* #144: the tail resolution is query-free by construction
             (navhTail strips the search); the real query rides in the
             route search. */
          routeCarriesQuery = true;
        } else {
          /* #143 follow-up: a page parked on the opaque handle route
             cannot read its real path (LegacyUnforgeable location),
             so runtime URL building that appends to
             location.pathname arrives as <handle>/<suffix>, and a
             relative fetch the URL parser resolves against the
             opaque location arrives as a bare tail. Both recover
             against the requesting client virtual context (#33),
             the handle token as the context-less fallback;
             token-shaped tails that do not decode keep the honest
             404 (a rotation strand, never a guess). Navigations
             recover in their own branch above (#144); this fetch
             branch strands only what recovers to nothing. */
          const navhCtx = contextOf(VCTX, e.clientId);
          /* Token shape is a property of the head segment: a
             suffix-bearing tail is never one token, and a bare tail
             is judged whole. */
          const navhSlash = navhTail.indexOf("/");
          const navhHead = navhSlash >= 0 ? navhTail.slice(0, navhSlash) : navhTail;
          const navhRec = navhTailDest(
            navhTail,
            navhCtx ? navhCtx.currentUrl : null,
            looksKeyedToken(currentPrefix() + navhHead),
            decodeNavHandle,
          );
          if (!navhRec) return navOutcome(e, url, 404, "route", "zeolite: bad or expired navigation handle");
          dest0 = navhRec;
          routeCarriesQuery = true; /* #144: the real query rides in the route search */
        }
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
        if (!raw) {
          /* #100: a token-shaped tail no held key decodes is a
             stranded route (a rotation) or a corrupt/mis-minted token;
             the path alone cannot tell them apart, so the diag event
             names the honest cause: unknown. Tail length recorded -
             a truncation or a mis-appended literal shows up there. */
          if (looksKeyedToken(url.pathname)) {
            /* #290: the failed route alone cannot name the page that
               minted it, so a live miss (the /sorry bot-wall script
               class) was unattributable from one capture. Record the
               requesting page's virtual URL when the worker knows the
               client, alongside the opaque route; nothing is guessed. */
            const pageCtx = contextOf(VCTX, e.clientId);
            DIAG.emit({
              category: "REWRITE",
              severity: "warning",
              cause: "unknown",
              message: "keyed route decode failed (route key rotated?)",
              technicalReason:
                "tail " +
                url.pathname.slice(currentPrefix().length).split(/[?#]/)[0].length +
                " chars" +
                (pageCtx ? "; requesting page " + pageCtx.currentUrl : ""),
              url: url.href,
            });
          }
          return navOutcome(
            e,
            url,
            404,
            "route",
            looksKeyedToken(url.pathname)
              ? "zeolite: undecodable keyed route (route key rotated?)"
              : "zeolite: bad route",
          );
        }
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
          if (!refDest) {
            /* #113: a legacy route minted under a prefix this worker
               has not configured yet (a cold start, the boot config
               race) reaches this seam because decodePath knows only
               the configured prefix, and passing it through is a
               proxy-origin 404. Recover the tail here. */
            const legacy = decodeLegacyRoute(url.pathname);
            if (legacy) {
              const ltid = DIAG.trace();
              DIAG.emit({
                traceId: ltid,
                requestId: ltid,
                category: "REWRITE",
                severity: "info",
                stage: "REQUEST_INTERCEPTED",
                message: "legacy route recovered at the escape seam (route shape not configured yet)",
                url: legacy,
              });
              dest0 = unwrapDest(legacy);
              routeCarriesQuery = true;
            } else {
              /* #101: the silent passthrough. Neither the client's
                 virtual context nor the referrer names a home for this
                 same-origin path (an unrewritten embed page, a client
                 the context cap dropped, or a child realm the guard
                 never reached), so the browser serves it - on the
                 proxy origin that is a 404. Escape row, not a guess:
                 dest records what the browser will actually request. */
              netLogPush({
                method: e.request.method,
                traceId: DIAG.trace(),
                path: url.pathname + url.search,
                dest: e.request.url,
                status: 0,
                rtype: classifyRtype(reqDest(e.request), ""),
                ms: -1,
                bytes: -1,
                verdict: "escape: same-origin unknown home",
                transport: "browser",
                detail: { internalUrl: url.pathname + url.search, ttfb: -1 },
              });
              return fetch(e.request);
            }
          } else {
            dest0 = refDest;
          }
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
      // routes only (see routeCarriesQuery above). A token-encoded
      // query loses to the route search (browser "?x" semantics).
      let target = routeCarriesQuery && url.search ? mergeRouteSearch(bareDest, url.search) : bareDest;
      /* #53: the single upgrade choke point. Every destination
         shape (rewriter-emitted routes, navguard markers, escaped
         same-origin paths, foreign-origin requests) resolves here
         before cache or transport; mixed-content subresources and
         redirect targets pass the same seam on their own fetch. */
      /* LB #76 HTTPS-only: the error page proceed-anyway link reloads
         the route with zlHttpOk=1. That click exempts the destination
         host from the upgrade for this SW session (never persisted),
         and the marker is stripped so the upstream never sees it. */
      if (url.searchParams.get("zlHttpOk") === "1") {
        httpExemptAdd(target);
        if (routeCarriesQuery && url.search) {
          const q = new URLSearchParams(url.searchParams);
          q.delete("zlHttpOk");
          const qs = q.toString();
          target = qs ? mergeRouteSearch(bareDest, "?" + qs) : bareDest;
        }
      }
      target = destUpgraded(target);
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
        /* #258: the challenge page's virtual home. The frame's
           established context names the post-redirect final
           destination - the origin an unproxied page would have
           echoed into redir; the request's own route path backs
           the navh-handle fallback. */
        const homeCtx = contextOf(VCTX, e.clientId);
        const homeOrigin =
          homeCtx && /^https?:/i.test(homeCtx.targetOrigin) ? homeCtx.targetOrigin : null;
        const fixed = passChallengeRedirFixed(target, self.location.origin, homeOrigin, url.pathname);
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

      /* #112 follow-up: a proxied page can never read its real path
         (window.location.pathname IS the opaque engine route), so page
         JS that builds an absolute URL as <real origin> +
         location.pathname sends our route token upstream as the path
         and the origin answers 404 ("/j/<token> was not found on this
         server" is the live case). The engine holds the key that
         minted that token: dereference an embedded self-route at the
         fetch seam, before anything else shapes the destination. */
      const deref = derefSelfRoute(target, self.location.origin);
      if (deref !== target) {
        const dtid = DIAG.trace();
        DIAG.emit({
          traceId: dtid,
          requestId: dtid,
          category: "REWRITE",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "self-route token dereferenced (page JS built origin + location.pathname)",
          url: target,
        });
        target = deref;
      }

      /* #112: the Referer fix alone does not repair the reCAPTCHA
         widget: its JS builds co= from window.location.origin
         (LegacyUnforgeable), so upstream always receives the engine
         origin and the site-key domain check fails. Virtualize a
         co= that names this deployment at the seam the engine owns. */
      const coFixed = virtualRecaptchaCo(target, e.request.referrer, self.location.origin);
      if (coFixed !== target) {
        const ctid = DIAG.trace();
        DIAG.emit({
          traceId: ctid,
          requestId: ctid,
          category: "CHALLENGE",
          cause: "challenge",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "recaptcha co= virtualized to the page origin",
          url: target,
        });
        target = coFixed;
      }

      /* #129: challenge-widget frames stay engine-routed. The #120
         policy redirected these navigations provider-direct, which
         was an IP leak (the #32 class) AND left the widget
         cross-origin with the embedder, so the widget's postMessage
         back to the page was dropped by the browser and the
         challenge spun forever. #128 now delivers same-site frame
         messages with the intended virtual origin, so the frame
         stays on the engine: the user's IP never reaches the
         challenge host, and the co= virtualization above rides the
         engine-routed request so the site-key domain check still
         passes. Detection and human solving only - the challenge
         itself is never solved or bypassed; the diag row below is
         observability, not policy. */
      if (
        e.request.mode === "navigate" &&
        (e.request.destination === "iframe" || e.request.destination === "frame") &&
        isChallengeFrameUrl(target)
      ) {
        const rtid = DIAG.trace();
        DIAG.emit({
          traceId: rtid,
          requestId: rtid,
          category: "CHALLENGE",
          cause: "challenge",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "challenge widget frame engine-routed (#129)",
          url: target,
        });
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
        let decision = decideTransport(target, dest);
        /* webNavigation.onBeforeNavigate: navigation-mode requests
           report the interception itself, before any cache or upstream
           work. */
        if (e.request.mode === "navigate") WEBNAV.beforeNavigate(target);
        /* Shared webRequest details for every hook below. #288: the
           response-stage hooks (headersReceived/completed/errorOccurred)
           must describe the URL the response actually came from, not
           the pre-redirect target; lastHopUrl tracks the final hop for
           the error path outside the try. */
        const wrDetails = {
          requestId: traceId,
          url: target,
          method: e.request.method,
          type: wrType(dest),
          timeStamp: Date.now(),
        };
        let lastHopUrl = target;
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
        /* #135/#136: compatibility policy. A matching rule upgrades
           the default native decision onto the rewrite path; native
           is already the default and required rewrites cannot be
           demoted, so the upgrade is the only effect. */
        const policy = await loadPolicy();
        const policyRule = policyMatch(policy, target, rtype);
        if (policyRule && policyRule.route === "rewrite" && decision.mode === "NativeTransit") {
          decision = {
            mode: "RewriteFallback",
            reason: "POLICY_REWRITE",
            ruleId: policyRule.id,
          };
          traceDecision({
            subsystem: "policy",
            rule: policyRule.id,
            original: target,
            result: "rewrite",
            resource: rtype,
            traceId,
          });
        }
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
        if (ruleDec.url || ic.url) target = destUpgraded(ic.url ?? ruleDec.url ?? target);

        /* Cache-first for proxied GETs. #179: a credential-bearing
           request (Authorization or a jar cookie for the target)
           never serves from the shared page cache. */
        if (e.request.method === "GET" && !requestHasCredentials(e.request, target, cookieClientId)) {
          const hit = await pageCacheMatch(e.request, (p) => e.waitUntil(p));
          if (hit) {
            let dec = refineWithContent(decision, hit.headers.get("content-type") ?? "", dest);
            if (
              dec.mode === "RewriteFallback" &&
              dec.reason === "JS_LITERAL_REWRITE_REQUIRED" &&
              policyRule &&
              policyRule.route === "native" &&
              (dest === "script" || dest === "")
            ) {
              dec = { mode: "NativeTransit", reason: "POLICY_NATIVE", ruleId: policyRule.id };
            }
            transitRecord(traceId, target, dec);
            /* #95: a decision that leaves the native path is an
               explainable event on the always-on diag stream (the
               fallback ring + netLog row stay the per-request record;
               native is the default and stays row-only). */
            if (dec.mode === "RewriteFallback")
              DIAG.stage(traceId, "TRANSPORT_FALLBACK", { url: target, message: dec.reason + (dec.ruleId ? " (policy " + dec.ruleId + ")" : "") });
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
            if (hit.status !== 200) {
              /* #338: served without internal bookkeeping headers. */
              const kept = stripInternalHeaders(hit.headers);
              return hit.body
                ? new Response(hit.body, { status: hit.status, headers: kept })
                : new Response(null, { status: hit.status, headers: kept });
            }
            /* #158/#159 same honesty as the fresh path: a script or
               worker destination cached with an HTML or CSS body (the
               SPA catch-all class) serves the JS-typed comment, never
               the document rewrite a script destination cannot use. */
            const hitCt = hit.headers.get("content-type") ?? "";
            if (needsScriptBodyMask(dest, e.request.destination, hitCt)) {
              recordMaskedScript(target, e.request.referrer, target);
              return maskedScriptResponse(hit.status, hitCt);
            }
            /* Legacy entries predate the content-encoding strip and
               carry a stale upstream encoding over a decoded body:
               fetch() consumers would decode plaintext a second time.
               The served view is always identity. */
            const hitHeaders = stripInternalHeaders(hit.headers);
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
              const csInject = csInjectUrls(target, e.request, e.request.referrer);
              const hitCt = hit.headers.get("content-type") ?? "text/html";
              /* Issue B: the served copy is re-encoded UTF-8. */
              hitHeaders.set("content-type", utf8ContentType(hitCt));
              return new Response(
                rewriteStream(hit.body, cacheRewriteBase(hit, target), chRule, csInject, hitCt, () => {
                  if (e.request.mode === "navigate") WEBNAV.completed(target);
                }),
                { status: hit.status, headers: hitHeaders },
              );
            }
            if (isCss(hit) && hit.body) {
              const hitCt = hit.headers.get("content-type") ?? "text/css";
              hitHeaders.set("content-type", utf8ContentType(hitCt));
              return new Response(cssRewriteStream(hit.body, cacheRewriteBase(hit, target), hitCt), {
                status: hit.status,
                headers: hitHeaders,
              });
            }
            /* #134: a cached JS body must serve through the same
               specifier + literal passes a fresh response takes. Entries
               stored by older dists (before the JS transform covered
               script destinations) hold raw upstream bodies: a
               module-relative import() in such a copy resolved against
               the engine route, and the escaped-path recovery answered
               the wrong destination (play2048's lazy chunk, github.com's
               CSS chunk). Both passes are idempotent on composed copies
               - engine routes pass through untouched - so an
               already-transformed entry only pays the scan. The repaired
               copy is written back only when a pass changed the body: a
               stale raw entry heals once instead of rescanning on every
               hit. Worker destinations keep the raw serve: their cached
               copies are composed (prelude + folded specifiers) by the
               fresh path, and re-running a text pass over prepended
               engine code is not idempotent by construction. */
            if (
              isJs(hit) &&
              (e.request.destination === "script" || e.request.destination === "") &&
              hit.body
            ) {
              const jsCt = hit.headers.get("content-type") ?? "";
              const raw0 = decodeBody(await hit.arrayBuffer(), jsCt);
              let src = rewriteModuleWorkerImports(
                currentPrefix(),
                cacheRewriteBase(hit, target),
                self.location.origin,
                raw0,
              );
              try {
                src = await rewriteJsBody(src, cacheRewriteBase(hit, target));
              } catch (err) {
                /* A wasm load failure must not break the hit: the
                   specifier output still serves (the fresh path's
                   rule). */
                DIAG.emit({
                  category: "REWRITE",
                  severity: "error",
                  message: "cache-hit script body pass failed",
                  technicalReason: String(err),
                  url: target,
                });
              }
              hitHeaders.set("content-type", utf8ContentType(jsCt));
              const out = new Response(src, { status: hit.status, headers: hitHeaders });
              if (src !== raw0) void pageCacheStore(e.request, out.clone(), false, undefined, cookieClientId);
              return out;
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
          /* #194: headers minted by rules, interception or plugins are
             scoped to the target they were computed for; a
             cross-origin redirect hop drops them (see
             stripCrossOriginHopHeaders below). */
          const prePlugin = new Set(sendHeaders.keys());
          await applyOnRequest(plugins, target, sendHeaders);
          const injectedKeys = new Set(Object.keys(extraHeaders));
          for (const k of sendHeaders.keys()) if (!prePlugin.has(k)) injectedKeys.add(k);
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
              sendHeaders.set("accept-language", acceptLanguageValue(sp.p.languages));
            }
          }
          /* Sec-CH-UA hints must match the FINAL user-agent (profile,
             zl:rules or site profile); applyChUa deletes first, so a
             non-Chromium final UA carries no stale hints. */
          applyChUa(sendHeaders, sendHeaders.get("user-agent") ?? "");
          /* 2.2 Arsenide: initiator context for the opt-in SameSite
             policy. Issue #33: the initiator comes from the client's own
             virtual context first (a SW-assigned key, not a page-supplied
             string); the referrer decode is the compat fallback.
             Navigations are top-level for lax purposes. */
          const initCtx = contextOf(VCTX, e.clientId);
          const reqCtx: CookieRequestContext = {
            /* #267: the jar profile follows the requesting client. */
            clientId: cookieClientId,
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
          /* Issue #276: Request.credentials governs the virtual jar.
             omit sends and stores nothing; include is unconditional;
             same-origin admits only when the jar target shares origin
             with the initiator (engine-initiated requests have no
             initiator and stay admitted). */
          const creds = e.request.credentials;
          const credsEligible = (destUrl: string): boolean => {
            if (creds === "include") return true;
            if (creds === "omit") return false;
            if (!reqCtx.initiator) return true;
            try {
              return new URL(destUrl).origin === new URL(reqCtx.initiator).origin;
            } catch {
              return true;
            }
          };
          /* 1.4 Boride: the jar is the authoritative Cookie source for
             engine-initiated requests, written last so rules and
             interception cannot smuggle another origin's cookies. */
          const jarCookie = credsEligible(target) ? cookieHeaderFor(target, reqCtx) : "";
          if (jarCookie) sendHeaders.set("cookie", jarCookie);
          else sendHeaders.delete("cookie");
          /* 2.2 Arsenide: the transport fetch adapter ignores the redirect
             option and surfaces 3xx responses, so hops followed inside
             the transport never reached the jar and dropped their
             Set-Cookie. The SW now follows the hop chain itself and
             captures Set-Cookie on every hop. 303 (and POST on 301/302)
             continues as GET per the fetch spec; 307/308 replay the
             method AND the body, which replayableInit buffers once
             (cap 32 MiB); a cross-origin hop drops Authorization
             per spec. Only an announced body over the cap streams one-shot and surfaces with a mapped Location. */
          let hopUrl = target;
          let hopMethod = e.request.method;
          let hopBody: BodyInit | undefined | null = ["GET", "HEAD"].includes(e.request.method)
            ? undefined
            : e.request.body;
          /* 2026-10-14 report: buffer a stream body ONCE before the hop
             loop so 307/308 (and every other body-carrying hop) can
             replay it; the only one-shot case left is an announced
             Content-Length over the cap, which replayableInit streams
             untouched and the loop surfaces per spec. */
          if (hopBody != null) {
            hopBody =
              (
                await replayableInit(
                  { method: hopMethod, headers: sendHeaders, body: hopBody, signal: e.request.signal },
                  { hopReplay: true },
                )
              ).body ?? null;
          }
          /* The navigation TTFB deadline must abort the upstream fetch,
             not only reject this promise: the request otherwise runs
             on past the user-visible failure holding a transport
             stream (2026-10-14 report). Non-navigations keep the
             request signal as-is. */
          const navAbort = reqCtx.navigation ? new AbortController() : null;
          const reqSignal = e.request.signal;
          if (navAbort && reqSignal) {
            if (reqSignal.aborted) navAbort.abort(reqSignal.reason);
            else reqSignal.addEventListener("abort", () => navAbort!.abort(reqSignal!.reason), { once: true });
          }
          const hopSignal = navAbort ? navAbort.signal : reqSignal;
          let resp = await withDeadline(
            upstreamFetch(hopUrl, { method: hopMethod, headers: sendHeaders, body: hopBody, signal: hopSignal }, policy, rtype, traceId),
            reqCtx.navigation ? NAV_TTFB_DEADLINE_MS : 0,
            "navigation upstream timeout: no first byte within " + NAV_TTFB_DEADLINE_MS + "ms",
            navAbort ?? undefined,
          );
          for (let hops = 0; resp.status >= 300 && resp.status < 400 && hops < MAX_REDIRECT_HOPS; hops++) {
            /* Capture this hop's Set-Cookie against the URL it came from.
               #35: any admission also pushes the jar view to the
               requesting client's docCookie port (see the main capture
               below). */
            const hopAdmitted = credsEligible(hopUrl) ? applySetCookie(hopUrl, jarHeaders(resp), cookieClientId) : [];
            if (hopAdmitted.some((r) => r.stored || r.deleted)) {
              void pushDocCookieView(e.clientId);
              /* #254: keep the jar write alive past this fetch event. */
              e.waitUntil(flushJarPersist());
            }
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
            next = destUpgraded(next);
            /* Fetch spec: 307/308 replay the body but a cross-origin
               hop drops Authorization - the credential is never
               forwarded to a second origin. #194: the Referer and the
               headers injected for the previous host do not follow
               the request to a second origin either. */
            if (new URL(next).origin !== new URL(hopUrl).origin) {
              sendHeaders.delete("authorization");
              stripCrossOriginHopHeaders(sendHeaders, injectedKeys);
            }
            const stillStream = hopBody != null && typeof (hopBody as ReadableStream).getReader === "function";
            if (resp.status === 307 || resp.status === 308) {
              if (stillStream) break; /* announced over the cap: one-shot stream */
            } else if (resp.status === 303 || hopMethod === "POST") {
              /* The method rewrite drops the body, and the direct
                 browser oracle drops its content-type with it (the
                 #92 redirect check pins this against the direct
                 model): the re-issued GET carries no content-type. */
              hopMethod = "GET";
              hopBody = undefined;
              sendHeaders.delete("content-type");
            } else if (stillStream) {
              break; /* announced over the cap: one-shot stream */
            }
            /* The jar is per-origin: cookies for the hop target, not the
               original one. */
            const hopCookie = credsEligible(next) ? cookieHeaderFor(next, reqCtx) : "";
            if (hopCookie) sendHeaders.set("cookie", hopCookie);
            else sendHeaders.delete("cookie");
            DIAG.stage(traceId, "REDIRECT_HOP", { url: hopUrl, message: "hop -> " + next });
            hopUrl = next;
            lastHopUrl = next;
            /* #201: the hop's body is never read; cancel it so the
               upstream reader and the vendored transport stop
               buffering a response nobody will consume. */
            if (resp.body) void Promise.resolve(resp.body.cancel()).catch(() => {});
            /* #186: the gates that admitted the original target run
               for every hop too - the engine-side chain must not
               smuggle a rules-blocked, webRequest-cancelled,
               intercepted or disabled host past the checks the first
               URL already passed. */
            const hopRule = applyRules(engineRules, hopUrl, rtype);
            /* The reason names the gate that fired (netLog carries it). */
            let hopBlockReason: "BLOCKED_RULES" | "BLOCKED_INTERCEPT" | "BLOCKED_WEBREQUEST" | null = null;
            if (siteDisabled(hopUrl)) hopBlockReason = "BLOCKED_RULES";
            else if (hopRule.action === "block") hopBlockReason = "BLOCKED_RULES";
            else if (WEBREQ.beforeRequest({ ...wrDetails, url: hopUrl })) hopBlockReason = "BLOCKED_WEBREQUEST";
            else if (runRequestInterception(kinds, { url: hopRule.url ?? hopUrl, method: hopMethod, rtype, headers: flatReq }).block) hopBlockReason = "BLOCKED_INTERCEPT";
            if (hopBlockReason) {
              DIAG.emit({
                category: "BLOCKED",
                cause: "blocked",
                severity: "info",
                stage: "REDIRECT_HOP",
                message: "redirect hop blocked by request gates",
                url: hopUrl,
                traceId,
                requestId: traceId,
              });
              const hopDecision: TransitDecision = { mode: "Blocked", reason: hopBlockReason };
              netLogPush({
                method: e.request.method,
                traceId,
                path: internalUrl,
                dest: hopUrl,
                status: 403,
                rtype,
                ms: Date.now() - t0,
                bytes: -1,
                verdict: "blocked",
                transport: hopDecision.mode,
                fallbackReason: reasonOf(hopDecision),
                detail: mkDetail(),
              });
              return navOutcome(e, url, 403, "blocked", "zeolite: redirect hop blocked");
            }
            /* #186: per-host rule headers apply to the hop target and
               carry its host scope into any further hop. */
            if (hopRule.headers) {
              for (const [k, v] of Object.entries(hopRule.headers)) {
                sendHeaders.set(k, v);
                injectedKeys.add(k);
              }
            }
            resp = await withDeadline(
              upstreamFetch(hopUrl, { method: hopMethod, headers: sendHeaders, body: hopBody, signal: hopSignal }, policy, rtype, traceId),
              reqCtx.navigation ? NAV_TTFB_DEADLINE_MS : 0,
              "navigation upstream timeout: no first byte within " + NAV_TTFB_DEADLINE_MS + "ms",
              navAbort ?? undefined,
            );
          }
          /* #140/#200: every response settles - an idle-stalled upstream
             body errors instead of pending forever. The TTFB deadline
             covers headers only, so a navigation that stalls after its
             first body byte gets the same IDLE bound: a document that
             keeps sending bytes stays alive, one that stalls errors
             into the honest failure path. */
          resp = withBodyStallDeadline(resp, BODY_STALL_DEADLINE_MS, traceId, target);
          curStage = "UPSTREAM_RESPONSE";
          /* #134: runtime-built module asset names (React chunks mint
             <hash>.module.css at runtime) resolve against the page
             origin and 404 there; the real assets sit on CDN bases
             the page itself already loaded script/style from. Record
             those bases on successful cross-origin script/style loads,
             then retry a failed flat-named asset (script, style, or a runtime-built binary) against them. */
          if (resp.status === 200 && (dest === "script" || dest === "style") && initiator)
            recordAssetBase(initiator, target);
          /* #296: flag-surgery chunk paths (/httpd=1/exm=.../cb=.../m=...) come
             from page JS mangling its own opaque script token; record the full
             real URL of every successfully served JS script load (same-origin
             included) so the miss can be retried against those bases. */
          if (
            resp.status === 200 &&
            dest === "script" &&
            initiator &&
            /javascript|ecmascript/i.test(resp.headers.get("content-type") ?? "")
          )
            recordScriptUrl(initiator, hopUrl !== target ? hopUrl : target);
          if (resp.status >= 400 && isRecoverableAssetDest(dest)) {
            /* #296 first: a flag-shaped script miss is the src-surgery class,
             whose recovery owns the flag path shape; the flat-asset gate would
             reject it and log a miss without ever trying the script bases. */
            let rec = dest === "script" ? await recoverFlagSurgeryScript(initiator ?? "", target, e.request.headers, (u2, init2) => wispTransport.fetch(u2, init2, traceId)) : null;
            if (rec) {
              DIAG.emit({
                traceId,
                requestId: traceId,
                category: "REWRITE",
                severity: "info",
                stage: "UPSTREAM_RESPONSE",
                message: "flag-surgery script path recovered against an observed script base (#296)",
                url: target,
              });
            } else {
              rec = await recoverFlatAsset(initiator ?? "", target, dest, e.request.headers, (u2, init2) =>
                wispTransport.fetch(u2, init2, traceId));
            }
            if (rec) {
              DIAG.emit({
                traceId,
                requestId: traceId,
                category: "REWRITE",
                severity: "info",
                stage: "UPSTREAM_RESPONSE",
                message: "module asset recovered against an observed base (#134/#296)",
                url: target,
              });
              hopUrl = rec.url;
              resp = rec.resp;
            } else if (assetBaseCount(initiator ?? "") > 0) {
              /* #143: the miss is now visible in diagnostics either way -
                 all observed bases answered badly, or the path shape
                 was rejected - so a silent no-retry never hides a
                 recoverable asset again. */
              let shapeOk = false;
              try {
                shapeOk = isRecoverableAssetPath(new URL(target).pathname);
              } catch {
                shapeOk = false;
              }
              DIAG.emit({
                traceId,
                requestId: traceId,
                category: "REWRITE",
                severity: "warning",
                stage: "UPSTREAM_RESPONSE",
                message:
                  "flat asset recovery miss: " +
                  (shapeOk
                    ? "every observed base answered badly"
                    : "path shape rejected by the gate") +
                  " (" +
                  assetBaseCount(initiator ?? "") +
                  " bases recorded)",
                url: target,
              });
            }
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
            JS_TRANSFORM_DESTS.has(e.request.destination) && isJs(resp) && !!resp.body && !policyNativeJs;
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
          if ((isHtml(resp) || (respCt === "" && DOC_DESTS.has(dest) && resp.body)) && resp.body) {
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
          if (JS_TRANSFORM_DESTS.has(e.request.destination) && isJs(resp) && resp.body && !policyNativeJs) {
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
    })(),
  );
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
      let base = tokenBase ?? pageBase(contextUrl);
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
    decoded referrer's origin; the destination's own origin as the
    no-referrer fallback). Rendering fidelity only: the challenge
    itself is never solved or bypassed. */
export function virtualRecaptchaCo(target: string, referrer: string, engineOrigin: string): string {
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
  const parent = referrerOrigin(referrer);
  const home = parent ?? u.origin;
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
function referrerOrigin(referrer: string): string | null {
  if (!referrer) return null;
  try {
    const refU = new URL(referrer, "https://zl.invalid/");
    let ref = decodePath(refU.pathname);
    if (!ref && refU.pathname.startsWith(NAVH + "/"))
      ref = decodeNavHandlePath(refU.pathname.slice(NAVH.length + 1));
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
    /* #113: legacy /zl/ routes from cold starts or pre-#113 dists
       also fail decodePath when the prefix is not configured yet.
       decodeLegacyRoute recovers them at the escape seam. */
    if (!ref) {
      ref = decodeLegacyRoute(refU.pathname);
    }
    if (ref) out.set("referer", mergeRouteSearch(ref, refU.search));
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
  if (profile) {
    out.set("user-agent", profile.userAgent);
    out.set("accept-language", acceptLanguageValue(profile.languages));
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


