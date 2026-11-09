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
import { b64uDecode, b64uEncode, buildNavHandleUrl, buildQueryHandleUrl, decodeClientUrl, decodeExpiredNavHandle, decodeLegacyRoute, decodeNavHandle, decodeNavHandlePath, decodeNavHandleRoot, decodePath, decodeQueryHandle, handleRouteShaped, encodeDest, encodeDestLegacy, encodeNavHandle, isEngineAsset, isEnginePath, isOpaqueUrl, isWorkerDestination, legacyRouteShaped, looksKeyedToken, NAVH, NAVH_TTL_MS, NAVQ_PARAM, passChallengeRedirFixed, queryHandlePathShaped, queryHandleToken, recoverPath, referrerDest, setRouteKeys, setScheme, unwrapDest, currentPrefix, restoreLeadingSlashes } from "./codec";

import { decodeBody, mapLocationHeader, mapRefreshHeader, stripHostile, utf8ContentType } from "./headers";
import { parseKdl } from "./kdl";
import { applyExperimentalCsp } from "./csp-translation";
import { cspClearClient, cspGate, cspSetClient, engineCspMarker, newCspRegistry, planEngineCsp } from "./csp-enforce";
import { experimentalEnabled } from "./experimental-flags";
import { loadRouteHistory, saveRouteKey } from "./routekey";
import { classifyForeign, preflightHeaders } from "./foreign";
import { NAV, NAVP } from "./bootstrap/navguard";

import { planRange, ZL_RANGE_MAX } from "./range";
import { applyEngineCors } from "./cors";
import { classifyFailure, errorPage, type ErrorCategory } from "./errorpage";
import { rewriteModuleWorkerImports } from "./worker-imports";
import { decideTransport, isCdnCgiUrl, planJsServeOutcome, planResponseTransit, reasonOf, sniffsAsHtml, transitRecord, relayRecord, wispRecord, DOC_DESTS, JS_TRANSFORM_DESTS, isChallengeMitigated, type TransitDecision } from "./transit";
import { loadPolicy, behaviorMatch, transportMatch, type CompiledPolicy } from "./policy";
import { relayAvailable, relayFetch, requestRelayReRegister } from "./relayfetch";
import { boundedBody, cssRewriteStream, isCss, isHtml, isJs, originPinningRelaxed, passthroughStream, rawFrom, rewriteJsBody, rewriteStream, scriptPinsOrigins, workerPrelude } from "./transform";
import { ruleFor, siteRules } from "./siteconfig";
import { applyOnRequest, applyOnResponse } from "./plugins";
import { applyRules, loadRules, siteUaFor, type GhosteryRedirect, type ResourceType } from "./rules";
import { ghosteryLoadInProgress } from "./ghostery";
import { ghosteryCosmeticsForDocument } from "./cosmetics";
import { runRequestInterception, runResponseInterception, BODY_LIMIT, type InterceptKind } from "./intercept";
import { DIAG, classifyStageFailure, type DiagStage } from "./diag";
/* #451: per-attempt CAPTCHA tracing rides the existing CHALLENGE emit
   points below; no new interception logic. */
import { CAPTCHA_TRACE, outcomeOf } from "./captcha-trace";
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
import { GUEST_FETCH_BODY_MAX, guestDispatchFetchForUrl, guestWireClients, guestWireFetch } from "./kernel/guests/executor";

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
import { assetBaseCount, isFlagSurgeryPath, isRecoverableAssetDest, isRecoverableAssetPath, recordAssetBase, recoverFlatAsset, recordScriptUrl, recoverFlagSurgeryScript, type FlatFetch } from "./assetbases";
import { anySessionProfileActive, applySetCookie, cookieHeaderFor, flushJarPersist, inheritJarClient, isPassChallenge, jarClientHasRoot, jarHeaders, jarProfilesReady, jarProfileState, markJarClientUnbound, pruneJarClients, type CookieRequestContext } from "./cookies";
/* #87: the shared service-worker runtime state (per-client virtual
   contexts, route-shape toggles, route key, fingerprint profile +
   per-site profile cache) lives in ./swstate; the engine and the
   control plane are call sites. */
