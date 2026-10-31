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

import { decodeBody, mapLocationHeader, mapRefreshHeader, stripHostile, utf8ContentType } from "./headers";
import { parseKdl } from "./kdl";
import { applyExperimentalCsp } from "./csp-translation";
import { experimentalEnabled } from "./experimental-flags";
import { loadRouteHistory, saveRouteKey } from "./routekey";
import { classifyForeign, preflightHeaders } from "./foreign";
import { NAV, NAVP } from "./bootstrap/navguard";

import { planRange, ZL_RANGE_MAX } from "./range";
import { applyEngineCors } from "./cors";
import { classifyFailure, errorPage, type ErrorCategory } from "./errorpage";
import { rewriteModuleWorkerImports } from "./worker-imports";
import { decideTransport, isCdnCgiUrl, planJsServeOutcome, planResponseTransit, reasonOf, sniffsAsHtml, transitRecord, relayRecord, wispRecord, DOC_DESTS, JS_TRANSFORM_DESTS, type TransitDecision } from "./transit";
import { loadPolicy, behaviorMatch, transportMatch, type CompiledPolicy } from "./policy";
import { relayAvailable, relayFetch, requestRelayReRegister } from "./relayfetch";
import { cssRewriteStream, isCss, isHtml, isJs, rawFrom, rewriteJsBody, rewriteStream, scriptPinsOrigins, workerPrelude } from "./transform";
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
import { flatRed, netLogAnnotateRewrite, netLogPush, type NetDetail } from "./netlog";
import { traceDecision } from "./tracing";
import { siteToken } from "./pageload";
import { GUEST_FETCH_BODY_MAX, guestDispatchFetchForUrl, guestWireFetch } from "./kernel/guests/executor";

import { altConfigured, altEndpoint, altRegister, altWispFetch, canReplayAfterFailure, wispTransport } from "./transport";
import { normalizeWispUrl, primaryWispOverrideValue, setPrimaryWispOverride } from "./config";
import { raceBoot } from "./lifecycle";



import {PROXY_INJECTED_HEADERS, acceptLanguageValue, applyChUa, navigationAccept, secFetchHeaders, virtualOriginHeaders, virtualRefererFallback} from "./origin";
import {
  capContexts,
  contextOf,
  establishContext,
  establishFromClientUrl,
  resolveRelative,
  VCTX_CAP,
  type VirtualContext,
} from "./vctx";
import { assetBaseCount, isRecoverableAssetDest, isRecoverableAssetPath, recordAssetBase, recoverFlatAsset, recordScriptUrl, recoverFlagSurgeryScript, type FlatFetch } from "./assetbases";
import { anySessionProfileActive, applySetCookie, cookieHeaderFor, flushJarPersist, inheritJarClient, isPassChallenge, jarClientHasRoot, jarHeaders, jarProfilesReady, jarProfileState, markJarClientUnbound, pruneJarClients, type CookieRequestContext } from "./cookies";
/* #87: the shared service-worker runtime state (per-client virtual
   contexts, route-shape toggles, route key, fingerprint profile +
   per-site profile cache) lives in ./swstate; the engine and the
   control plane are call sites. */
import { destUpgraded, getFpProfile, getFpWorkerScript, httpExemptAdd, httpExemptHas, isHttpsUpgrade, navHandlesEnabled, adaptiveTransitEnabled, pushDocCookieView, queryRoutesEnabled, reloadBypassArmed, setHttpsUpgrade, setNavHandles, setReloadBypass, setRouteKey, siteDisabled, replayBodyCapBytes, siteProfileFor, spoolUploadsEnabled, VCTX, ZEOLITE_VERSION } from "./swstate";
import { literalPassDemotion, noteDemotionServed, recordBodyPassFailure, recordJsServeOutcome } from "./adaptive-evidence";
import { spoolBody, SpoolHandle, SpoolUnavailableError } from "./bodyspool";

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
/* #557: the stored Vary field list plus the request header values the
   entry was selected with; a lookup with different values is a miss. */
const ZL_VARY = "x-zl-vary";
const ZL_VARY_VALUES = "x-zl-vary-values";
/* #338: internal bookkeeping headers never reach the page. They stay
   on the stored entry (TTL checks and final-URL recovery read them)
   and are stripped from every served copy. */
function stripInternalHeaders(h: Headers): Headers {
  const out = new Headers(h);
  out.delete(ZL_CACHED_AT);
  out.delete(ZL_FINAL_URL);
  out.delete(ZL_VARY);
  out.delete(ZL_VARY_VALUES);
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
/** #557: normalized (lowercase, trimmed) Vary field names; an empty
    Vary header yields []. */
export function varyFields(headers: Headers): string[] {
  return (headers.get("vary") ?? "")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f !== "");
}

/** #557: snapshot the varying request header values onto the stored
    entry. A header absent from the selecting request stores as null so
    absent-vs-present stays a value change (RFC 9111: a header absent
    from the stored request only matches a request where it is also
    absent). */
export function storeVaryMeta(h: Headers, fields: string[], reqHeaders: Headers): void {
  if (!fields.length) return;
  h.set(ZL_VARY, fields.join(","));
  h.set(ZL_VARY_VALUES, JSON.stringify(fields.map((f) => reqHeaders.get(f))));
}

/** #557: true when the request carries the same values the entry was
    selected with. Missing or unparseable metadata fails closed to a
    miss, never a broader hit. */
export function varyMatches(hit: Headers, reqHeaders: Headers): boolean {
  const raw = hit.get(ZL_VARY);
  if (!raw) return true;
  const fields = raw.split(",").map((f) => f.trim().toLowerCase()).filter(Boolean);
  let values: unknown;
  try {
    values = JSON.parse(hit.get(ZL_VARY_VALUES) ?? "");
  } catch {
    return false;
  }
  if (!Array.isArray(values) || values.length !== fields.length) return false;
  return fields.every((f, i) => reqHeaders.get(f) === values[i]);
}

export function cacheStorable(headers: Headers): boolean {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  /* #179: private responses never enter the shared page cache (it
     spans jar profiles and sessions). */
  if (/\bno-store\b/.test(cc)) return false;
  if (/\bprivate\b/.test(cc)) return false;
  /* #557: Vary is honored through stored variant metadata (the field
     list plus the selecting request's values ride the entry and are
     compared on lookup), so supported variants are cacheable; only
     "*" (varying on fields the entry cannot represent) stays
     uncacheable. Credential isolation is unchanged (#179):
     credentialed requests bypass the cache in both directions, so a
     Cookie-varying entry only ever serves requests that also carry
     no credentials. */
  if (varyFields(headers).includes("*")) return false;
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
  context: CookieRequestContext = {},
): Promise<Response | null> {
  let hit: Response | undefined;
  try {
    hit = await (await caches.open(ZL_PAGES)).match(req);
  } catch {
    return null;
  }
  if (!hit) return null;
  /* #557: a Vary entry serves only the request header values it was
     stored with; anything else is an honest miss that bypasses to the
     live path. */
  if (!varyMatches(hit.headers, req.headers)) return null;
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
    return await revalidateBeforeUse(req, hit, context);
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
    const refreshKey = JSON.stringify([req.url, context.clientId ?? "", req.credentials, context.initiator ?? ""]);
    let refresh = staleRefreshInFlight.get(refreshKey);
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
            const { resp: fresh, finalUrl: freshUrl } = await cacheRefreshFetch(
              req,
              {
                etag: hit.headers.get("etag"),
                lastModified: hit.headers.get("last-modified"),
              },
              hit.headers.get(ZL_FINAL_URL) ?? undefined,
              context,
            );
            if (fresh.status === 304) {
              await bumpStoredEntry(req, fresh);
            } else if (fresh.ok) {
              await pageCacheStore(req, fresh, false, freshUrl, context.clientId);
            }
          }
        } catch {
          /* offline: the stale copy stays served */
        }
      })();
      staleRefreshInFlight.set(refreshKey, refresh);
      /* the IIFE never rejects: its whole body is one try/catch. */
      void refresh.then(() => staleRefreshInFlight.delete(refreshKey));
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
      if (!ifRangeAccepts(ifRange, etag, lm)) return null;
    }
    return await rangeFromEntry(hit, rangeHeader);
  }
  return hit;
}

/** #468: If-Range is a STRONG comparison (RFC 9110 13.1.5) - a weak
    request tag or a weak stored validator never gates a slice; the
    origin owns the range semantics. */
