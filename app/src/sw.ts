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
import { b64uDecode, decodePath, encodeDest, isEngineAsset, isEnginePath, isOpaqueUrl, isWorkerDestination, referrerDest, setScheme, unwrapDest, currentPrefix } from "./codec";
import { classifyForeign, preflightHeaders } from "./foreign";
import { NAV } from "./bootstrap/navguard";
import { initScript } from "./pageload";
import { planRange, ZL_RANGE_MAX } from "./range";
import { applyEngineCors } from "./cors";
import { classifyFailure, errorPage, type ErrorCategory } from "./errorpage";
import { rewriteModuleWorkerImports } from "./worker-imports";
import { decideTransport, refineWithContent, transitRecord, transitStats } from "./transit";
import { ZL_WISP_URL } from "./config";
import { ruleFor, siteRules } from "./siteconfig";
import { applyOnRequest, applyOnResponse } from "./plugins";
import { applyRules, loadRules, setRulesEnabled, setSiteOverrides, siteUaFor, type ResourceType } from "./rules";
import { runRequestInterception, runResponseInterception, BODY_LIMIT, type InterceptKind } from "./intercept";
import { DIAG, redactSecrets } from "./diag";
import { setTracing, traceDecision, tracingSnapshot } from "./tracing";
import { beginRecording, finishRecording, type RecordingState } from "./recording";
import { fetch as zlCurlFetch, init as zlCurlInit, openWebSocket } from "./libcurl-transport-vendored";
import * as rewriterWasm from "./rewriter_wasm/rewriter_wasm.js";
import { WsBridge, type PortLike } from "./wsbridge";
import { wsIdentityHeaders } from "./wsidentity";
import { senderVirtualOrigin, virtualOriginHeaders } from "./origin";
import { capContexts, contextOf, establishContext, resolveRelative, VCTX_CAP, type VirtualContext } from "./vctx";
import { applySetCookie, cookieHeaderFor, documentCookieRead, documentCookieWrite, jarClear, jarClearScope, jarEnumeration, jarHeaders, jarLoad, jarMerge, jarProfileState, jarReplace, jarSnapshot, setJarProfile, setSameSitePolicy, type CookieRequestContext, type JarConflictRule } from "./cookies";
import { DownloadTracker } from "./downloads";
import { fingerprintScript, resolveProfile, workerFingerprintScript, type FingerprintProfile } from "./fingerprint";
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

/* ---- Per-client virtual contexts (issue #33) ------------------------ */

/* Keyed by FetchEvent clientId. Serving a client's document or worker
   script from a decodable engine route establishes that client's
   context; escaped same-origin paths resolve against it before the
   referrer compat fallback. Memory-only by design: a restarted SW
   starts empty and re-establishes per client (see ./vctx.ts). */
const VCTX = new Map<string, VirtualContext>();

/* ---- HTTP over wisp ----------------------------------------------- */
/* Phase 1: libcurl wasm transport (BareMux-compatible), the same proven
   TLS-termination path ScramJet uses. The vendored bundle is loaded by
   src/libcurl-transport-vendored.ts. Both this module and the loader use
   STATIC imports only: dynamic import() is not available on
   ServiceWorkerGlobalScope in Chromium, and a dynamic import here used
   to kill every proxied fetch with a ReferenceError from vite's
   preload helper. Until the CI vendoring step runs, calls throw and
   the suite records transport-missing. */

/* Finding 5 (SW half): when a core engine component fails to
   initialize, record it once so zl:ping can report the degraded
   state instead of a bare ok:true that hides the failure. Null =
   fully operational. */
let engineDegraded: string | null = null;

let curlReady: Promise<void> | null = null;
async function ensureCurl(): Promise<void> {
  if (!curlReady) {
    curlReady = zlCurlInit({ websocket: ZL_WISP_URL }).catch((err) => {
      engineDegraded = "libcurl transport: " + String(err);
      curlReady = null; // allow retry on next request
      DIAG.emit({
        category: "TRANSPORT",
        severity: "error",
        message: "libcurl transport init failed",
        technicalReason: String(err),
        url: ZL_WISP_URL,
      });
      throw err;
    });
  }
  return curlReady;
}