import { destUpgraded, getFpProfile, getFpWorkerScript, httpExemptAdd, httpExemptHas, isHttpsUpgrade, navHandlesEnabled, adaptiveTransitEnabled, pushDocCookieView, queryRoutesEnabled, reloadBypassArmed, setAdaptiveTransit, setHttpsUpgrade, setNavHandles, setQueryRoutes, setReloadBypass, setRouteKey, siteDisabled, replayBodyCapBytes, siteProfileFor, spoolUploadsEnabled, setStrictOpacity, strictOpacityEnabled, VCTX, ZEOLITE_VERSION } from "./swstate";
import { newSriRegistry, SRI_VERIFY_BYTE_CAP, sriBlockedResponse, sriClearClient, sriExpectation, sriNote, sriVerifyBytes } from "./sri";
import { newImportmapRegistry, importmapNote, importmapReset, resolveBareImportFor, pageKeyOf } from "./importmaps";

/* #531 SRI: engine-side subresource integrity registry. Memory-only by
   design (like VCTX): expectations bind a document client to the
   integrity attributes its HTML carried, and a worker restart
   simply forgets them (page reload repopulates). */
const SRI = newSriRegistry();
/* #527: per-client engine-side CSP plans. The same memory-only
   lifecycle as SRI: plans exist solely in the live worker and are
   rebuilt from the upstream CSP header on every navigation. */
const CSPREG = newCspRegistry();
/* #554: per-page import maps recorded from served documents (see
   importmaps.ts); module-worker serve seams resolve bare specifiers
   through the recorded map of the owning page. */
const MAPS = newImportmapRegistry();
import { classifyServeFailure, literalPassDemotion, noteDemotionServed, recordBodyPassFailure, recordJsServeOutcome, recordServeFailure } from "./adaptive-evidence";
import { spoolBody, SpoolHandle, SpoolUnavailableError } from "./bodyspool";

import { CS_ROUTE, EXT_ROUTE, WEBNAV, WEBREQ, wrType, extensions, resolveContentScripts, rootedPageGrant, serveExtensionAsset, serveRootedExtPage, DNR } from "./extensions";


declare const self: ServiceWorkerGlobalScope;

/* #82: sw.ts injects the worker's boot promise (netLog generation
   stamp, jar restore, download registry restore, extension startup)
   once it defines it; the engine awaits it at exactly the points the
   old handler did. A null-tolerant seam: the entrypoint always
   injects before any fetch event can arrive. */
let engineReady: Promise<void> | null = null;
let coldStartTimingRecorded = false;

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

/* #532: deliver the effective document base to the owning page as a
   zl:vbase control message (the HOSTLESS form, the same #144
   relaxation as vpath; the virtual location view serves it as
   __zl.baseURI). Best-effort and bounded: a page that never
   receives it keeps the honest fallback (the virtual document
   URL, the spec default without a base element). */
function pushVbase(clientId: string, resultingClientId: string, vbase: string): void {
  const id = resultingClientId || clientId;
  if (!id) return;
  void (async () => {
    try {
      const client = await raceBoot(self.clients.get(id), "vbase client lookup", PRE_DEADLINE_BOUND_MS);
      client?.postMessage({ type: "zl:vbase", vbase });
    } catch {
      /* no client: the page keeps the fallback view */
    }
  })();
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
   honors Cache-Control. Entry count and total retained bytes are bounded;
   a small metadata bucket tracks size and last-use time without
   rewriting cached response bodies on every hit. */


const ZL_PAGES = "zeolite-pages-v2";
const ZL_PAGE_INDEX = "zeolite-pages-index-v1";
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
const ZL_PAGE_BYTES = "x-zl-page-bytes";
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
  out.delete(ZL_PAGE_BYTES);
  out.delete(ZL_FINAL_URL);
  out.delete(ZL_VARY);
  out.delete(ZL_VARY_VALUES);
  return out;
}
const ZL_DEFAULT_TTL = 10 * 60 * 1000;
const ZL_PAGE_LIMIT = 60;
const ZL_PAGE_TOTAL_MAX = 32 * 1024 * 1024;
const ZL_PAGE_STORE_MAX = 4 * 1024 * 1024;
type PageCacheUsage = { bytes: number; lastUsed: number };
const pageCacheUsage = new Map<string, PageCacheUsage>();
let pageCacheReservedBytes = 0;
let pageCacheMutation: Promise<void> = Promise.resolve();
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

