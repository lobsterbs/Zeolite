/* Zeolite service worker: interception + header surgery + streaming
   rewriter + wisp transport + SiteConfig rules + plugin hooks + the
   network inspector's log.

   URL shape: engine-local routes under a configurable prefix (default
   /j/, rotatable at runtime via an zl:config message). Requests that
   are engine assets (sw.js, bootstrap.js, devtools.html, ...) or the
   wisp endpoint pass through untouched. All prefix/scheme decisions go
   through ./codec helpers (bug-scout fix: "/j/" was previously hard
   -coded here while decoding used the rotated prefix).

   Phase 2 control plane (postMessage from the engine adapter):
     { type: "zl:config", prefix, scheme }   rotate the URL shape
     { type: "zl:siteRoute", site, enabled } per-site interception toggle
     { type: "zl:teardown" }                 unregister + drop caches
   Phase 4 control plane:
     { type: "zl:getNetLog" }                snapshot of the request log
   Replies are posted back on the given MessageChannel port, so the
   adapter (and the devtools page) get real acknowledgements.

   The rewriter wasm (wasm-bindgen output of crates/rewriter) is emitted
   by the build pipeline to src/rewriter_wasm/ (see workflow:
   wasm-pack build --target web -> copy into app/src/rewriter_wasm). */

/// <reference lib="webworker" />
import { decodePath, isEnginePath, setScheme, currentPrefix } from "./codec";
import { decideTransport, refineWithContent, transitRecord, transitStats } from "./transit";
import { ZL_WISP_URL } from "./config";
import { ruleFor, siteRules } from "./siteconfig";
import { applyOnRequest, applyOnResponse } from "./plugins";
import { DIAG } from "./diag";
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
  PERMS,
  bootEnabled,
  tabView,
  contentScriptMatches,
  extensions,
  getExtensionContext,
  resolveContentScripts,
  serveExtensionAsset,
} from "./extensions";
import type { ExtensionStorageArea } from "./extensions/storage";
import type { UiTab } from "./extensions/tabs";

declare const self: ServiceWorkerGlobalScope;

/* ---- HTTP over wisp ----------------------------------------------- */
/* Phase 1: libcurl wasm transport (BareMux-compatible), the same proven
   TLS-termination path Scramjet uses. Vendored build replaces
   src/libcurl-transport-vendored.ts; until then calls throw and the
   suite records transport-missing. */

let curlReady: Promise<void> | null = null;
async function ensureCurl(): Promise<void> {
  if (!curlReady) {
    curlReady = (async () => {
      const mod = await import("./libcurl-transport-vendored");
      await mod.init({ websocket: ZL_WISP_URL });
    })();
  }
  return curlReady;
}

async function wispFetch(dest: string, init?: RequestInit): Promise<Response> {
  await ensureCurl();
  const mod = await import("./libcurl-transport-vendored");
  return mod.fetch(dest, init);
}

/* ---- Header surgery ------------------------------------------------ */

const HOSTILE = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
];