async function wispFetch(dest: string, init?: RequestInit): Promise<Response> {
  await ensureCurl();
  return zlCurlFetch(dest, init);
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
  "set-cookie",
  "set-cookie2",
  /* The transport delivers decoded bodies: a preserved upstream
     content-encoding would make every fetch() consumer decode
     plaintext a second time (corrupted bytes), and the rewritten
     body never matches the upstream length. */
  "content-encoding",
  "content-length",
];

function stripHostile(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers) {
    if (!HOSTILE.includes(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/* 2.2 Arsenide: bound on SW-followed redirect hops (the transport
   surfaces 3xx; the loop follows). Past the cap the 3xx is surfaced to
   the page with a mapped Location instead of looping forever. */
const MAX_REDIRECT_HOPS = 10;

/* ---- Streaming rewriter wiring ------------------------------------- */

interface JsRewriter {
  process(chunk: string): string;
  finish(): string;
  add_injection(path: string): void;
  set_blocked_hosts(hosts: string[]): void;
}
interface JsCssRewriter {
  process(chunk: string): string;
  finish(): string;
}
interface RewriterMod {
  JsRewriter: new (origin: string, base: string, prefix: string, scheme: string) => JsRewriter;
  JsCssRewriter: new (origin: string, base: string, prefix: string, scheme: string) => JsCssRewriter;
  rewriteCss(css: string, origin: string, base: string, prefix: string, scheme: string): string;
  /* wasm-pack --target web output: `default` is the async init that
     fetches and instantiates the .wasm binary. Without it every
     JsRewriter call dies on an unbound wasm table. */
  default(path?: unknown): Promise<unknown>;
}
let rewriterMod: Promise<RewriterMod> | null = null;
function rewriter(): Promise<RewriterMod> {
  if (!rewriterMod) {
    rewriterMod = (async () => {
      const mod = rewriterWasm as unknown as RewriterMod;
      // Vite freezes the wasm-pack default URL to the origin root, which 404s
      // when the bundle is aliased under a subpath (LobsterBrowse /zlsw/).
      // Resolve the wasm URL against the SW script URL instead.
      if (typeof mod.default === "function") {
        await mod.default(new URL("rewriter_wasm_bg.wasm", self.location.href));
      }
      return mod;
    })().catch((err) => {
      engineDegraded = "rewriter wasm: " + String(err);
      rewriterMod = null; // allow retry on next response
      DIAG.emit({
        category: "REWRITE",
        severity: "error",
        message: "rewriter wasm init failed",
        technicalReason: String(err),
      });
      throw err;
    });
  }
  return rewriterMod;
}

/* 1.6 Hydride: the worker prelude asset is fetched once and cached in
   memory; the live route prefix and the upstream worker URL are baked
   into the injected first line at serve time. */
let preludeCache: string | null = null;
async function workerPrelude(): Promise<string> {
  if (preludeCache === null) {
    const r = await fetch(new URL("worker-prelude.js", self.location.href).href);
    preludeCache = await r.text();
  }
  return preludeCache;
}

function isHtml(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}
function isCss(resp: Response): boolean {
  return (resp.headers.get("content-type") ?? "").toLowerCase().includes("text/css");
}
function isJs(resp: Response): boolean {
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  return ct.includes("javascript") || ct.includes("ecmascript");
}

/** HTML bodies: pipe response chunks through the wasm rewriter. The
    bootstrap needs a per-site identity on window.__ZL (an opaque
    token since #32; the real destination never enters the page), so
    we emit a tiny inline script before the first rewritten chunk.
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
  /* Issue #32: the injected contract is { site: <opaque token> },
    computed SW-side from the destination; an active fingerprint
    profile rides the same first chunk (1.8 Telluride). */
  const ljInit = initScript(base, fpScript);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(ljInit));
      const reader = body.getReader();
      try {
        // Rewriter init and construction live inside the try: an init failure
        // (e.g. a wasm 404) used to reject outside the try and kill every fresh
        // HTML response with no diag event and no console error.
        const mod = await modP;
        const rw = new mod.JsRewriter(self.location.origin, base, currentPrefix(), "b64u"); // scheme fixed since #32 (mirror removed)
        for (const path of rule.inject ?? []) rw.add_injection(path);
        if (rule.block?.length) rw.set_blocked_hosts(rule.block);
        for (const u of csInject) rw.add_injection(u);
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
        DIAG.emit({
          category: "REWRITE",
          severity: "error",
          message: "html rewrite stream failed",
          technicalReason: String(e),
          url: base,
        });
        controller.error(e);
      }
    },
  });
}