function storedVaryFields(headers?: Headers): string[] {
  return (headers?.get(ZL_VARY) ?? "").split(",").map((field) => field.trim().toLowerCase()).filter(Boolean);
}

function pageCacheIdentity(req: Request, fields: string[]): string {
  return JSON.stringify([req.url, fields, fields.map((field) => req.headers.get(field))]);
}

function withPageCacheMutation<T>(work: () => Promise<T>): Promise<T> {
  const next = pageCacheMutation.then(work);
  pageCacheMutation = next.then(() => undefined, () => undefined);
  return next;
}

async function pageCacheIndex(pageCache: Cache): Promise<Cache | null> {
  try {
    /* Full CacheStorage has keys(). Minimal host/test shims sometimes
       expose only open() and alias all names to one backing map. In that
       degraded environment, retain size metadata on the page entry and
       use its stored timestamp as FIFO fallback instead of polluting it. */
    if (typeof caches.keys !== "function") return null;
    const index = await caches.open(ZL_PAGE_INDEX);
    return index === pageCache ? null : index;
  } catch {
    return null;
  }
}

function validPageCacheUsage(value: unknown): value is PageCacheUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as { bytes?: unknown; lastUsed?: unknown };
  return typeof usage.bytes === "number" && Number.isSafeInteger(usage.bytes) &&
    usage.bytes >= 0 && usage.bytes <= ZL_PAGE_STORE_MAX &&
    typeof usage.lastUsed === "number" && Number.isFinite(usage.lastUsed) && usage.lastUsed >= 0;
}

async function writePageCacheUsage(req: Request, index: Cache | null, fields: string[], usage: PageCacheUsage): Promise<void> {
  /* Keep exact in-memory accounting even when a minimal CacheStorage
     host has no separate persistent metadata cache. */
  pageCacheUsage.set(pageCacheIdentity(req, fields), usage);
  if (!index) return;
  const headers = new Headers({ "content-type": "application/json" });
  if (fields.length) headers.set("vary", fields.join(", "));
  try {
    await index.put(req, new Response(JSON.stringify(usage), { headers }));
  } catch {
    /* The page entry carries a conservative byte estimate as restart fallback. */
  }
}

async function pageCacheUsageFor(req: Request, cache: Cache, index: Cache | null, knownEntry?: Response): Promise<{ identity: string; fields: string[]; usage: PageCacheUsage }> {
  let entry = knownEntry;
  if (!entry) {
    try { entry = await cache.match(req) ?? undefined; } catch { /* account conservatively */ }
  }
  const fields = (entry?.headers.get(ZL_VARY) ?? "").split(",").map((field) => field.trim().toLowerCase()).filter(Boolean);
  const identity = pageCacheIdentity(req, fields);
  const memory = pageCacheUsage.get(identity);
  if (memory) return { identity, fields, usage: memory };
  if (index) {
    try {
      const metadata = await index.match(req);
      if (metadata) {
        const value: unknown = await metadata.json();
        if (validPageCacheUsage(value)) {
          pageCacheUsage.set(identity, value);
          return { identity, fields, usage: value };
        }
      }
    } catch {
      /* Rebuild invalid or missing metadata from the page entry. */
    }
  }
  const rawBytes = entry?.headers.get(ZL_PAGE_BYTES) ?? entry?.headers.get("content-length");
  const declared = rawBytes !== null && rawBytes !== undefined && /^\d+$/.test(rawBytes) ? Number(rawBytes) : NaN;
  const cachedAt = Number(entry?.headers.get(ZL_CACHED_AT) ?? 0);
  const usage = {
    bytes: Number.isSafeInteger(declared) && declared >= 0 && declared <= ZL_PAGE_STORE_MAX ? declared : ZL_PAGE_STORE_MAX,
    lastUsed: Number.isFinite(cachedAt) && cachedAt > 0 ? cachedAt : 0,
  };
  await writePageCacheUsage(req, index, fields, usage);
  return { identity, fields, usage };
}