function stripHostile(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!HOSTILE.includes(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/* ---- Streaming rewriter wiring ------------------------------------- */

interface JsRewriter {
  process(chunk: string): string;
  finish(): string;
  add_injection(path: string): void;
  set_blocked_hosts(hosts: string[]): void;
}
interface RewriterMod {
  JsRewriter: new (origin: string, base: string, prefix: string) => JsRewriter;
  rewriteCss(css: string, origin: string, base: string, prefix: string): string;
}
let rewriterMod: Promise<RewriterMod> | null = null;
function rewriter(): Promise<RewriterMod> {
  if (!rewriterMod) rewriterMod = import("./rewriter_wasm/rewriter_wasm.js");
  return rewriterMod;
}

function isHtml(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}
function isCss(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/css");
}

/** HTML bodies: pipe response chunks through the wasm rewriter. The
    bootstrap needs the page's real destination on window.__ZL, so we
    emit a tiny inline script before the first rewritten chunk.
    SiteConfig per-site rules are applied to this rewriter instance:
    injections (Phase 3 hooks) and blocked hosts (ad stripping). */
function rewriteStream(
  body: ReadableStream<Uint8Array>,
  base: string,
  rule: { inject?: string[]; block?: string[] },
  csInject: string[],
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const modP = rewriter();
  const ljInit = `<script>window.__ZL=${JSON.stringify({ dest: base })};</script>`;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(ljInit));
      const mod = await modP;
      const rw = new mod.JsRewriter(self.location.origin, base, currentPrefix());
      for (const path of rule.inject ?? []) rw.add_injection(path);
      if (rule.block?.length) rw.set_blocked_hosts(rule.block);
      for (const u of csInject) rw.add_injection(u);
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = rw.finish();
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            onDone?.();
            return;
          }
          const out = rw.process(decoder.decode(value, { stream: true }));
          if (out) controller.enqueue(encoder.encode(out));
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/* ---- Network inspector log (Phase 4) -------------------------------- */
/* Fixed-size ring buffer of proxied requests. The devtools page polls
   zl:getNetLog; a snapshot plus a monotonically increasing sequence
   lets it drop entries it has already seen. */

export interface NetEntry {
  seq: number;
  ts: number;
  method: string;
  /** Engine-local request path. */
  path: string;
  /** Real destination URL. */
  dest: string;
  status: number;
  /** Time until response headers (TTFB through the wisp hop), ms. */
  ms: number;
  /** Response body size: content-length when present, else -1. */
  bytes: number;
  /** Plugin verdict from the onRequest hooks, when any plugin ran. */
  verdict?: string;
  /** Resource type classification (DOCUMENT/SCRIPT/STYLE/...). fetch()
      and XHR are not distinguishable without initiator info, so both
      are reported as FETCH rather than guessed apart. */
  rtype: string;
  /** Rewrite applied to this response, when any: "html" | "css". */
  rewritten?: string;
  err?: string;
  /** Diagnostics trace identifier, joinable with zl:getDiag events. */
  traceId?: string;
  /** Transport mode decision (NativeTransit Alpha / RewriteFallback). */
  transport?: "NativeTransit" | "RewriteFallback";
  /** Machine-readable reason when the decision was RewriteFallback. */
  fallbackReason?: string;
  /** Final destination after redirects, when the transport exposed it. */
  finalDest?: string;
}

const NET_LIMIT = 256;
const netLog: NetEntry[] = [];
let netSeq = 0;

function netLogPush(entry: Omit<NetEntry, "seq" | "ts">): void {
  netLog.push({ ...entry, seq: ++netSeq, ts: Date.now() });
  if (netLog.length > NET_LIMIT) netLog.shift();
}

/* ---- Page cache (ported from the v3 worker) -------------------- */
/* Cache-first for proxied GETs with stale-while-revalidate. Freshness
   honors Cache-Control: max-age when present (no-store skips the cache
   entirely); the fallback TTL is 10 minutes. 60-entry cap, FIFO
   eviction. x-zl-cached-at carries the stored-at time. */

export const ZEOLITE_VERSION = "1.0 Nitride";
console.info("[Zeolite] runtime " + ZEOLITE_VERSION);

const ZL_PAGES = "zeolite-pages-v1";
const ZL_CACHED_AT = "x-zl-cached-at";
const ZL_DEFAULT_TTL = 10 * 60 * 1000;
const ZL_PAGE_LIMIT = 60;

function cacheTtl(headers: Headers): number {
  const cc = (headers.get("cache-control") ?? "").toLowerCase();
  if (/no-store/.test(cc)) return 0;
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
  if (Date.now() - at < ttl) return hit;
  /* Stale: serve it now, refresh in the background. */
  try {
    const fresh = await wispFetchCacheBypass(req);
    if (fresh.ok) await pageCacheStore(req, fresh);
  } catch {
    /* offline: the stale copy stays served */
  }
  return hit;
}

async function pageCacheStore(req: Request, resp: Response): Promise<void> {
  const ttl = cacheTtl(resp.headers);
  if (!ttl || resp.status !== 200) return;
  try {
    const cache = await caches.open(ZL_PAGES);
    const stored = new Response(resp.body, { status: 200, headers: resp.headers });
    stored.headers.set(ZL_CACHED_AT, String(Date.now()));
    await cache.put(req, stored);
    let keys = await cache.keys();
    while (keys.length > ZL_PAGE_LIMIT) {
      await cache.delete(keys[0]);
      keys = keys.slice(1);
    }
  } catch {
    /* storage full or unavailable: skip caching */
  }
}

/** Re-fetch a cached request straight through the wisp transport. */
async function wispFetchCacheBypass(req: Request): Promise<Response> {
  const dest = decodePath(new URL(req.url).pathname) + new URL(req.url).search;
  return wispFetch(dest, { method: "GET", redirect: "follow" });
}

/* ---- Per-site route table ------------------------------------------ */

/** Sites the user disabled for this engine. Keyed by registrable-ish
    host suffix (match on hostname or any parent domain). */
const disabledSites = new Set<string>();

function siteDisabled(target: string): boolean {
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return false;
  }
  for (const site of disabledSites) {
    if (host === site || host.endsWith("." + site)) return true;
  }
  return false;
}