/* 2.4 Bromide: standalone stylesheet bodies stream chunk by chunk
   through the wasm CSS rewriter (2.3 buffered the whole body for a
   one-shot pass, so large CSS delayed first paint). No window.__ZL
   init is injected here: CSS is not a document, the bootstrap never
   runs in a stylesheet context. The rewriter retains only the
   incomplete url( tail between chunks. */
function cssRewriteStream(
  body: ReadableStream<Uint8Array>,
  base: string,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const modP = rewriter();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const mod = await modP;
        const rw = new mod.JsCssRewriter(self.location.origin, base, currentPrefix(), "b64u"); // scheme fixed since #32 (mirror removed)
        const reader = body.getReader();
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
        DIAG.emit({
          category: "REWRITE",
          severity: "error",
          message: "css rewrite stream failed",
          technicalReason: String(e),
          url: base,
        });
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
  /** Engine-local request path (the full URL for foreign-origin
      requests the engine routes, #34). */
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
  /** Transport mode decision (NativeTransit Alpha / RewriteFallback), or
      "browser" for a cross-origin passthrough the engine declines
      (issue #30: escape telemetry, not proxied traffic), or "engine"
      for an engine-answered request that never touched the transport
      (the #34 CORS preflight). */
  transport?: "NativeTransit" | "RewriteFallback" | "browser" | "engine";
  /** Machine-readable reason when the decision was RewriteFallback. */
  fallbackReason?: string;
  /** Final destination after redirects, when the transport exposed it. */
  finalDest?: string;
  /** Inspector detail record (1.2 Halide), for the detail view. */
  detail?: NetDetail;
}

/** Per-request inspector detail (1.2 Halide): the original target
    URL lives in the entry itself; this adds the internal engine URL,
    timing, initiator and redacted header/cookie records. Values of
    secrets are never stored (redactSecrets on entry). */
export interface NetDetail {
  /** Internal engine URL as the browser requested it (path + query). */
  internalUrl: string;
  /** Time until response headers, ms. */
  ttfb: number;
  /** Destination of the controlling page, when the SW can resolve it. */
  initiator?: string;
  /** Redacted request headers. */
  reqHeaders?: Record<string, string>;
  /** Redacted response headers, when a response was produced. */
  respHeaders?: Record<string, string>;
  /** Set-Cookie names seen on the response (values never stored). */
  cookies?: string[];
  /** True when the request arrived on a foreign origin and the engine
      routed it through the transport instead of letting the browser
      go direct (issue #34). */
  crossOrigin?: boolean;
}

const NET_LIMIT = 256;
const netLog: NetEntry[] = [];
let netSeq = 0;

function netLogPush(entry: Omit<NetEntry, "seq" | "ts">): void {
  netLog.push({ ...entry, seq: ++netSeq, ts: Date.now() });
  if (netLog.length > NET_LIMIT) netLog.shift();
}

/** Flatten headers into a redacted record for the inspector detail. */
function flatRed(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => (out[k] = redactSecrets(v)));
  return out;
}

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

export const ZEOLITE_VERSION = "3.0 Diamond";
console.info("[Zeolite] runtime " + ZEOLITE_VERSION);

/* 1.7 Sulfide: download registry. Attachment responses pass through a
   counting stream (nothing is ever buffered whole); entries carry the
   engine-known network facts and are cancellable by id. */
const DL = new DownloadTracker();

/* 1.8 Telluride: fingerprinting resistance. The active profile is
   compiled once into the document init script and mirrored onto the
   upstream wire (User-Agent, Accept-Language). Null = fully native
   surfaces, the honest default. Resets on SW restart, like the other
   host toggles; a rejected profile never changes active state. */