function touchPageCache(req: Request, hit: Response, cache: Cache): void {
  void withPageCacheMutation(async () => {
    const index = await pageCacheIndex(cache);
    const old = await pageCacheUsageFor(req, cache, index, hit);
    await writePageCacheUsage(req, index, old.fields, { ...old.usage, lastUsed: Date.now() });
  }).catch(() => {});
}

function disablePageCacheAfterEvictionFailure(): void {
  pageCacheDisabled = true;
  if (pageCacheTrimWarned) return;
  pageCacheTrimWarned = true;
  DIAG.emit({
    category: "STORAGE",
    severity: "warning",
    message: "page cache capacity could not be maintained; storing disabled until the worker restarts",
  });
}

async function deletePageCacheEntry(req: Request, cache: Cache, index: Cache | null, identity: string): Promise<void> {
  await withPageCacheMutation(async () => {
    let removed = false;
    try { removed = await cache.delete(req); } catch { /* fail closed below */ }
    if (!removed) {
      disablePageCacheAfterEvictionFailure();
      return;
    }
    if (index) {
      try {
        const metadata = await index.match(req);
        if (metadata && !(await index.delete(req))) {
          disablePageCacheAfterEvictionFailure();
          return;
        }
      } catch {
        disablePageCacheAfterEvictionFailure();
        return;
      }
    }
    pageCacheUsage.delete(identity);
  });
}