/* ---- Fetch interception -------------------------------------------- */

/** Classify a request by sec-fetch-dest plus response content-type.
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
  void rewriter().catch(() => undefined);
});

let netGeneration = 0;

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      await self.clients.claim();
      /* Warm the transport so the first proxied request skips libcurl
         init. A missing vendored build just logs, as before. */
      netGeneration++;
      try {
        await ensureCurl();
      } catch {
        /* transport-missing: the suite records it, as before */
      }
      /* Extensions: load the installed set, then boot enabled
         background scripts. Any failure lands in that extension's
         record; the engine itself never fails because of one. */
      try {
        await extensions.startup();
        await bootEnabled();
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
      /* Advanced permissions: request/remove run through the manager
         so grants persist and the master record stays authoritative. */
      PERMS.setBackend(async (id, op, perms) => {
        const rec =
          op === "grant"
            ? await extensions.grantOptional(id, perms)
            : await extensions.revokeOptional(id, perms);
        return rec ? { permissions: [...rec.permissions], origins: [...rec.hostPermissions] } : null;
      });
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
  const dest = (req.headers.get("sec-fetch-dest") ?? "").toLowerCase();
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

self.addEventListener("fetch", (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // not ours: browser handles it
  if (url.pathname.startsWith("/wisp/")) return; // transport endpoint: passthrough
  /* Extension routes: web-accessible resources (/zl-ext/) and the
     content-script bridge + declared script files (/zl-cs/). */
  if (url.pathname.startsWith(EXT_ROUTE) || url.pathname.startsWith(CS_ROUTE)) {
    e.respondWith(
      serveExtensionAsset(e.request, url).catch(
        (err) =>
          new Response("zeolite: extension asset failed: " + String(err), {
            status: 500,
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    return;
  }
  if (!isEnginePath(url.pathname)) return; // engine asset: passthrough

  const dest = decodePath(url.pathname);
  if (!dest) {
    e.respondWith(new Response("zeolite: bad route", { status: 404 }));
    return;
  }
  // Query string travels outside the encoded destination.
  const target = url.search ? dest + url.search : dest;

  if (siteDisabled(target)) {
    e.respondWith(
      new Response("zeolite: site disabled for this engine", {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
    );
    return;
  }

  e.respondWith(
    (async () => {
      const t0 = Date.now();
      const traceId = DIAG.trace();
      DIAG.stage(traceId, "REQUEST_INTERCEPTED", { url: target });
      /* NativeTransit decision: pre-fetch classification from the
         destination scheme + sec-fetch-dest; refined with the actual
         content type once the response arrives. */
      const decision = decideTransport(target, e.request.headers.get("sec-fetch-dest") ?? "");
      /* webNavigation.onBeforeNavigate: navigation-mode requests
         report the interception itself, before any cache or upstream
         work. */
      if (e.request.mode === "navigate") WEBNAV.beforeNavigate(target);
      /* Shared webRequest details for every hook below. */
      const wrDetails = {
        requestId: traceId,
        url: target,
        method: e.request.method,
        type: wrType(e.request.headers.get("sec-fetch-dest") ?? ""),
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
        transitRecord(traceId, target, decision);
        netLogPush({
          method: e.request.method, traceId,
          path: url.pathname + url.search,
          dest: target,
          status: 403,
          rtype: classifyRtype(e.request.headers.get("sec-fetch-dest") ?? "", ""),
          ms: Date.now() - t0,
          bytes: -1,
          verdict: "blocked",
          transport: decision.mode,
          fallbackReason: decision.fallbackReason,
        });
        return new Response("zeolite: request blocked by extension", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }
      /* Cache-first for proxied GETs. */
      if (e.request.method === "GET") {
        const hit = await pageCacheMatch(e.request);
        if (hit) {
          const dec = refineWithContent(decision, hit.headers.get("content-type") ?? "");
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
            path: url.pathname + url.search,
            dest: target,
            status: hit.status,
            rtype: classifyRtype(
              e.request.headers.get("sec-fetch-dest") ?? "",
              hit.headers.get("content-type") ?? "",
            ),
            ms: Date.now() - t0,
            bytes: Number(hit.headers.get("content-length") ?? -1),
            verdict: "cache",
            transport: dec.mode,
            fallbackReason: dec.fallbackReason,
          });
          WEBREQ.completed({ ...wrDetails, statusCode: hit.status });
          return hit;
        }
      }
      const rules = await siteRules();
      const rule = ruleFor(rules, target);
      const plugins = rule.plugins;
      try {
        DIAG.stage(traceId, "UPSTREAM_REQUEST", { url: target });
        const fwd = forwardedHeaders(e.request);
        /* webRequest.onBeforeSendHeaders: blocking listeners may
           replace the outgoing header set (validated pairs only). */
        const replaced = WEBREQ.beforeSendHeaders(wrDetails, fwd);
        const sendHeaders = replaced ?? fwd;
        await applyOnRequest(plugins, target, sendHeaders);
        const resp = await wispFetch(target, {
          method: e.request.method,
          headers: sendHeaders,
          body: ["GET", "HEAD"].includes(e.request.method) ? undefined : e.request.body,
          redirect: "follow",
        });
        DIAG.stage(traceId, "UPSTREAM_RESPONSE", { url: target, message: "upstream status " + resp.status });
        /* Stage E: when the transport exposes the final URL, record the
           logical destination after the redirect chain. */
        const finalUrl = typeof resp.url === "string" ? resp.url : "";
        const finalDest = finalUrl && finalUrl !== target ? finalUrl : undefined;
        if (finalDest) {
          DIAG.stage(traceId, "REDIRECTED", { url: target, message: "final destination " + finalDest });
        }
        const headers = stripHostile(resp.headers);
        /* webRequest.onHeadersReceived: blocking listeners may replace
           the response header set the page will see. */
        const rHeaders = WEBREQ.headersReceived({ ...wrDetails, statusCode: resp.status }, headers);
        const outHeaders = rHeaders ?? headers;
        outHeaders.set("x-zl-proxy", "1");
        void applyOnResponse(plugins, target, resp.status, outHeaders);
        const dec = refineWithContent(decision, resp.headers.get("content-type") ?? "");
        transitRecord(traceId, target, dec);
        netLogPush({
          method: e.request.method, traceId,
          path: url.pathname + url.search,
          dest: target,
          status: resp.status,
          ms: Date.now() - t0,
          bytes: Number(resp.headers.get("content-length") ?? -1),
          verdict: plugins?.length ? "pass:" + plugins.length : undefined,
          rtype: classifyRtype(
            e.request.headers.get("sec-fetch-dest") ?? "",
            resp.headers.get("content-type") ?? "",
          ),
          rewritten: isHtml(resp) ? "html" : isCss(resp) ? "css" : undefined,
          transport: dec.mode,
          fallbackReason: dec.fallbackReason,
          finalDest,
        });
        if (e.request.method === "GET") void pageCacheStore(e.request, resp.clone());
        if (isHtml(resp) && resp.body) {
          DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "html rewrite stream wired" });
          /* Main-frame document loads feed the webNavigation bridge;
             subresource fetches do not arrive in navigate mode. */
          if (e.request.mode === "navigate") WEBNAV.committed(target);
          const csInject = csInjectUrls(target, e.request);
          return new Response(
            rewriteStream(resp.body, target, rule, csInject, () => {
              /* webNavigation.onCompleted + webRequest.onCompleted:
                 the document stream (and with it the navigation) is
                 done. */
              WEBNAV.completed(target);
              WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
            }),
            {
              status: resp.status,
              headers: outHeaders,
            },
          );
        }
        if (isCss(resp) && resp.body) {
          // Standalone stylesheets: one-shot url() pass through the
          // rewriter module. Small bodies, not first-paint documents.
          DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "css rewrite" });
          const mod = await rewriter();
          const css = await resp.text();
          const out = mod.rewriteCss(css, self.location.origin, target, currentPrefix());
          DIAG.stage(traceId, "REWRITE_COMPLETED", { url: target, category: "REWRITE" });
          WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
          return new Response(out, { status: resp.status, headers: outHeaders });
        }
        WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
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
        WEBREQ.errorOccurred(wrDetails, String(err));
        transitRecord(traceId, target, decision);
        netLogPush({
          method: e.request.method, traceId,
          path: url.pathname + url.search,
          dest: target,
          status: 0,
          rtype: classifyRtype(e.request.headers.get("sec-fetch-dest") ?? "", ""),
          ms: Date.now() - t0,
          bytes: -1,
          err: String(err),
          transport: decision.mode,
          fallbackReason: decision.fallbackReason,
        });
        return new Response(`zeolite: upstream fetch failed: ${String(err)}`, {
          status: 502,
          headers: { "content-type": "text/plain" },
        });
      }
    })(),
  );
});

/** Per-request header surgery: drop hop-by-hop + engine-origin leaks,
    restore the real destination as Referer. */
function forwardedHeaders(req: Request): Headers {
  const out = new Headers();
  const skip = new Set(["host", "connection", "referer", "origin"]);
  for (const [k, v] of req.headers) {
    if (!skip.has(k.toLowerCase())) out.set(k, v);
  }
  if (req.referrer) {
    const ref = decodePath(new URL(req.referrer, self.location.origin).pathname);
    if (ref) out.set("referer", ref);
  }
  if (!out.has("accept-language")) out.set("accept-language", "en-US,en;q=0.9");
  return out;
}

/* ---- Control plane (Phase 2 + Phase 4) ---------------------------- */

interface ControlMessage {
  type:
    | "zl:config"
    | "zl:siteRoute"
    | "zl:teardown"
    | "zl:ping"
    | "zl:getNetLog"
    | "zl:ext"
    | "zl:tabs"
    | "zl:menuClick"
    | "zl:listExt"
    | "zl:getDiag"
    | "zl:installExt"
    | "zl:installExtFiles"
    | "zl:extEnable"
    | "zl:extInfo";
  extId?: string;
  msg?: unknown;
  prefix?: string;
  scheme?: "b64u" | "mirror";
  site?: string;
  enabled?: boolean;
  /** UI -> SW authoritative tab sync payload. */
  tabs?: UiTab[];
  /** Delta sync cursor for zl:getNetLog. */
  since?: number;
  /** zl:installExt: packaged (.xpi/.zip) bytes. */
  bytes?: Uint8Array;
  /** zl:installExtFiles: unpacked directory listing, path -> bytes. */
  files?: Array<[string, Uint8Array]>;
}

self.addEventListener("message", (e: ExtendableMessageEvent) => {
  const msg = e.data as ControlMessage;
  const port = e.ports[0];
  const reply = (payload: unknown) => port?.postMessage(payload);

  switch (msg?.type) {
    case "zl:ping":
      reply({ ok: true });
      break;
    case "zl:config":
      // Rotate the URL shape at runtime.
      setScheme(msg.prefix ?? "/j/", msg.scheme ?? "b64u");
      reply({ ok: true });
      break;
    case "zl:siteRoute":
      if (!msg.site) {
        reply({ ok: false, error: "missing site" });
        break;
      }
      if (msg.enabled === false) disabledSites.add(msg.site);
      else disabledSites.delete(msg.site);
      reply({ ok: true });
      break;
    case "zl:teardown":
      e.waitUntil(
        (async () => {
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
      reply({ entries: netLog.filter((x) => x.seq > since), lastSeq: netSeq, generation: netGeneration,
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
          (r) =>
            reply({
              ok: true,
              id: r.id,
              warnings: r.warnings,
              unsupportedFields: r.unsupportedFields,
            }),
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
          (r) =>
            reply({
              ok: true,
              id: r.id,
              warnings: r.warnings,
              unsupportedFields: r.unsupportedFields,
            }),
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
            { menuItemId: info.menuItemId, pageUrl: info.pageUrl },
            tab ? tabView(rec, tab) : null,
          );
        }),
      );
      reply({ ok: true });
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