let fpProfile: FingerprintProfile | null = null;
/* 1.9 Fullerene: active session recording, when any. */
let rec: RecordingState | null = null;
let fpScript: string | null = null;
/* 2.3 Selenide: the same profile compiled for worker contexts
   (WorkerNavigator + OffscreenCanvas; documents keep fpScript). */
let fpWorkerScript: string | null = null;
function setFingerprint(profile: unknown): { ok: true; profile?: FingerprintProfile } | { ok: false; error: string } {
  if (profile === null || profile === undefined) {
    fpProfile = null;
    fpScript = null;
    fpWorkerScript = null;
    return { ok: true };
  }
  try {
    const p = resolveProfile(profile);
    fpProfile = p;
    fpScript = fingerprintScript(p);
    fpWorkerScript = workerFingerprintScript(p);
    return { ok: true, profile: p };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

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
        (req.destination === "script" && isJs(hit));
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
    const stored = new Response(resp.body, { status: 200, headers: storedHeaders });
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
  return wispFetch(dest, { method: "GET", headers });
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
      /* 1.4 Boride: restore the persisted cookie jar. Storage failure
         means an in-memory jar, never an activate failure. */
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
      /* Notifications (#43): the UI host renders (LB owns the
         surface) and reports interactions back via zl:notifyEvent. */
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
      const cfg = (await hit.json()) as { prefix?: string; scheme?: string };
      /* A pre-#32 deployment may have persisted scheme "mirror": it
         coerces to the default (mirror routes are gone, #32). */
      setScheme(cfg.prefix ?? "/j/");
    }
  } catch {
    /* storage unavailable: defaults stay until the next zl:config */
  }
})();

async function persistRoute(prefix: string): Promise<void> {
  try {
    await (await caches.open(ZL_ROUTE_CACHE)).put(
      ZL_ROUTE_KEY,
      new Response(JSON.stringify({ prefix })),
    );
  } catch {
    /* storage unavailable: the in-memory rotation still works */
  }
}

/* Issue #31: an in-engine navigation must land on the engine-owned
   error page, never on a bare text/plain strand. Route decode
   failures, disabled sites and policy blocks are all
   navigation-capable; subresources keep the honest short text body
   (no UI, per issue #3). */