async function reservePageCacheSpace(req: Request, cache: Cache, index: Cache | null, fields: string[], bytes: number): Promise<boolean> {
  return withPageCacheMutation(async () => {
    if (pageCacheDisabled) return false;
    const keys = await cache.keys();
    const rows = await Promise.all(keys.map(async (key) => ({ key, ...(await pageCacheUsageFor(key, cache, index)) })));
    const identity = pageCacheIdentity(req, fields);
    const candidates = rows.filter((row) => row.identity !== identity)
      .sort((a, b) => a.usage.lastUsed - b.usage.lastUsed || a.key.url.localeCompare(b.key.url));
    let count = candidates.length;
    let totalBytes = pageCacheReservedBytes + bytes + candidates.reduce((total, row) => total + row.usage.bytes, 0);
    while (count + 1 > ZL_PAGE_LIMIT || totalBytes > ZL_PAGE_TOTAL_MAX) {
      const victim = candidates.shift();
      if (!victim) return false;
      let removed = false;
      try { removed = await cache.delete(victim.key); } catch { /* fail closed below */ }
      if (!removed) {
        disablePageCacheAfterEvictionFailure();
        return false;
      }
      if (index) {
        try {
          const metadata = await index.match(victim.key);
          if (metadata && !(await index.delete(victim.key))) {
            disablePageCacheAfterEvictionFailure();
            return false;
          }
        } catch {
          disablePageCacheAfterEvictionFailure();
          return false;
        }
      }
      pageCacheUsage.delete(victim.identity);
      count--;
      totalBytes -= victim.usage.bytes;
    }
    pageCacheReservedBytes += bytes;
    return true;
  });
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
  let cache: Cache;
  try {
    cache = await caches.open(ZL_PAGES);
    hit = await cache.match(req) ?? undefined;
  } catch {
    return null;
  }
  if (!hit) return null;
  /* #557: a Vary entry serves only the request header values it was
     stored with; anything else is an honest miss that bypasses to the
     live path. */
  if (!varyMatches(hit.headers, req.headers)) return null;
  touchPageCache(req, hit, cache);
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
      const index = await pageCacheIndex(cache);
      await deletePageCacheEntry(req, cache, index, pageCacheIdentity(req, storedVaryFields(hit.headers)));
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
            const index = await pageCacheIndex(cache);
            await deletePageCacheEntry(req, cache, index, pageCacheIdentity(req, storedVaryFields(hit.headers)));
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
  const lengthHeader = resp.headers.get("content-length");
  const declaredBytes = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (declaredBytes !== null && declaredBytes > ZL_PAGE_STORE_MAX) return null;
  const reserveBytes = declaredBytes ?? ZL_PAGE_STORE_MAX;
  let reserved = false;
  let oversized = false;
  try {
    const cache = await caches.open(ZL_PAGES);
    const index = await pageCacheIndex(cache);
    const storedHeaders = stripHostile(resp.headers);
    applyEngineCors(storedHeaders, self.location.origin, req.credentials);
    const cu = new URL(req.url);
    const croute = decodePath(cu.pathname);
    mapRefreshHeader(storedHeaders, croute ? mergeRouteSearch(croute, cu.search) : cu.href);
    const fields = varyFields(resp.headers);
    storeVaryMeta(storedHeaders, fields, req.headers);
    if (!(await reservePageCacheSpace(req, cache, index, fields, reserveBytes))) return null;
    reserved = true;
    /* #115 revalidation serves the original stream. Meter a clone so an
       oversized cache branch cannot error the live response branch. */
    const cacheSource = keepView ? resp.clone() : resp;
    let bodyBytes = 0;
    const body = cacheSource.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bodyBytes += chunk.byteLength;
        if (bodyBytes > ZL_PAGE_STORE_MAX || bodyBytes > reserveBytes) {
          oversized = true;
          throw new RangeError("page cache body exceeded its byte budget");
        }
        controller.enqueue(chunk);
      },
    })) ?? null;
    const stored = new Response(body, { status: 200, headers: storedHeaders });
    stored.headers.set(ZL_CACHED_AT, String(Date.now()));
    stored.headers.set(ZL_PAGE_BYTES, String(reserveBytes));
    if (finalUrl) stored.headers.set(ZL_FINAL_URL, finalUrl);
    await cache.put(req, stored);
    await writePageCacheUsage(req, index, fields, { bytes: bodyBytes, lastUsed: Date.now() });
    /* #632: the keepView fork serves the page, so the internal
       bookkeeping headers (#338) must be stripped from the served copy
       while the stored entry keeps them. */
    return keepView ? new Response(resp.body, { status: 200, headers: stripInternalHeaders(storedHeaders) }) : stored;
  } catch {
    if (oversized) return null;
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
  } finally {
    if (reserved) pageCacheReservedBytes = Math.max(0, pageCacheReservedBytes - reserveBytes);
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
    never a corrupted body. #556: with hopReplay and the spool
    authorized (default-on; zl:config spoolUploads is the opt-out),
    the body is staged to the bounded OPFS spool instead of memory -
    spoolUnavailable before the first byte keeps the documented
    one-shot/memory paths with an explicit DIAG event. */
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
         the OPFS spool (default-on; zl:config spoolUploads false
         opts out) instead of surfacing the redirect to the page. */
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
       the spool is authorized (default-on since the #556 follow-up;
       zl:config spoolUploads false opts out): even a chunked upload
       becomes replayable without a memory copy, and the spool cap (not
       the 32 MiB memory cap) bounds it. */
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
  /* #577: isolated = fail without touching the shared client (the
     ghostery list load). */
  isolated = false,
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
  return wispTransport.fetch(dest, init, traceId, { isolated });
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
    upstreamFetch(dest, { method, headers }, policy, "fetch", DIAG.trace(), true),
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

/* #596: the guest clients facade enumerates the engine's real
   virtual-page contexts (VCTX) through this provider: the kernel
   answers clients.matchAll()/get() from it. Worker-kind clients are
   approximated from the establishing request's destination
   (documented in docs/virtual-service-worker-phase2.md). */
guestWireClients(() =>
  [...VCTX.values()].map((c) => ({ id: c.id, url: c.currentUrl, kind: c.clientKind ?? "window" })),
);

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
    const index = await pageCacheIndex(cache);
    await withPageCacheMutation(async () => {
      for (const k of await cache.keys()) await cache.delete(k);
      if (index) for (const k of await index.keys()) await index.delete(k);
      pageCacheUsage.clear();
    });
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