export function ifRangeAccepts(
  ifRange: string,
  etag: string | null,
  lm: string | null,
): boolean {
  const weakReq = ifRange.startsWith("W/");
  const weakStored = !!etag && etag.startsWith("W/");
  return (
    (!!etag && !weakReq && !weakStored && ifRange === etag) ||
    (!!lm && ifRange === lm)
  );
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
    /* #469: the empty 416 must not advertise the stored length. */
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
/* #548: set when eviction fails: storing is refused until the worker
   restarts, so a storage refusal cannot grow the cache past the page
   limit (module state doubles as the restart recovery point). */
let pageCacheDisabled = false;

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
  /* #548: once eviction has failed, new entries are refused: the
     entry bound stays hard instead of growing past the stuck count. */
  if (pageCacheDisabled) return null;
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
    /* #557: the Vary list and the selecting request's values ride the
       entry; the lookup compares them (varyMatches). */
    storeVaryMeta(storedHeaders, varyFields(resp.headers), req.headers);
    /* #548: make room BEFORE admitting the new entry so the page limit
       is a hard bound: a failed eviction refuses this store (the page
       still gets its response) instead of admitting an entry that can
       never be trimmed. Each pass deletes the oldest entry and
       re-lists the keys (the old snapshot loop walked past failures
       and kept admitting entries). One failed eviction disables
       storing for the rest of this worker lifetime; the next worker
       start retries with a clean slate. */
    for (;;) {
      const keys = await cache.keys();
      if (keys.length < ZL_PAGE_LIMIT) break;
      let gone = false;
      try {
        gone = await cache.delete(keys[0]);
      } catch {
        gone = false;
      }
      if (!gone) {
        pageCacheDisabled = true;
        if (!pageCacheTrimWarned) {
          pageCacheTrimWarned = true;
          DIAG.emit({
            category: "STORAGE",
            severity: "warning",
            message: "page cache eviction failed; storing disabled until the worker restarts so the page limit stays a hard bound",
          });
        }
        return null;
      }
    }
    const stored = new Response(resp.body, { status: 200, headers: storedHeaders });
    stored.headers.set(ZL_CACHED_AT, String(Date.now()));
    /* #184: the final URL after redirect hops rides the entry so a
       cache hit rewrites against the base the document was actually
       served from. */
    if (finalUrl) stored.headers.set(ZL_FINAL_URL, finalUrl);
    await cache.put(req, keepView ? stored.clone() : stored);
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
/* #556: the cap lives in swstate (zl:config replayCapMb, 1-32,
   default 32) so a memory-constrained embedder can tighten it and
   the e2e suite can exercise the over-cap paths at transport-safe
   sizes. Chromium never exposes Content-Length on an intercepted
   request, so the real page traffic reaches the unannounced branch
   and discovers the cap mid-read. */
const replayBodyCap = (): number => replayBodyCapBytes();

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
  opts: { relayPossible?: boolean; hopReplay?: boolean; spoolAuthorized?: boolean } = {},
): Promise<{ method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal; spool?: SpoolHandle }> {
  const body = init.body;
  if (body == null || typeof (body as ReadableStream).getReader !== "function") return init;
  /* #556: only the hop path spools. The relay carries string and
     ArrayBuffer bodies only, so a spooled File would gain nothing
     there; the hop chain replays a File on every hop. */
  const spoolEligible = opts.hopReplay === true && opts.spoolAuthorized === true;
  const trySpool = async (): Promise<SpoolHandle | null> => {
    if (!spoolEligible) return null;
    try {
      return await spoolBody(body as ReadableStream<Uint8Array>);
    } catch (err) {
      if (err instanceof SpoolUnavailableError) {
        /* Storage never opened: the stream is intact and the
           documented one-shot behavior keeps the request honest. */
        DIAG.emit({
          category: "TRANSPORT",
          severity: "warning",
          message: "replay spool unavailable; keeping the documented one-shot streaming for this body",
        });
        return null;
      }
      /* Mid-spool failure: part of the stream is consumed, so the
         body can never leave intact - fail the request honestly
         instead of serving a truncated upload. */
      throw err;
    }
  };
  const clRaw = init.headers?.get("content-length") ?? "";
  if (/^\d+$/.test(clRaw)) {
    if (Number(clRaw) > replayBodyCap()) {
      /* #556: the hop chain replays an over-cap streamed body through
         the host-authorized OPFS spool instead of surfacing the
         redirect to the page. */
      const spool = await trySpool();
      if (spool) {
        /* The announced length is replaced by the spooled truth,
           never the page's claim: the File carries what actually
           arrived. */
        init.headers.set("content-length", String(spool.bytes));
        return { ...init, body: spool.file, spool };
      }
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
  } else {
    /* #556: an unannounced body with a live replay path spools when
       the host authorized it: even a chunked upload becomes
       replayable without a memory copy, and the spool cap (not the
       32 MiB memory cap) bounds it. */
    const spool = await trySpool();
    if (spool) return { ...init, body: spool.file, spool };
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > replayBodyCap()) {
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

/* #556: measured transport ceiling for one request body. The vendored
   artifact full-buffers every body into the wasm heap before the socket
   sees it; 16 MiB bodies kill the renderer process deterministically,
   8 MiB ride fine. The spool copy path honors the ceiling with an
   honest failure instead of a crash. */
const TRANSPORT_BODY_BOUND = 8 * 1024 * 1024;

/** Materialize the spooled replay source as the one transport-proven
    body shape (an ArrayBuffer). Throws before any bytes leave when
    the spooled body exceeds the measured transport ceiling, so the
    caller serves the honest error strand instead of a renderer
    crash. Exported for the replay-body regression tests. */
export async function spoolTransportCopy(spool: SpoolHandle): Promise<ArrayBuffer> {
  if (spool.bytes > TRANSPORT_BODY_BOUND) {
    replayCapTripCount++;
    DIAG.emit({
      category: "TRANSPORT",
      severity: "warning",
      message: "spooled body over the transport body bound; serving the honest error strand",
    });
    throw new Error(
      "zeolite: spooled body exceeds the transport body bound; streaming uploads need transport streaming support",
    );
  }
  return await spool.file.arrayBuffer();
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
        const wr = await altWispFetch(dest, init, traceId);
        traceDecision({ subsystem: "policy", rule: rule.id, original: dest, result: "wisp", resource: rtype, traceId });
        wispRecord();
        return wr;
      } catch (err) {
        /* #444: a failed alternate transport may already have delivered
           the write. An outer fallback must honor the same replay gate
           as the transport's own retry, including one-shot bodies and
           cancellation. Only engine-owned pre-dispatch evidence permits a
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

/** #538: the guest network bridge. A guest realm's fetch() travels its
    port to the guest kernel, which validates it fail-closed and hands
    it here. The request rides upstreamFetch, so SSRF, policy rules,
    the transport decision (relay/wisp/native, never a raw lambda) and
    diagnostics all apply exactly as for engine subresources. Cookies:
    the guest realm is not a controlled client, so the default-profile
    jar applies (clientless), guest-supplied Cookie and Host headers
    were already dropped kernel-side like forbidden header names, and
    response cookies store into the jar here, never onto the engine
    origin. The bridge never touches handleFetch, so a guest answer
    can never originate a guest dispatch: recursion stays impossible
    by construction. */
guestWireFetch(async (r) => {
  const traceId = DIAG.trace();
  const headers = new Headers(r.headers);
  const jarCookie = cookieHeaderFor(r.url);
  if (jarCookie && !headers.has("cookie")) headers.set("cookie", jarCookie);
  const policy = await loadPolicy();
  const resp = await upstreamFetch(
    r.url,
    { method: r.method, headers, body: r.body ?? undefined },
    policy,
    "fetch",
    traceId,
  );
  /* Response cookies belong to the jar, exactly as any engine fetch. */
  const jh = jarHeaders(resp);
  const gsc = (jh as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof gsc === "function" ? gsc.call(jh) : [];
  for (const c of setCookies) applySetCookie(r.url, new Headers([["set-cookie", c]]));
  const outHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    if (k !== "set-cookie" && k !== "set-cookie2") outHeaders[k] = v;
  });
  const bodyless = r.method === "HEAD" || resp.status === 204 || resp.status === 205 || resp.status === 304;
  const body = bodyless ? null : await guestBridgeBody(resp);
  DIAG.emit({
    traceId,
    requestId: traceId,
    category: "TRANSPORT",
    cause: "proxy",
    severity: "info",
    stage: "UPSTREAM_REQUEST",
    message: "guest fetch served through the engine pipeline (#538)",
    url: r.url,
  });
  return { status: resp.status, statusText: resp.statusText, headers: outHeaders, body };
});

/** #538: bounded body read for the guest bridge. A response whose
    content-length already exceeds the cap, or whose stream crosses it,
    fails the guest fetch closed instead of buffering without end. */
async function guestBridgeBody(resp: Response): Promise<string> {
  const cl = resp.headers.get("content-length");
  if (cl && Number(cl) > GUEST_FETCH_BODY_MAX) {
    throw new Error("guest bridge response above the size cap");
  }
  if (!resp.body) return await resp.text();
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > GUEST_FETCH_BODY_MAX) {
      void reader.cancel().catch(() => {});
      throw new Error("guest bridge response above the size cap");
    }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/** #179: the page cache spans jar profiles and sessions; clearing it
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

async function cacheRefreshFetch(
  req: Request,
  validators?: { etag?: string | null; lastModified?: string | null },
  destOverride?: string,
  context: CookieRequestContext = {},
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
  const policy = await loadPolicy();
  const traceId = DIAG.trace(context.clientId);
  const rtype = classifyRtype(reqDest(req), "").toLowerCase() as ResourceType;
  const eligible = (target: string) => {
    if (req.credentials === "omit") return false;
    if (req.credentials === "include" || !context.initiator) return true;
    try { return new URL(target).origin === new URL(context.initiator).origin; }
    catch { return false; }
  };
  /* ponytail: five hops, the same practical ceiling as the live hop
     chain; the honest 3xx surfaces beyond it. */
  for (let hop = 0; ; hop++) {
    const headers = new Headers();
    /* 1.4 Boride: cache refreshes carry the jar's Cookie header too. */
    const jarCookie = eligible(dest) ? cookieHeaderFor(dest, context) : null;
    if (jarCookie) headers.set("cookie", jarCookie);
    /* #115: send the stored validators so the origin can answer 304
       (they belong to the original destination only). */
    if (hop === 0) {
      if (validators?.etag) headers.set("if-none-match", validators.etag);
      if (validators?.lastModified) headers.set("if-modified-since", validators.lastModified);
    }
    const resp = await upstreamFetch(dest, { method: "GET", headers, signal: req.signal }, policy, rtype, traceId);
    if (eligible(dest)) {
      const admitted = applySetCookie(dest, jarHeaders(resp), context.clientId);
      if (admitted.some(r => r.stored || r.deleted)) {
        void pushDocCookieView(context.clientId ?? "");
        await flushJarPersist();
      }
    }
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
    serves the surgered fresh view (cookies are admitted on each refresh
    hop against the requesting profile), and
    anything else (transport failure included) returns null so the
    request bypasses to the live path and gets an honest result.
    ponytail: no coalescing here - concurrent no-cache hits each pay
    their own conditional fetch; a shared in-flight probe keyed by URL
    is the upgrade path if a hot no-cache resource measurably hurts. */
async function revalidateBeforeUse(req: Request, hit: Response, context: CookieRequestContext): Promise<Response | null> {
  try {
    /* #184: a redirected entry revalidates against its stored final
       URL, and the probe follows hops like the SWR refresh. */
    const { resp: probe, finalUrl: probeUrl } = await cacheRefreshFetch(
      req,
      {
        etag: hit.headers.get("etag"),
        lastModified: hit.headers.get("last-modified"),
      },
      hit.headers.get(ZL_FINAL_URL) ?? undefined,
      context,
    );
    if (probe.status === 304) {
      await bumpStoredEntry(req, probe);
      return hit;
    }
    if (probe.ok) return (await pageCacheStore(req, probe, true, probeUrl, context.clientId)) ?? null;
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
/** #492-class parked challenge handoff: the SW serves the completed
    challenge's content for the pass-challenge request, so a GET
    navigation would commit the engine-owned challenge URL and park
    there - every relative URL and every navguard prel then resolves
    against the wrong base (the live startpage favicon and ads-iframe
    strands). Mint the visible handle form of the repaired redir
    destination - the query shape when the host opted in, the NAVH
    path shape otherwise, the plain opaque route as the no-key
    fallback - and hand the browser a same-origin 302 instead: the
    re-navigation rides the ordinary pipeline with the clearance
    cookie already in the jar, and the document commits a URL its
    own code can read. Null = no repairable redir destination. */
export function challengeReanchorUrl(fixed: string, rootBinding?: string): string | null {
  let d: string | null = null;
  try {
    const raw = new URL(fixed).searchParams.get("redir");
    if (raw && /^https?:\/\//i.test(raw)) d = new URL(raw).href;
  } catch {
    return null;
  }
  if (!d) return null;
  const q = queryRoutesEnabled() ? buildQueryHandleUrl(d, NAVH_TTL_MS, rootBinding) : null;
  if (q) return q;
  const h = buildNavHandleUrl(d, NAVH_TTL_MS, rootBinding);
  if (h) return h;
  return encodeDest(d);
}

/** #101/#157: resolve a <parent route>/__zl_prel__/<encoded input>
    path to its destination. The parent may be a scheme route or a
    NAVH handle (decodeClientUrl) or a NAV navigation route (legacy
    b64 marker payload). Null = bad route, never a guess. */
export function navpResolve(pathname: string, engineOrigin?: string, baseFallback?: string | null): string | null {
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
  /* #508/#492-class parked prels: the parent path can be an
     engine-owned page URL (the pass-challenge strand the SW served
     content at, so the frame parked there and its prels inherit
     the parked parent). The parked URL's own query carries the
     MAC-verified handle the navigation rode (zlNavh); the caller
     extracts it and passes the decoded destination here, and the
     prel resolves against that - the page's virtual home.
     Fail-closed: no handle, no base, null as before. */
  if (!base) {
    if (baseFallback && /^https?:\/\//i.test(baseFallback)) {
      base = baseFallback;
    } else {
      return null;
    }
  }
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
  /* The candidate itself can be an engine route, including a
     concatenated one (<token><plaintext>: the JS literal pass once
     minted bare scheme fragments, and the runtime concatenation
     glued the host straight onto the token - the live startpage
     ads-iframe strand). Resolving a route against the parent base
     would bind it to the parent host; decode it as the route it
     is. MAC-verified or fail-closed; a candidate that is not a
     decodable route resolves against the base as before. */
  if (rel.startsWith(currentPrefix())) {
    const r = decodePath(rel) ?? recoverPath(rel);
    if (r && (r.startsWith("http://") || r.startsWith("https://"))) return r;
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
  /* #543: a destination that still carries a fragment keeps it on the
     clean form; it rides the committed URL only, the same contract
     as buildNavHandleUrl. */
  return NAVH + "/" + use + path + u.search + u.hash;
}
/* #535: a service-worker restart wipes the in-memory context map
   while every proxied page it served stays open. The page's next
   same-origin relative request arrives with a client id this fresh
   worker has never seen; with the referrer stripped (a no-referrer
   document, a SharedWorker that never had referrer semantics) the
   recovery chain recovers nothing and the honest 404 strands a live
   page. The fetch event carries the recovery key: the
   browser-committed client URL, readable for every client this
   worker controls and decodable only when engine-shaped. Rehydrate
   the client's context from it once, on the first miss, then let the
   ordinary resolution chain run. Fail-closed by construction: a
   client URL that does not decode to an http(s) engine route (a
   blob: worker client, the landing page) yields no context, so
   those requests keep the honest error. The referrer survives
   below this seam as the compatibility hint it already was. */
async function rehydrateClientContext(
  clientId: string | undefined,
): Promise<VirtualContext | undefined> {
  if (!clientId) return undefined;
  const known = contextOf(VCTX, clientId);
  if (known) return known;
  let client = null as null | Awaited<ReturnType<typeof self.clients.get>>;
  try {
    client = await raceBoot(
      self.clients.get(clientId),
      "virtual context rehydrate client lookup",
      PRE_DEADLINE_BOUND_MS,
    );
  } catch {
    /* boot-deadline miss: no context, the caller keeps the honest error */
    return undefined;
  }
  if (!client || !client.url) return undefined;
  const ctx = establishFromClientUrl(VCTX, clientId, client.url, decodeClientUrl);
  if (!ctx) return undefined;
  capContexts(VCTX, VCTX_CAP);
  const rtid = DIAG.trace(clientId);
  DIAG.emit({
    traceId: rtid,
    requestId: rtid,
    category: "SERVICE_WORKER",
    severity: "info",
    stage: "REQUEST_INTERCEPTED",
    message:
      "virtual context rehydrated from the browser-committed client URL after a worker restart (#535)",
    url: ctx.currentUrl,
  });
  return ctx;
}
function navOutcome(
  e: FetchEvent,
  url: URL,
  status: number,
  category: ErrorCategory,
  text: string,
): Response {
  const traceId = DIAG.trace(e.resultingClientId || e.clientId);
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
/* #537: page-created blob workers never reach this handler as script
   loads (Chromium serves blob: worker scripts from the blob store,
   no fetch event), so the page bootstrap wraps them: it inlines the
   original blob source behind an importScripts()/import() of the
   /zl-bw/ engine route, and the branch in the fetch handler below
   serves the prelude with the creating page's site token and
   virtual base baked into the head. The token carries page-known
   data only (the opaque site token and the page's own virtual
   URL), never an engine secret; a malformed token fails closed. */
export function zlBwTokenParse(search: string): { s: string; b: string } | null {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get("c");
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { s?: unknown; b?: unknown };
    if (typeof t.s !== "string" || typeof t.b !== "string" || !t.s || !t.b) return null;
    return { s: t.s, b: t.b };
  } catch {
    return null;
  }
}

export function zlBwHead(prefix: string, site: string, base: string): string {
  return (
    "self.__ZL_PREFIX__=" + JSON.stringify(prefix) + ";\n" +
    "self.__ZL_SITE__=" + JSON.stringify(site) + ";\n" +
    "self.__ZL_WORKER_BASE__=" + JSON.stringify(base) + ";\n"
  );
}

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
              /* Injector phase 2: a query-shape client is proxied. */
              queryHandleToken(sourceUrl.search) !== null)
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
    /* #537: blob-worker prelude route (see zlBwTokenParse). The
       request is a worker's importScripts()/import() of an engine
       route; the token carries the creating page's site and virtual
       base. Fail closed on anything malformed. */
    if (url.pathname === "/zl-bw/") {
      const tok = zlBwTokenParse(url.search);
      if (!tok) {
        e.respondWith(new Response("zeolite: bad blob-worker token", { status: 404, headers: { "content-type": "text/plain" } }));
        return;
      }
      e.respondWith(
        (async () => {
          if (engineReady) await raceBoot(engineReady, "blob-worker prelude");
          /* The token base is whatever the creating context could
             see: a virtual URL (late markers, nested parents) or its
             own engine route (an early page bootstrap, before the
             virtual-origin marker lands). Decode engine routes to the
             virtual URL so both shapes give the worker the same base. */
          let base = tok.b;
          try {
            const bu = new URL(tok.b, self.location.origin);
            if (bu.origin === self.location.origin) base = decodeClientUrl(bu) ?? tok.b;
          } catch { /* keep the token base as-is */ }
          return new Response(
            zlBwHead(currentPrefix(), tok.s, base) +
              (await workerPrelude()) +
              "\nself.__zlPreludeInit&&self.__zlPreludeInit(" +
              JSON.stringify(encodeDestLegacy(e.request.url) ?? "") +
              ");\n",
            { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } },
          );
        })(),
      );
      return;
    }
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
                pageUrl = decodeClientUrl(new URL(client.url, self.location.origin));
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
     synchronously before route classification: a cold-start fetch (restore still pending)
     must still be intercepted, not fall through to the origin with the
     default route shape. */
  let releaseGhosteryHold!: () => void;
  const ghosteryHold = new Promise<void>((resolve) => {
    releaseGhosteryHold = resolve;
  });
  /* The first matching request starts Ghostery's lazy Wisp list fetch,
     while continuing immediately under the local rules. Keep that
     background initialization alive after this response is returned. */
  e.waitUntil(ghosteryHold);
  const finishGhosteryHold = () => {
    const pending = ghosteryLoadInProgress();
    if (pending) void pending.then(releaseGhosteryHold, releaseGhosteryHold);
    else releaseGhosteryHold();
  };
  const responsePromise = (async () => {
      await routeReady;
      /* #394: the persisted jar-profile map restores before any
         cookie or cache decision, so a restarted worker does not
         silently route a session-profile page onto the durable
         default jar. Memoized: one cache read per worker lifetime. */
      await jarProfilesReady();
      /* Route-key restoration is needed to authenticate the NAVH host
         binding. Re-run this after the cold-start gate before any
         cookie or cache decision. */
      cookieClientId = inheritJarClient(
        e.clientId || undefined,
        e.resultingClientId || undefined,
        url.href,
      );
      /* Wave-32: bounded - see PRE_DEADLINE_BOUND_MS. */
      await raceBoot(recoverJarClientRoot(), "jar client root recovery", PRE_DEADLINE_BOUND_MS);
      await raceBoot(discardLegacyPageCache(), "legacy page cache discard", PRE_DEADLINE_BOUND_MS);
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
      /* Injector phase 2 (query-shape committed routes): a live
         zlNavh token decodes in the chain below like any route
         shape; an EXPIRED one on a GET navigation re-mints first (the
         #385 reload contract, mirrored from the NAVH branch). A
         garbage token takes neither arm: the ordinary chain below
         keeps its native behavior, so a host page that happens to
         carry the param name never breaks. */
      const qHandle = decodeQueryHandle(url);
      /* Route-shaped pathname: the path arm owns the URL and the
         expired re-mint below must never feed on a copied token
         either (its qFull would graft the route path onto the
         token origin). */
      const qTok =
        qHandle !== null || queryHandlePathShaped(url.pathname)
          ? null
          : queryHandleToken(url.search);
      const qExp =
        qTok !== null && e.request.method === "GET" && e.request.mode === "navigate"
          ? decodeExpiredNavHandle(qTok)
          : null;
      if (qExp !== null) {
        /* the expired payload names the origin only; the real path
           and query are the committed URL itself minus the token
           param (byte-faithful raw strip, same as the codec) */
        const qRaw = url.search.startsWith("?") ? url.search.slice(1) : "";
        const qRest = qRaw.split("&").filter((p) => p !== NAVQ_PARAM + "=" + qTok);
        /* #410: the committed path may carry the builder-escaped
           leading-slash run; restore it so the re-minted handle rides
           the real destination bytes. */
        const qFull =
          qExp.destination +
          restoreLeadingSlashes(url.pathname) +
          (qRest.length > 0 ? "?" + qRest.join("&") : "");
        const qFresh = buildQueryHandleUrl(qFull, NAVH_TTL_MS, qExp.rootClientId);
        if (qFresh) {
          const qtid = DIAG.trace(e.resultingClientId || e.clientId);
          netLogPush({
            method: e.request.method,
            traceId: qtid,
            path: url.pathname + url.search,
            dest: qFull,
            status: 302,
            rtype: classifyRtype(reqDest(e.request), ""),
            ms: 0,
            bytes: 0,
            verdict: "engine: expired query handle re-minted",
            transport: "engine",
            detail: { internalUrl: qFresh, ttfb: 0 },
          });
          return new Response(null, { status: 302, headers: { location: qFresh } });
        }
        /* a verified expiry that cannot re-mint (route key degraded)
           strands like the NAVH class - never a guess */
        return navOutcome(e, url, 404, "route", "zeolite: bad or expired query handle");
      }
      if (foreign) {
        /* Issue #34. The client lookup is the only async part; the
           policy itself is pure and unit-tested. */
        let clientUrl: string | undefined;
        try {
          if (e.clientId) {
            const client = await raceBoot(self.clients.get(e.clientId), "foreign client lookup", PRE_DEADLINE_BOUND_MS);
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
            if (e.request.referrer) initiator = decodeClientUrl(new URL(e.request.referrer, self.location.origin)) ?? undefined;
          } catch {
            /* initiator stays unknown */
          }
          netLogPush({
            method: e.request.method,
            traceId: DIAG.trace(e.resultingClientId || e.clientId),
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
            traceId: DIAG.trace(e.resultingClientId || e.clientId),
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
      } else if (qHandle !== null) {
        /* Injector phase 2: the query-shape committed route. The live
           token names the origin; the real path and query are the
           committed URL itself. The destination carries its own real
           query (the token rode the search string), so
           routeCarriesQuery stays false: no merge, no doubled query. */
        dest0 = qHandle.destination;
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
        /* #508-class: a parked parent decodes to nothing; the parked
           URL's own zlNavh names the page's virtual home. */
        const navpTok = queryHandleToken(url.search);
        let navpBase = navpTok ? decodeNavHandle(navpTok) : null;
        /* #492-class parked parent: the prel request itself carries no
           handle; the parked document URL (the referrer) carries zlNavh,
           and the client's own established context names its virtual
           home. MAC-verified handle decode or the frame's own context,
           never a guess. */
        if (!navpBase) {
          let refTok: string | null = null;
          try {
            const ref = e.request.referrer;
            refTok = ref ? queryHandleToken(new URL(ref).search) : null;
          } catch {
            refTok = null;
          }
          navpBase = refTok ? decodeNavHandle(refTok) : null;
          if (!navpBase) {
            const ctx = contextOf(VCTX, e.clientId);
            navpBase = ctx && /^https?:/i.test(ctx.targetOrigin) ? ctx.targetOrigin : null;
          }
        }
        const navpDest = navpResolve(url.pathname, undefined, navpBase);
        if (!navpDest) return navOutcome(e, url, 404, "route", "zeolite: bad route");
        /* URL fidelity (the Google sei reload class): a GET
           navigation on a NAVH-parent prel tail resolves correctly,
           but the reloaded document would park on the opaque prel
           pathname with its query folded inside it, invisible to
           location.search, so session-refresh flows that reload once
           in a real browser re-trigger here and the SPA state breaks.
           Serve the same destination on the visible handle form: one
           same-origin 302, then the document owns a URL whose path
           and query it can read. Fetches and non-GET navigations keep
           the prel decode (a redirect would strip a POST body).
           #383: non-NAVH parents get a fresh minted handle too -
           the prel decode already resolved the full destination,
           so the clean form needs nothing from the parent. */
        if (e.request.method === "GET" && e.request.mode === "navigate") {
          const clean = navhCleanFromPrel(url.pathname, navpDest);
          if (clean) {
            const traceId = DIAG.trace(e.resultingClientId || e.clientId);
            netLogPush({
              method: e.request.method,
              traceId,
              path: url.pathname + url.search,
              dest: navpDest,
              status: 302,
              rtype: classifyRtype(reqDest(e.request), ""),
              ms: 0,
              bytes: 0,
              verdict: "engine: prel navigation redirected to the visible handle form",
              transport: "engine",
              detail: { internalUrl: clean, ttfb: 0 },
            });
            return new Response(null, { status: 302, headers: { location: clean } });
          }
        }
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
             seam unions it with a full-dest token's own query (outer
             winning per key), so a legacy token that carries one
             keeps its params even when the route has a search. */
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
          if (!navhNavRec) {
            /* #385: an expired token whose MAC still verifies is one
               this engine minted, so a reload or back/forward to it
               must not strand the page. GET navigations answer ONE
               same-origin 302 to a fresh handle for the same
               destination (same visible path suffix, same route
               query), so the document owns a route that decodes
               again. A tampered or wrong-key token decodes to
               nothing and keeps the honest 404 - the re-mint never
               widens reach. POST keeps the 404 (a redirect strips
               the body); fetches keep the expiry (their branch is
               untouched). */
            if (e.request.method === "GET") {
              const navhExpHead = navhNavSlash >= 0 ? navhTail.slice(0, navhNavSlash) : navhTail;
              const navhExpired = decodeExpiredNavHandle(navhExpHead);
              if (navhExpired) {
                const navhFresh = buildNavHandleUrl(
                  navhExpired.destination,
                  NAVH_TTL_MS,
                  navhExpired.rootClientId,
                );
                if (navhFresh) {
                  const navhSuffix = navhNavSlash >= 0 ? navhTail.slice(navhNavSlash) : "";
                  const clean = navhFresh + navhSuffix + url.search;
                  const traceId = DIAG.trace(e.resultingClientId || e.clientId);
                  netLogPush({
                    method: e.request.method,
                    traceId,
                    path: url.pathname + url.search,
                    dest: navhExpired.destination,
                    status: 302,
                    rtype: classifyRtype(reqDest(e.request), ""),
                    ms: 0,
                    bytes: 0,
                    verdict: "engine: expired navigation handle re-minted",
                    transport: "engine",
                    detail: { internalUrl: clean, ttfb: 0 },
                  });
                  return new Response(null, { status: 302, headers: { location: clean } });
                }
              }
            }
            return navOutcome(e, url, 404, "route", "zeolite: bad or expired navigation handle");
          }
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
          /* #535: a restarted worker has never seen this client id;
             rehydrate the context from the browser-committed client
             URL before the referrer compat fallback runs. */
          if (!raw && (await rehydrateClientContext(e.clientId)))
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
        /* Wave 46 follow-up (the split-origin URL-bar strand): a legacy
           /zl/<b64u> route that reaches this seam is a route, never a
           page-relative tail. The split-origin content worker keeps its
           own configured prefix (LB pushes /zl/ only to the app worker),
           so every frame navigation to a legacy route lands here; the #33
           context recovery below used to resolve the route path against
           the PREVIOUS page's virtual origin (https://prev.example/zl/
           <b64u>), a guaranteed 404 strand for every URL-bar navigation
           once the previous page had settled. decodeLegacyRoute already
           validates the whole shape (two segments, the configured prefix
           or the reserved "zl" segment, a strict-UTF-8 http(s) b64u
           payload, never a keyed tail), so a decode wins here; an
           undecodable tail keeps the ordinary #33/#113/#389 order below,
           and a genuine escaped relative path (single or deeper
           segments, or a tail that does not decode to an http(s)
           destination) is untouched. */
        const legacyFirst = decodeLegacyRoute(url.pathname);
        let ctxDest = legacyFirst
          ? null
          : resolveRelative(VCTX, e.clientId, url.pathname + url.search);
        /* #535: a worker restart wiped this client's context; the
           browser-committed client URL re-establishes it before the
           bare path is declared unresolvable. */
        if (!legacyFirst && !ctxDest) {
          const rehydrated = await rehydrateClientContext(e.clientId);
          if (rehydrated)
            ctxDest = resolveRelative(VCTX, e.clientId, url.pathname + url.search);
        }
        if (legacyFirst) {
          const ltid = DIAG.trace(e.resultingClientId || e.clientId);
          DIAG.emit({
            traceId: ltid,
            requestId: ltid,
            category: "REWRITE",
            severity: "info",
            stage: "REQUEST_INTERCEPTED",
            message: "legacy route decoded ahead of the context recovery (split-origin prefix gap)",
            url: legacyFirst,
          });
          dest0 = unwrapDest(legacyFirst);
          routeCarriesQuery = true;
        } else if (ctxDest) {
          /* #511 (the cyber.blooket join class): a same-virtual-origin
             navigation the page performed through a NATIVE location
             write (window.location.href in bundled JS, an un-renamed
             realm; the #235 rename cannot reach these) lands on the
             bare same-origin path, and the #33 context recovery above
             resolves it. Serving the document at the bare path leaves
             no handle in the URL, so every page-side history write
             re-anchors through the vloc entry+NAVP mint (its
             navq-less arm) and parks the document on the opaque prel
             pathname; a pathname-routed SPA reading the native
             location then misses every route and renders its
             catch-all (Blooket's literal "Game not found."). Answer
             the navigation the way the initial navigation was
             answered: one same-origin 302 to the visible query-shape
             handle form (real path + fresh zlNavh token), so the
             document owns a URL whose pathname it can read and whose
             history writes commit the real path natively. Fail-closed:
             no mint (no route key, or the path collides with an
             engine surface), an existing handle param (the qHandle
             branch owns those), or a non-GET navigation keeps the
             direct serve (a redirect would strip a POST body). */
          if (
            e.request.method === "GET" &&
            e.request.mode === "navigate" &&
            !queryHandleToken(url.search)
          ) {
            const ctxClean = queryRoutesEnabled() ? buildQueryHandleUrl(ctxDest) : null;
            if (ctxClean) {
              const traceId = DIAG.trace(e.resultingClientId || e.clientId);
              netLogPush({
                method: e.request.method,
                traceId,
                path: url.pathname + url.search,
                dest: ctxDest,
                status: 302,
                rtype: classifyRtype(reqDest(e.request), ""),
                ms: 0,
                bytes: 0,
                verdict: "engine: context navigation redirected to the visible handle form",
                transport: "engine",
                detail: { internalUrl: ctxClean, ttfb: 0 },
              });
              return new Response(null, { status: 302, headers: { location: ctxClean } });
            }
          }
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
              const ltid = DIAG.trace(e.resultingClientId || e.clientId);
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
            } else if (legacyRouteShaped(url.pathname)) {
              /* #389: the path carries the engine's own mintable
                 route shape but nothing decodes it (a corrupt or
                 truncated tail - a live worker answered every
                 decodable one above). The origin can never serve an
                 engine route: a proxy host answers /zl/ with a 503
                 that says the engine is offline, which is false and
                 misleads operators. Fail closed from the engine;
                 non-route-shaped paths (the embedder app's own
                 assets) keep the #101 passthrough below. */
              return navOutcome(
                e,
                url,
                404,
                "route",
                "zeolite: undecodable legacy route",
              );
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
                traceId: DIAG.trace(e.resultingClientId || e.clientId),
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
      // query unions with the route search, outer params winning per
      // key (see mergeRouteSearch for the live-strand reasoning).
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
      /* #492-class: set when this navigation is a repaired
         pass-challenge handoff; the response seam re-anchors the
         browser instead of committing the parked challenge URL. */
      let challengeReanchor: string | null = null;
      if (isPassChallenge(target)) {
        /* #258: the challenge page's virtual home. The frame's
           established context names the post-redirect final
           destination - the origin an unproxied page would have
           echoed into redir; the request's own route path backs
           the navh-handle fallback. */
        const homeCtx =
          contextOf(VCTX, e.clientId) ?? (await rehydrateClientContext(e.clientId));
        const homeOrigin =
          homeCtx && /^https?:/i.test(homeCtx.targetOrigin) ? homeCtx.targetOrigin : null;
        const fixed = passChallengeRedirFixed(target, self.location.origin, homeOrigin, url.pathname);
        if (fixed && fixed !== target) {
          const ctid = DIAG.trace(e.resultingClientId || e.clientId);
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
          /* #492-class re-anchor: a GET navigation must not park on
             the challenge URL once the handoff is repaired. The
             request's own zlNavh lineage carries the cookie-profile
             root binding into the fresh mint. */
          if (e.request.mode === "navigate" && e.request.method === "GET") {
            const navhTok = queryHandleToken(url.search);
            const root = navhTok ? decodeNavHandleRoot(navhTok) ?? undefined : undefined;
            challengeReanchor = challengeReanchorUrl(fixed, root);
          }
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
        const dtid = DIAG.trace(e.resultingClientId || e.clientId);
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

      /* #436: resolve the requesting page before widget identity
         correction and before a navigation replaces its client context.
         Initiator: the controlling page destination. Issue #33: the
         client's own virtual context is the primary source (right
         even with an empty referrer); the client URL decode remains
         the fallback (unknown after a restart, for instance). */
      let initiator: string | undefined;
      const ctx =
        contextOf(VCTX, e.clientId) ?? (await rehydrateClientContext(e.clientId));
      if (ctx) initiator = ctx.currentUrl;
      if (initiator === undefined) {
        try {
          if (e.clientId) {
            const client = await raceBoot(self.clients.get(e.clientId), "initiator client lookup", PRE_DEADLINE_BOUND_MS);
            if (client) initiator = decodeClientUrl(new URL(client.url, self.location.origin)) ?? undefined;
          }
        } catch {
          /* initiator stays unknown */
        }
      }

      /* #112: the Referer fix alone does not repair the reCAPTCHA
         widget: its JS builds co= from window.location.origin
         (LegacyUnforgeable), so upstream always receives the engine
         origin and the site-key domain check fails. Virtualize a
         co= that names this deployment at the seam the engine owns. */
      const coFixed = virtualRecaptchaCo(target, e.request.referrer, self.location.origin, initiator);
      if (coFixed !== target) {
        const ctid = DIAG.trace(e.resultingClientId || e.clientId);
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

      /* The Google apps widget (ogs.google.com) builds its origin=
         from window.location.origin (LegacyUnforgeable, the #112
         co= class): upstream validation sees the engine origin and
         the 9-dot apps menu never renders. Virtualize an origin=
         that names this deployment at the seam the engine owns. */
      const ogsFixed = virtualOgsOrigin(target, e.request.referrer, self.location.origin, initiator);
      if (ogsFixed !== target) {
        const otid = DIAG.trace(e.resultingClientId || e.clientId);
        DIAG.emit({
          traceId: otid,
          requestId: otid,
          category: "REWRITE",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "ogs origin= virtualized to the page origin",
          url: target,
        });
        target = ogsFixed;
      }

      /* #483: Google Identity Services One Tap and OAuth button flows
         carry origin= / ss_domain= constructed from LegacyUnforgeable
         window.location.origin. Repair only values naming this engine
         and only in the provider's /gsi/ request family. */
      const gsiFixed = virtualGsiOrigin(target, e.request.referrer, self.location.origin, initiator);
      if (gsiFixed !== target) {
        const gtid = DIAG.trace(e.resultingClientId || e.clientId);
        DIAG.emit({
          traceId: gtid,
          requestId: gtid,
          category: "REWRITE",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "gsi origin parameter virtualized to the page origin",
          url: target,
        });
        target = gsiFixed;
      }

      /* The hCaptcha widget (#433) builds its host= from
         window.location.hostname (LegacyUnforgeable, the #112 co=
         class): hCaptcha validates it against the sitekey's
         registered hostnames, so upstream sees the engine host and
         the widget never renders. Virtualize a host= that names
         this deployment at the seam the engine owns. */
      const hcFixed = virtualHcaptchaHost(target, e.request.referrer, self.location.origin, initiator);
      if (hcFixed !== target) {
        const htid = DIAG.trace(e.resultingClientId || e.clientId);
        DIAG.emit({
          traceId: htid,
          requestId: htid,
          category: "CHALLENGE",
          cause: "challenge",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "hcaptcha host= virtualized to the page origin",
          url: target,
        });
        target = hcFixed;
      }

      /* #506: the Twitch embed library builds parent= from
         window.location.hostname (LegacyUnforgeable, the #112 co=
         class): a virtualized page names the engine hostname,
         Twitch validates parent against the domain actually serving
         the embed, and the player iframe is refused. Virtualize a
         parent= that names this deployment at the seam the engine
         owns. */
      const twFixed = virtualTwitchParent(target, e.request.referrer, self.location.origin, initiator);
      if (twFixed !== target) {
        const ttid = DIAG.trace(e.resultingClientId || e.clientId);
        DIAG.emit({
          traceId: ttid,
          requestId: ttid,
          category: "REWRITE",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "twitch parent= virtualized to the page origin",
          url: target,
        });
        target = twFixed;
      }


      /* #431: MSAL computes redirect_uri from
         window.location.origin (LegacyUnforgeable, the #112 co=
         class), so the AAD authorize request names the engine
         origin and the OAuth round-trip lands on a native
         engine-origin URL the proxy never re-enters (Outlook's
         login chain ends blank). Virtualize a redirect_uri whose
         origin names this deployment at the seam the engine owns. */
      const arFixed = virtualAuthorizeRedirect(target, e.request.referrer, self.location.origin, initiator);
      if (arFixed !== target) {
        const atid = DIAG.trace(e.resultingClientId || e.clientId);
        DIAG.emit({
          traceId: atid,
          requestId: atid,
          category: "REWRITE",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "authorize redirect_uri virtualized to the page origin",
          url: target,
        });
        target = arFixed;
      }

      /* #509: the Telegram Login widget loader builds
         oauth.telegram.org/auth with an origin= minted from
         window.location.origin (LegacyUnforgeable, the #112 co=
         class); Telegram validates it against the bot registered
         Allowed URLs and answers NOT_AUTHORIZED for the engine
         origin. Virtualize an origin= naming this deployment at
         the seam the engine owns; return_to is the redirect-target
         class and stays out of scope. */
      const tgFixed = virtualTelegramOrigin(target, e.request.referrer, self.location.origin, initiator);
      if (tgFixed !== target) {
        const tgid = DIAG.trace(e.resultingClientId || e.clientId);
        DIAG.emit({
          traceId: tgid,
          requestId: tgid,
          category: "REWRITE",
          severity: "info",
          stage: "REQUEST_INTERCEPTED",
          message: "telegram origin= virtualized to the page origin",
          url: target,
        });
        target = tgFixed;
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
        const rtid = DIAG.trace(e.resultingClientId || e.clientId);
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

      /* #477 P3: fetch bridging into the guest realm. The request has
         decoded to its real virtual-site URL and passed the
         disabled-site gate; if a running guest service worker owns
         that URL scope, the engine asks it first under the hard
         250 ms fail-closed budget. A handled guest answer becomes the
         served Response verbatim minus privileged cookie headers (an
         invalid status/body combination fails closed); every other
         outcome falls through to the ordinary engine path unchanged.
         Recursion is provably impossible: guests reach the network only
         through the #538 bridge over upstreamFetch, which never enters
         handleFetch, so a guest answer never originates a guest
         dispatch, and the pending-id one-shot marker consumes exactly
         one response per dispatch. An already-aborted request never
         reaches the guest. */
      if (!(e.request.signal && e.request.signal.aborted)) {
        try {
          const gHeaders: Record<string, string> = {};
          for (const [hk, hv] of e.request.headers) gHeaders[hk] = hv;
          const gOutcome = await guestDispatchFetchForUrl(target, {
            url: target,
            method: e.request.method,
            headers: gHeaders,
            destination: e.request.destination || undefined,
            mode: e.request.mode,
            clientId: e.resultingClientId || e.clientId || undefined,
          });
          if (gOutcome.handled) {
            const gH = new Headers(gOutcome.headers);
            /* A guest response must not stamp cookies onto the engine
               origin; virtual-site cookies belong to the jar at request
               time. */
            gH.delete("set-cookie");
            gH.delete("set-cookie2");
            try {
              const gResp = new Response(gOutcome.body, { status: gOutcome.status, headers: gH });
              const gt = DIAG.trace(e.resultingClientId || e.clientId);
              DIAG.emit({
                traceId: gt,
                requestId: gt,
                category: "SERVICE_WORKER",
                severity: "info",
                stage: "REQUEST_INTERCEPTED",
                message: "guest fetch handler served the request (#477 P3)",
                url: target,
              });
              return gResp;
            } catch {
              /* Invalid status/body combination fails closed below. */
            }
          }
        } catch {
          /* Guest bridging never breaks the ordinary engine path. */
        }
      }

      return (async () => {
        const t0 = Date.now();
        const traceId = DIAG.trace(e.resultingClientId || e.clientId);
        DIAG.stage(traceId, "REQUEST_INTERCEPTED", { url: target });
        /* Issue #34: a foreign-origin request has no engine-local path;
           the full URL is its internal identity (and the netLog path). */
        const internalUrl = foreign ? url.href : url.pathname + url.search;
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
        const policyRule = behaviorMatch(policy, target, rtype);
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
        const ruleDec = applyRules(engineRules, target, rtype, initiator, e.request.destination);
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
          traceDecision({ subsystem: "rules", rule: ruleDec.matched, original: target, result: ruleDec.ghosteryRedirect ? "redirected" : "blocked", resource: rtype, traceId });
        if (ic.block)
          traceDecision({ subsystem: "intercept", original: target, result: "blocked", resource: rtype, traceId });
        if (ruleDec.url)
          traceDecision({ subsystem: "rules", rule: "rewrite", original: target, result: ruleDec.url, resource: rtype, traceId });
        if (ic.url)
          traceDecision({ subsystem: "intercept", original: target, result: ic.url, resource: rtype, traceId });
        if (ruleDec.action === "block" || ic.block) {
          const ghosteryResponse =
            ruleDec.ghosteryRedirect && !ic.block
              ? ghosteryRedirectResponse(ruleDec.ghosteryRedirect, e.request.credentials, e.request.method)
              : null;
          DIAG.emit({
            category: "BLOCKED",
            cause: "blocked",
            severity: "info",
            message:
              ghosteryResponse
                ? "request fulfilled by Ghostery redirect (" + (ruleDec.matched ?? "") + ")"
                : "request blocked by " +
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
            status: ghosteryResponse ? 200 : e.request.mode === "navigate" ? 403 : 0,
            rtype: rtype.toUpperCase(),
            ms: Date.now() - t0,
            bytes: -1,
            verdict: ghosteryResponse
              ? "redirect:ghostery"
              : ruleDec.action === "block"
                ? "blocked:rules"
                : "blocked:intercept",
            transport: ghosteryResponse ? "engine" : blockDecision.mode,
            fallbackReason: ghosteryResponse ? undefined : reasonOf(blockDecision),
            detail: mkDetail(ghosteryResponse ?? undefined),
          });
          if (ghosteryResponse) {
            WEBREQ.completed({ ...wrDetails, statusCode: 200 });
            if (e.request.mode === "navigate") {
              WEBNAV.committed(target);
              WEBNAV.completed(target);
            }
            return ghosteryResponse;
          }
          /* #500: a real blocker fails the request at the network level
             (ERR_BLOCKED_BY_CLIENT; fetch rejects with TypeError).
             Block-tester probes count only rejections, and a page
             cannot distinguish the synthetic 403 from a real origin
             403, so non-navigate blocked requests answer with a
             network error; navigations keep the honest engine page. */
          if (e.request.mode !== "navigate") return Response.error();
          return navOutcome(e, url, 403, "blocked", "zeolite: request blocked");
        }
        if (ruleDec.url || ic.url) target = destUpgraded(ic.url ?? ruleDec.url ?? target);

        /* Cache-first for proxied GETs. #179: a credential-bearing
           request (Authorization or a jar cookie for the target)
           never serves from the shared page cache.
           zl:reloadBypass (#211, LB): an armed one-shot bypass is
           consumed by a document GET, which skips the page cache
           and takes the live upstream path. */
        const bypassArmed = e.request.mode === "navigate" && reloadBypassArmed();
        if (bypassArmed) setReloadBypass(false);
        if (
          e.request.method === "GET" &&
          !bypassArmed &&
          !requestHasCredentials(e.request, target, cookieClientId)
        ) {
          const hit = await raceBoot(pageCacheMatch(e.request, (p) => e.waitUntil(p), { clientId: cookieClientId, initiator: initiator ?? undefined, navigation: e.request.mode === "navigate" }), "page cache match", PRE_DEADLINE_BOUND_MS);
          /* A cache entry may predate CSP opt-in and has already lost
             the upstream CSP during header sanitation. For HTML
             documents, opt-in CSP must fetch the live response rather
             than silently serve a CSP-free cached copy. */
          if (hit && !(experimentalEnabled("cspTranslation") && DOC_DESTS.has(dest.toLowerCase()))) {
            /* #487: one conservative planner for cache and live responses.
               MIME, KDL behavior, and CDN-CGI gates must not diverge
               between first load and reload. */
            const plan = planResponseTransit(decision, hit.headers.get("content-type") ?? "", dest, target, policyRule);
            const dec = plan.decision;
            if (experimentalEnabled("adaptiveTransit"))
              traceDecision({ subsystem: "transport", rule: "adaptive-shadow",
                original: decision.mode, result: plan.strategy + ":" + plan.evidence,
                resource: rtype, traceId }, true);
            /* #487: opt-in evidence, no raw URL added to the planner trace;
               traceId joins the existing network log for this request. */
            traceDecision({ subsystem: "transport", rule: "adaptive-picker", original: dec.mode,
              result: plan.strategy + ":" + plan.evidence, resource: rtype, traceId });
            const chNative = isCdnCgiUrl(target);
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
                hit.status === 200 && DOC_DESTS.has(dest) && isHtml(hit)
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
            /* #414: HTML MIME alone does not make a document; the
               live-path twin below gates the same way. */
            if (DOC_DESTS.has(dest) && isHtml(hit) && hit.body && !chNative) {
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
            if (isCss(hit) && hit.body && !chNative) {
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
              hit.body &&
              !chNative
            ) {
              const jsCt = hit.headers.get("content-type") ?? "";
              const raw0 = decodeBody(await hit.arrayBuffer(), jsCt);
              let src = rewriteModuleWorkerImports(
                currentPrefix(),
                cacheRewriteBase(hit, target),
                self.location.origin,
                raw0,
              );
              /* #449: origin-pinning skip telemetry for the cached
                 copy (the fresh path's twin). */
              let pinnedScript = false;
              try {
                pinnedScript = await scriptPinsOrigins(src);
              } catch {
                pinnedScript = false;
              }
              if (pinnedScript) {
                netLogAnnotateRewrite(traceId, "js-pinned");
                DIAG.stage(traceId, "PINNED_SCRIPT", { url: target, message: "literal pass skipped: anchored origin-pinning regex (#449)" });
              }
              /* #487 phase 4: the fresh path's twin recovery gate. */
              const afterSpecifiers = src;
              let literalOut: string | null = src;
              if (adaptiveTransitEnabled() && literalPassDemotion(target)) {
                netLogAnnotateRewrite(traceId, "js-adaptive-recovery");
                DIAG.stage(traceId, "ADAPTIVE_RECOVERY", { url: target, message: "cache-hit literal pass skipped: corroborated body-pass failures (#487 phase 4)" });
                noteDemotionServed(target);
                literalOut = null;
              } else {
                try {
                  src = await rewriteJsBody(src, cacheRewriteBase(hit, target), initiator);
                  literalOut = src;
                } catch (err) {
                  /* A wasm load failure must not break the hit: the
                     specifier output still serves (the fresh path's
                     rule). */
                  literalOut = null;
                  recordBodyPassFailure(target, traceId);
                  DIAG.emit({
                    category: "REWRITE",
                    severity: "error",
                    message: "cache-hit script body pass failed",
                    technicalReason: String(err),
                    url: target,
                  });
                }
              }
              const jsOutcome = planJsServeOutcome(raw0, afterSpecifiers, literalOut);
              recordJsServeOutcome(target, jsOutcome);
              if (jsOutcome.provenUnchanged) netLogAnnotateRewrite(traceId, "js-proven-unchanged");
              else if (jsOutcome.literalChanged) netLogAnnotateRewrite(traceId, "js-literal-rewritten");
              else if (jsOutcome.specifierChanged) netLogAnnotateRewrite(traceId, "js-specifier-rewritten");
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
          let identityProfile = getFpProfile();
          if (!identityProfile) identityProfile = (await siteProfileFor(target))?.p ?? null;
          if (identityProfile) {
            sendHeaders.set("accept-language", acceptLanguageValue(identityProfile.languages));
            if (identityProfile.matchUserAgent !== false) sendHeaders.set("user-agent", identityProfile.userAgent);
          } else {
            const ruleUa = siteUaFor(target);
            if (ruleUa) sendHeaders.set("user-agent", ruleUa);
          }
          /* #429/#437: opting out keeps native UA/Client Hints. Otherwise
             every hint follows the final profile/rule identity. */
          if (identityProfile?.matchUserAgent !== false) {
            const wireUa = sendHeaders.get("user-agent") ?? "";
            // An unchanged native identity needs no high-entropy filtering.
            applyChUa(sendHeaders, wireUa, !identityProfile && wireUa === (e.request.headers.get("user-agent") ?? ""));
          }
          /* 2.2 Arsenide: initiator context for the opt-in SameSite
             policy. Issue #33: the initiator comes from the client's own
             virtual context first (a SW-assigned key, not a page-supplied
             string); the referrer decode is the compat fallback.
             Navigations are top-level for lax purposes. */
          const initCtx =
            contextOf(VCTX, e.clientId) ?? (await rehydrateClientContext(e.clientId));
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
             (cap zl:config replayCapMb, default 32 MiB); a cross-origin
             hop drops Authorization
             per spec. Only an announced body over the cap without the authorized
             replay spool streams one-shot and surfaces with a mapped
             Location (#556). */
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
            const buffered = await replayableInit(
              { method: hopMethod, headers: sendHeaders, body: hopBody, signal: e.request.signal },
              /* #556: the host-authorized OPFS spool turns an
                 over-cap streamed body into a replayable File so the
                 hop chain follows 307/308 (and body-preserving
                 301/302 on non-POST methods) instead of surfacing
                 the redirect to the page. */
              { hopReplay: true, spoolAuthorized: spoolUploadsEnabled() },
            );
            hopBody = buffered.body ?? null;
            if (buffered.spool) {
              /* #556: the vendored transport adapter refuses a File body
                 (its socket plumbing throws Failed to fetch), and it
                 full-buffers whatever it carries into the wasm heap
                 anyway, so materialize the one proven body shape from
                 the spool once per chain, bounded by the measured
                 transport ceiling; over it the request fails honestly
                 instead of crashing the renderer. */
              hopBody = await spoolTransportCopy(buffered.spool);
              /* The spool file is dead weight once the final hop's
                 request body was sent; the fetch event settles only
                 after the response stream reaches the page, so
                 releasing there never races a live hop. A failed
                 release only leaks a file the orphan sweep reclaims. */
              e.waitUntil(buffered.spool.release().catch(() => {}));
            }
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
            const hopRule = applyRules(engineRules, hopUrl, rtype, initiator, e.request.destination);
            /* The reason names the gate that fired (netLog carries it). */
            let hopBlockReason: "BLOCKED_RULES" | "BLOCKED_INTERCEPT" | "BLOCKED_WEBREQUEST" | null = null;
            const hopDisabled = siteDisabled(hopUrl);
            if (hopDisabled) hopBlockReason = "BLOCKED_RULES";
            else if (hopRule.action === "block") hopBlockReason = "BLOCKED_RULES";
            else if (WEBREQ.beforeRequest({ ...wrDetails, url: hopUrl })) hopBlockReason = "BLOCKED_WEBREQUEST";
            else if (runRequestInterception(kinds, { url: hopRule.url ?? hopUrl, method: hopMethod, rtype, headers: flatReq }).block) hopBlockReason = "BLOCKED_INTERCEPT";
            if (hopBlockReason) {
              const ghosteryResponse =
                hopBlockReason === "BLOCKED_RULES" && !hopDisabled && hopRule.ghosteryRedirect
                  ? ghosteryRedirectResponse(hopRule.ghosteryRedirect, e.request.credentials, hopMethod)
                  : null;
              DIAG.emit({
                category: "BLOCKED",
                cause: "blocked",
                severity: "info",
                stage: "REDIRECT_HOP",
                message: ghosteryResponse
                  ? "redirect hop fulfilled by Ghostery redirect (" + (hopRule.matched ?? "") + ")"
                  : "redirect hop blocked by request gates",
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
                status: ghosteryResponse ? 200 : 403,
                rtype,
                ms: Date.now() - t0,
                bytes: -1,
                verdict: ghosteryResponse ? "redirect:ghostery" : "blocked",
                transport: ghosteryResponse ? "engine" : hopDecision.mode,
                fallbackReason: ghosteryResponse ? undefined : reasonOf(hopDecision),
                detail: mkDetail(ghosteryResponse ?? undefined),
              });
              if (ghosteryResponse) {
                WEBREQ.completed({ ...wrDetails, url: hopUrl, statusCode: 200 });
                if (e.request.mode === "navigate") WEBNAV.completed(hopUrl);
                return ghosteryResponse;
              }
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
            /* #477-class wedge guard: the vendored wrapper tears a
               completed request down through a DEFERRED wasm-side
               removal (a 1ms timer in the artifact's request
               lifecycle), and this loop issues the next hop in the
               same task, inside that cleanup window. When the hop
               rides the same curl session while the previous handle
               is being removed, the new transfer's response can be
               consumed on the wire yet dispatch to no JS callback:
               the fetch wedges forever with no error (reproduced on
               pristine parent engine sources; load-timing dependent,
               and it only bites the immediate-replay hop shape).
               Yield past the deferred removal before issuing the
               hop; the 10ms bound is invisible next to a redirect
               round trip. */
            await new Promise((r) => setTimeout(r, 10));
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
            let rec = dest === "script" ? await recoverFlagSurgeryScript(initiator ?? "", target, e.request.headers, recoveryUpstream(policy, rtype, traceId), traceId) : null;
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
              rec = await recoverFlatAsset(initiator ?? "", target, dest, e.request.headers,
                recoveryUpstream(policy, rtype, traceId));
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
                severity: shapeOk ? "warning" : "info",
                stage: "UPSTREAM_RESPONSE",
                message:
                  (shapeOk ? "flat asset recovery miss: " : "flat asset recovery skipped: ") +
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
          /* #452: opt-in, strictly deny-only CSP on HTML documents.
             The live response carries original headers; every
             unsupported policy is left stripped (not passed through). */
          if (experimentalEnabled("cspTranslation"))
            applyExperimentalCsp(outHeaders, resp.headers,
              resp.headers.get("content-type") ?? "", DOC_DESTS.has(dest.toLowerCase()));
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
            /* #543: the mapped route keeps the destination fragment raw
               on the committed URL (native anchor scroll and
               location.hash), and the encoded payload stays
               fragment-free. Unresolvable values stay as-is. */
            mapLocationHeader(outHeaders, finalDest ?? target);
          }
          /* #32 follow-up: Refresh is functional, not informational, so its
             url= is mapped to an engine route instead of stripped -
             a delayed refresh must stay inside the engine. Same-page
             refresh (no url=) carries no destination and passes. */
          mapRefreshHeader(outHeaders, finalDest ?? target);
          /* #256 contract: onResponse hooks are best-effort observers,
             fired without awaiting (edits ignored, throws isolated). */
          void applyOnResponse(plugins, target, resp.status, outHeaders);
          /* #487: same response selector as the page-cache hit path.
             It keeps rewrite behavior independent from Wisp/relay
             transport rules, and never auto-demotes required passes. */
          const plan = planResponseTransit(decision, resp.headers.get("content-type") ?? "", dest, target, policyRule);
          const dec = plan.decision;
          if (experimentalEnabled("adaptiveTransit"))
            traceDecision({ subsystem: "transport", rule: "adaptive-shadow",
              original: decision.mode, result: plan.strategy + ":" + plan.evidence,
              resource: rtype, traceId }, true);
          traceDecision({ subsystem: "transport", rule: "adaptive-picker", original: dec.mode,
            result: plan.strategy + ":" + plan.evidence, resource: rtype, traceId });
          if (dec.mode === "NativeTransit" && dec.reason === "POLICY_NATIVE")
            traceDecision({ subsystem: "policy", rule: policyRule!.id, original: target, result: "native", resource: rtype, traceId });
          const cdnCgiNative = isCdnCgiUrl(target);
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
          /* #492-class: the challenge completed upstream (the
             clearance cookie landed with the fetch); commit the
             re-anchor instead of parking the document on the
             engine-owned challenge URL. */
          if (challengeReanchor && resp.status >= 200 && resp.status < 400) {
            const ratid = DIAG.trace(e.resultingClientId || e.clientId);
            DIAG.emit({
              requestId: ratid,
              traceId: ratid,
              category: "CHALLENGE",
              cause: "challenge",
              severity: "info",
              stage: "RESPONSE_RECEIVED",
              message: "pass-challenge navigation re-anchored to the page handle",
              url: challengeReanchor,
            });
            return new Response(null, { status: 302, headers: { location: challengeReanchor } });
          }
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
            return new Response(rawFrom(sniffHead, sniffReader, finalDest ?? target), {
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
            const jsRaw = decodeBody(await resp.arrayBuffer(), respCt);
            let src = rewriteModuleWorkerImports(currentPrefix(), target, self.location.origin, jsRaw);
            /* #449: an origin-pinning script body (anchored ^https?:
               regex, the gapi-class loader) keeps its URL literals
               verbatim - the rewriter skips the literal pass inside
               rewriteJsBody; this records the machine-readable skip
               on the request's netLog row, the tracing ring and the
               diag stream. The frame-buster and globals passes still
               run; the runtime seams keep every request on the
               engine. */
            let pinnedScript = false;
            try {
              pinnedScript = await scriptPinsOrigins(src);
            } catch {
              pinnedScript = false;
            }
            if (pinnedScript) {
              netLogAnnotateRewrite(traceId, "js-pinned");
              traceDecision({ subsystem: "rewriter", rule: "origin-pinning", original: target, result: "literal-skip", resource: rtype, traceId });
              DIAG.stage(traceId, "PINNED_SCRIPT", { url: target, message: "literal pass skipped: anchored origin-pinning regex (#449)" });
            }
            /* #46: external script bodies get the URL-literal +
               frame-buster pass inline scripts get. Specifiers run
               first: the routes they emit are root-relative, so the
               literal pass leaves them alone. A wasm load failure must
               not 502 the script - the specifier output still serves. */
            /* #487 phase 4: corroborated, opt-in learned recovery may
               skip the literal pass on the NEXT serve for this origin
               (never a replay, never mid-document; the specifier pass
               and the runtime seams stay). A manual KDL native rule
               already won at policyNativeJs above. */
            const afterSpecifiers = src;
            let literalOut: string | null = src;
            if (adaptiveTransitEnabled() && literalPassDemotion(target)) {
              netLogAnnotateRewrite(traceId, "js-adaptive-recovery");
              DIAG.stage(traceId, "ADAPTIVE_RECOVERY", { url: target, message: "literal pass skipped: corroborated body-pass failures (#487 phase 4)" });
              noteDemotionServed(target);
              literalOut = null;
            } else {
              try {
                src = await rewriteJsBody(src, target, initiator);
                literalOut = src;
              } catch (err) {
                literalOut = null;
                recordBodyPassFailure(target, traceId);
                DIAG.emit({
                  category: "REWRITE",
                  severity: "error",
                  message: "script body pass failed",
                  technicalReason: String(err),
                  url: target,
                });
              }
            }
            /* #487 phase 2: the ACTUAL transformation class, proven by
               the rewriter's own outputs. A proven-unchanged body still
               serves through this pipeline and is never reclassified
               native: a textual no-diff is not site-level proof. */
            const jsOutcome = planJsServeOutcome(jsRaw, afterSpecifiers, literalOut);
            recordJsServeOutcome(target, jsOutcome);
            if (jsOutcome.provenUnchanged) netLogAnnotateRewrite(traceId, "js-proven-unchanged");
            else if (jsOutcome.literalChanged) netLogAnnotateRewrite(traceId, "js-literal-rewritten");
            else if (jsOutcome.specifierChanged) netLogAnnotateRewrite(traceId, "js-specifier-rewritten");
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

/** #509: the Telegram Login widget loader builds oauth.telegram.org/auth
    with an origin= parameter minted from window.location.origin
    (LegacyUnforgeable, the #112 co= class). Telegram validates origin=
    against the bot pre-registered Allowed URLs, so a virtualized page
    names the engine origin and the login answers NOT_AUTHORIZED. Re-map
    only exact engine-origin parameters using a verified page context;
    everything else is intentionally left untouched. return_to is the
    redirect-target class, a separate issue, and stays as the page sent
    it. */
export function virtualTelegramOrigin(target: string, referrer: string, engineOrigin: string, initiator?: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol)) return target;
  if (u.host !== "oauth.telegram.org") return target;
  if (u.pathname !== "/auth") return target;
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

/** #483: Google Identity Services embeds the page origin in the origin=
    parameter of /gsi/iframe/select, /gsi/select and /gsi/button; the OAuth
    button flow also uses ss_domain=. A native location read names Zeolite's
    engine origin, which Google cannot recognize as the embedding page.
    Re-map only exact engine-origin parameters using a verified page
    context (or a decodable engine-route referrer). A mismatch, malformed
    input or unknown context is intentionally left untouched. This repairs
    request identity, not Google's server-side OAuth registration checks. */
export function virtualGsiOrigin(target: string, referrer: string, engineOrigin: string, initiator?: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol) || u.host !== "accounts.google.com") return target;
  if (!u.pathname.startsWith("/gsi/") || !u.search) return target;
  let parent: string | null | undefined;
  const fixed = u.search.replace(/([?&])(origin|ss_domain)=([^&]*)/g, (full, sep: string, key: string, raw: string) => {
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return full;
    }
    if (value !== engineOrigin && value !== engineOrigin + ":443" && value !== engineOrigin + ":80")
      return full;
    if (parent === undefined) parent = referrerOrigin(referrer, initiator);
    if (!parent) return full;
    return sep + key + "=" + encodeURIComponent(parent);
  });
  return fixed === u.search ? target : u.href.replace(u.search, fixed);
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

/** #506: the Twitch player/embed library builds the parent= param
    from window.location.hostname (LegacyUnforgeable, the #112 co=
    class): a virtualized page names the engine hostname, Twitch
    validates parent against the domain actually serving the embed,
    and the player iframe is refused ("embed.twitch.tv refused to
    connect"). Virtualize a parent= that names this deployment at
    the seam the engine owns; parent takes bare domains and one
    parent key is used per domain, so every engine-hostname-valued
    occurrence is rewritten. Rendering fidelity only. */
export function virtualTwitchParent(target: string, referrer: string, engineOrigin: string, initiator?: string): string {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return target;
  }
  if (!/^https?:$/.test(u.protocol)) return target;
  const player = u.host === "player.twitch.tv" && u.pathname === "/";
  const embed = u.host === "embed.twitch.tv" && u.pathname.startsWith("/embed/");
  if (!player && !embed) return target;
  let engineHost = "";
  let engineHostname = "";
  try {
    const eo = new URL(engineOrigin);
    engineHost = eo.host;
    engineHostname = eo.hostname;
  } catch {
    return target;
  }
  let home: string | null | undefined;
  const fixed = u.search.replace(/([?&])parent=([^&]*)/g, (full, sep: string, raw: string) => {
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return full;
    }
    if (
      value !== engineHostname &&
      value !== engineHost &&
      value !== engineOrigin &&
      value !== engineOrigin + ":443" &&
      value !== engineOrigin + ":80" &&
      value !== engineHost + ":443" &&
      value !== engineHost + ":80"
    )
      return full;
    if (home === undefined) home = referrerOrigin(referrer, initiator);
    if (!home) return full;
    let vu: URL;
    try {
      vu = new URL(home);
    } catch {
      return full;
    }
    return sep + "parent=" + encodeURIComponent(vu.hostname);
  });
  return fixed === u.search ? target : u.href.replace(u.search, fixed);
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
    /* Hop-by-hop headers (RFC 7230 6.1) never travel upstream. The
       physical browser attaches h2c upgrade tokens ("Upgrade: h2c",
       "HTTP2-Settings", and a Connection header naming them) to
       engine-origin navigations; replaying them upstream broke strict
       origins (a Node server with an upgrade listener reads the replay
       as a protocol upgrade, destroys the socket, and the page dies as
       an empty-reply 502 - reproduced end to end by the #525
       computed-sink suite fixture). */
    "upgrade",
    "http2-settings",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
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
  /* RFC 7230 6.1: every header the request's own Connection header names
     is hop-by-hop for this hop too; the set above covers the tokens
     observed in the wild, this covers whatever a browser or embedder
     invents next. */
  const connHeader = req.headers.get("connection");
  if (connHeader) {
    for (const tok of connHeader.split(",")) {
      const name = tok.trim().toLowerCase();
      if (name) skip.add(name);
    }
  }
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