function navOutcome(
  e: FetchEvent,
  url: URL,
  status: number,
  category: ErrorCategory,
  text: string,
): Response {
  if (e.request.mode === "navigate") {
    return new Response(
      errorPage({
        route: url.pathname + url.search,
        category,
        engineVersion: ZEOLITE_VERSION,
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
  }
  /* Issue #17: the route classification below depends on the restored
     route shape, so it runs after routeReady. respondWith is armed
     synchronously first: a cold-start fetch (restore still pending)
     must still be intercepted, not fall through to the origin with the
     default route shape. */
  e.respondWith(
    (async () => {
      await routeReady;
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
            rtype: classifyRtype(e.request.headers.get("sec-fetch-dest") ?? "", ""),
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
            rtype: classifyRtype(e.request.headers.get("sec-fetch-dest") ?? "", ""),
            ms: 0,
            bytes: 0,
            verdict: "cors-preflight: answered by engine",
            transport: "engine",
            detail: { internalUrl: url.href, ttfb: 0, initiator: pfInitiator },
          });
          return new Response(null, { status: 204, headers: h });
        }
        dest0 = url.href;
      } else if (url.pathname === NAV) {
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
           else is a bad route. */
        const navBytes = b64uDecode(url.pathname.slice(NAV.length + 1));
        const nav = navBytes ? new TextDecoder().decode(navBytes) : null;
        /* #31: a bad marker target is a navigation strand - the error
           page replaces the bare 404 text for navigations. */
        if (!nav || !/^https?:\/\//.test(nav)) return navOutcome(e, url, 404, "route", "zeolite: bad route");
        dest0 = nav;
      } else if (isEnginePath(url.pathname)) {
        const raw = decodePath(url.pathname);
        /* #31: an undecodable engine route answers the error page for
           navigations (bad route), the short text for subresources. */
        if (!raw) return navOutcome(e, url, 404, "route", "zeolite: bad route");
        dest0 = unwrapDest(raw);
        routeCarriesQuery = true;
      } else {
        if (isEngineAsset(url.pathname)) return fetch(e.request); // engine asset: passthrough
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
            path: internalUrl,
            dest: target,
            status: 403,
            rtype: classifyRtype(e.request.headers.get("sec-fetch-dest") ?? "", ""),
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
        const rtype = classifyRtype(
          e.request.headers.get("sec-fetch-dest") ?? "",
          "",
        ).toLowerCase() as ResourceType;
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
          transitRecord(traceId, target, decision);
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
        if (ruleDec.url || ic.url) target = ic.url ?? ruleDec.url ?? target;

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
              path: internalUrl,
              dest: target,
              status: hit.status,
              rtype: classifyRtype(
                e.request.headers.get("sec-fetch-dest") ?? "",
                hit.headers.get("content-type") ?? "",
              ),
              ms: Date.now() - t0,
              bytes: Number(hit.headers.get("content-length") ?? -1),
              verdict: "cache",
              rewritten:
                hit.status === 200 && isHtml(hit)
                  ? "html"
                  : hit.status === 200 && isCss(hit)
                    ? "css"
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
              return new Response(
                rewriteStream(hit.body, target, chRule, csInject, () => {
                  if (e.request.mode === "navigate") WEBNAV.completed(target);
                }),
                { status: hit.status, headers: hitHeaders },
              );
            }
            if (isCss(hit) && hit.body) {
              return new Response(cssRewriteStream(hit.body, target), {
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
          if (ruleUa && !fpProfile) sendHeaders.set("user-agent", ruleUa);
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
            navigation: (e.request.headers.get("sec-fetch-dest") ?? "") === "document",
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
          let resp = await wispFetch(hopUrl, { method: hopMethod, headers: sendHeaders, body: hopBody });
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
            resp = await wispFetch(hopUrl, { method: hopMethod, headers: sendHeaders, body: hopBody });
          }
          DIAG.stage(traceId, "UPSTREAM_RESPONSE", { url: hopUrl, message: "upstream status " + resp.status });
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
          if (resp.status >= 300 && resp.status < 400) {
            const loc = outHeaders.get("location");
            if (loc) {
              try {
                outHeaders.set("location", encodeDest(new URL(loc, finalDest ?? target).href));
              } catch {
                /* unreachable/relative Location: leave as-is */
              }
            }
          }
          void applyOnResponse(plugins, target, resp.status, outHeaders);
          const dec = refineWithContent(decision, resp.headers.get("content-type") ?? "");
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
            rtype: classifyRtype(
              e.request.headers.get("sec-fetch-dest") ?? "",
              resp.headers.get("content-type") ?? "",
            ),
            rewritten: isHtml(resp) ? "html" : isCss(resp) ? "css" : undefined,
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
          /* #35 (browser E2E): script/worker JS bodies flow through a
             serve-time transform below (specifier pass, worker
             prelude), and each of those branches stores its TRANSFORMED
             copy itself. Storing the raw body here as well would race
             the transformed put and could serve an unrewritten second
             visit, so the raw store skips exactly the union of the
             transformed branches. Documents and stylesheets keep the
             raw store: their cache hits re-run the streaming
             rewriter. */
          const workerServe = isWorkerDestination(e.request.destination) && !!resp.body;
          const scriptServe = e.request.destination === "script" && isJs(resp) && !!resp.body;
          if (e.request.method === "GET" && !workerServe && !scriptServe) void pageCacheStore(e.request, resp.clone());
          if (isHtml(resp) && resp.body) {
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "html rewrite stream wired" });
            traceDecision({ subsystem: "rewriter", rule: "html", original: target, result: "streaming", resource: rtype, traceId });
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
            /* 2.4 Bromide: standalone stylesheets stream through the wasm
               CSS rewriter (previously a one-shot pass over a fully
               buffered body). Completion events fire at stream end, like
               the HTML path. */
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "css rewrite stream wired" });
            traceDecision({ subsystem: "rewriter", rule: "css", original: target, result: "streaming", resource: rtype, traceId });
            return new Response(
              cssRewriteStream(resp.body, target, () => {
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
            const src = rewriteModuleWorkerImports(currentPrefix(), target, self.location.origin, await resp.text());
            /* Issue #32: no __ZL_WORKER_URL__ global (it handed the
               upstream URL to any worker script); the worker's own
               engine route is passed to the prelude init line and
               decoded inside its closure. */
            const head =
              "self.__ZL_PREFIX__=" + JSON.stringify(currentPrefix()) + ";\n" +
              (await workerPrelude()) +
              "\nself.__zlPreludeInit&&self.__zlPreludeInit(" + JSON.stringify(encodeDest(target)) + ");\n" +
              (fpWorkerScript ? "\n" + fpWorkerScript : "");
            WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
            /* #35: the page cache holds the composed copy (specifiers
               rewritten, prelude prepended); a stored raw body would
               serve a second visit unrewritten. */
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
            const prelude =
              "self.__ZL_PREFIX__=" + JSON.stringify(currentPrefix()) + ";\n" +
              (await workerPrelude()) +
              "\nself.__zlPreludeInit&&self.__zlPreludeInit(" + JSON.stringify(encodeDest(target)) + ");\n" +
              (fpWorkerScript ? "\n" + fpWorkerScript : "");
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
             Inline module scripts are a rewriter gap (#36): the parser
             path, not this seam. */
          if (e.request.destination === "script" && isJs(resp) && resp.body) {
            DIAG.stage(traceId, "REWRITE_STARTED", { url: target, message: "page script specifier pass" });
            traceDecision({ subsystem: "rewriter", rule: "script-imports", original: target, result: "rewritten", resource: rtype, traceId });
            const src = rewriteModuleWorkerImports(currentPrefix(), target, self.location.origin, await resp.text());
            WEBREQ.completed({ ...wrDetails, statusCode: resp.status });
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
          transitRecord(traceId, target, decision);
          netLogPush({
            method: e.request.method, traceId,
            path: internalUrl,
            dest: target,
            status: 0,
            rtype: classifyRtype(e.request.headers.get("sec-fetch-dest") ?? "", ""),
            ms: Date.now() - t0,
            bytes: -1,
            err: String(err),
            transport: decision.mode,
            fallbackReason: decision.fallbackReason,
            detail: mkDetail(),
          });
          /* Issue #3: failed navigations answer with the engine-owned
             error page (one honest category line, retry, zl-error
             meta). Issue #32: the target URL is not printed - it
             lives in the privileged rings (netLog / diagnostics) and
             the embedder's devtools only. Every other destination
             keeps the honest 502 plain text body - subresources get
             no UI. */
          if (e.request.mode === "navigate") {
            return new Response(
              errorPage({
                route: url.pathname + url.search,
                category: classifyFailure(String(err)),
                engineVersion: ZEOLITE_VERSION,
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
  if (fpProfile) {
    out.set("user-agent", fpProfile.userAgent);
    out.set("accept-language", fpProfile.languages.join(","));
  }
  return out;
}

/* ---- Control plane (Phase 2 + Phase 4) ---------------------------- */

interface ControlMessage {
  type:
    | "zl:config"
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
    | "zl:clearJar";
  extId?: string;
  msg?: unknown;
  prefix?: string;
  /** zl:config route scheme. Fixed "b64u" since #32; any other value
      is rejected (mirror removed). Kept optional for old embedders. */
  scheme?: string;
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
const docCookiePorts = new Map<string, { port: MessagePort; page: string }>();
const DOC_COOKIE_PORTS_CAP = 128;
function pushDocCookieView(clientId: string): void {
  const entry = clientId ? docCookiePorts.get(clientId) : undefined;
  if (!entry) return;
  try {
    entry.port.postMessage({ ok: true, cookie: documentCookieRead(entry.page) });
  } catch {
    /* port closed: the page is gone, stop tracking it */
    docCookiePorts.delete(clientId);
  }
}

/* #41: jar control is host-only. Proxied pages are SW clients too,
   and zl:getJars must never hand one target site every other site's
   cookies: the sender must be an engine page (adapter, devtools,
   extension pages), not a proxied route or nav marker. */
function senderIsProxiedPage(e: ExtendableMessageEvent): boolean {
  const src = e.source as Client | null;
  if (!src || !src.url) return true;
  try {
    const su = new URL(src.url, self.location.origin);
    return isEnginePath(su.pathname) || su.pathname.startsWith(NAV);
  } catch {
    return true;
  }
}

/* Page-facing control messages: sent from inside proxied documents
   and their workers (the bootstrap's docCookie/WS channels and the
   content-script bridge). zl:ping stays open because its echo carries
   no secrets and page code may probe liveness. */
const PAGE_MESSAGES = new Set(["zl:docCookie", "zl:wsOpen", "zl:ext", "zl:ping"]);

self.addEventListener("message", async (e: ExtendableMessageEvent) => {
  /* Issue #17: the restored route shape settles asynchronously; a
     cold-start ping must not report the default shape mid-restore. */
  await routeReady;
  const msg = e.data as ControlMessage;
  const port = e.ports[0];
  const reply = (payload: unknown) => port?.postMessage(payload);

  /* Bug-scout (#41): a proxied page must not drive the control plane
     (read the net log, flip the jar, tear the engine down). Page-facing
     messages only; everything else needs an engine-page sender. */
  if (senderIsProxiedPage(e) && !PAGE_MESSAGES.has(String(msg?.type))) {
    reply({ ok: false, error: "host-only control message" });
    return;
  }

  switch (msg?.type) {
    case "zl:ping":
      /* Issue #17: echo the live route shape so embedders can detect a
         revert to defaults (worker restart, storage wipe) and re-push
         their config. */
      reply({
        ok: true,
        version: ZEOLITE_VERSION,
        degraded: engineDegraded,
        prefix: currentPrefix(),
        /* Fixed shape since #32 (mirror removed); kept in the reply so
           old embedder probes that compare it stay compatible. */
        scheme: "b64u",
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
      setScheme(msg.prefix ?? "/j/");
      /* Issue #17: persist so a worker restart keeps the shape. */
      void persistRoute(currentPrefix());
      reply({ ok: true, prefix: currentPrefix(), scheme: "b64u" });
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
    case "zl:tracing":
      /* 1.2 Halide: opt-in rewrite tracing ring. Off by default;
         resets to off on SW restart, so the host re-sends it. */
      setTracing(msg.enabled !== false);
      reply({ ok: true, enabled: msg.enabled !== false });
      break;
    case "zl:getTracing": {
      /* Delta poll, same cursor protocol as zl:getNetLog. */
      const since = (msg as { since?: number }).since ?? 0;
      reply({ ok: true, ...tracingSnapshot(since) });
      break;
    }
    case "zl:siteRoute":
      if (!msg.site) {
        reply({ ok: false, error: "missing site" });
        break;
      }
      if (msg.enabled === false) disabledSites.add(msg.site);
      else disabledSites.delete(msg.site);
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
        await ensureCurl();
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
        profile: fpProfile,
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
      if (cid) {
        if (docCookiePorts.size >= DOC_COOKIE_PORTS_CAP && !docCookiePorts.has(cid)) {
          const oldest = docCookiePorts.keys().next();
          if (!oldest.done && oldest.value !== undefined) docCookiePorts.delete(oldest.value);
        }
        docCookiePorts.set(cid, { port, page: origin });
      }
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
        netCursor: netSeq,
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
        netEntries: netLog.filter((x) => x.seq > r.netCursor),
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
      const valid =
        typeof ne.extId === "string" &&
        typeof info?.id === "string" &&
        (info.event === "clicked" || info.event === "closed" || info.event === "buttonClicked") &&
        (info.event !== "buttonClicked" || typeof info.buttonIndex === "number");
      const erec = valid ? extensions.get(ne.extId) : null;
      if (!valid || !erec || !erec.enabled || !NOTIFY.exists(ne.extId, String(info!.id))) {
        reply({ ok: false, error: "bad notifyEvent" });
        break;
      }
      const nid = String(info!.id);
      const kind = info!.event as "clicked" | "closed" | "buttonClicked";
      const btn = typeof info!.buttonIndex === "number" ? info!.buttonIndex : undefined;
      e.waitUntil(wakeExtension(ne.extId).then(() => NOTIFY.event(ne.extId, nid, kind, btn)));
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

