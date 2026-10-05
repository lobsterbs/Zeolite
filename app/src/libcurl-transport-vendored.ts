/* libcurl-transport adapter (vendored seam).
 *
 * Zeolite cannot legally ship @mercuryworkshop/libcurl-transport's
 * dist in this repository: the package is AGPL-3.0-only and the dist
 * is a 2.1 MB bundle. Instead, the CI workflow vendors it:
 *
 *   npm i --prefix .vendor @mercuryworkshop/libcurl-transport@2.0.5
 *   cp -r .vendor/node_modules/@mercuryworkshop/libcurl-transport/dist app/public/libcurl
 *   cp -r .vendor/node_modules/libcurl.js/dist app/public/libcurl/libcurl.js
 *
 * so the built engine serves it at /libcurl/index.mjs. This module
 * stays committed, loads that bundle at runtime, and degrades to a
 * clear error when vendoring has not run (the compat suite then
 * records transport-missing instead of silently passing).
 *
 * Why libcurl: the service worker cannot terminate TLS, so proxied
 * HTTPS must come from a client-side engine. libcurl.js performs the
 * real TLS handshake with a real cipher/ALPN configuration, which is
 * also the seam where fingerprint impersonation (Phase 3) applies.
 * AGPL note: anyone serving a built engine with this bundle must
 * honor AGPL-3.0 for the transport (and, per AGPL, for the combined
 * work it links against).
 *
 * Verified API (dist/index.d.ts, v2.0.5):
 *   class LibcurlClient {
 *     constructor(options: { wisp: string; websocket?: string; proxy?: string; transport?: string });
 *     init(): Promise<void>;
 *     ready: boolean;
 *     request(remote: URL, method: string, body: BodyInit | null,
 *             headers: [string, string][], signal?: AbortSignal)
 *           : Promise<{ body: ReadableStream | ArrayBuffer | Blob | string;
 *                      headers: [string, string][]; status: number; statusText: string }>;
 *   }
 * Exported both as default and as the named `LibcurlClient`.
 */

type RawHeaders = Array<[string, string]>;
type TransferrableResponse = {
  body: ReadableStream | ArrayBuffer | Blob | string;
  headers: RawHeaders;
  status: number;
  statusText: string;
};

interface LibcurlClientLike {
  init(): Promise<void>;
  ready: boolean;
  request(
    remote: URL,
    method: string,
    body: BodyInit | null,
    headers: RawHeaders,
    signal: AbortSignal | undefined,
  ): Promise<TransferrableResponse>;
  /* WebSocket (verified in dist/index.d.ts v2.0.5): TLS-terminated
     ws over the wisp transport. Returns [send, close]. */
  connect(
    url: URL,
    protocols: string[],
    requestHeaders: RawHeaders,
    onopen: (protocol: string, extensions: string) => void,
    onmessage: (data: Blob | ArrayBuffer | string) => void,
    onclose: (code: number, reason: string) => void,
    onerror: (error: string) => void,
  ): [(data: Blob | ArrayBuffer | string) => void, (code: number, reason: string) => void];
}

const MISSING = "zeolite: libcurl transport not vendored (CI step must copy @mercuryworkshop/libcurl-transport dist into app/public/libcurl)";

/* Override for non-standard deployments (rarely needed). */
function moduleUrl(): string {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.__ZL_LIBCURL_URL__ === "string") return g.__ZL_LIBCURL_URL__ as string;
  /* The engine origin serves the app, so the vendored bundle sits at
     /libcurl/index.mjs next to the service worker scope. */
  return new URL("libcurl/index.mjs", self.location.origin + "/").href;
}

let client: LibcurlClientLike | null = null;
let initPromise: Promise<void> | null = null;

/* ---------------------------------------------------------------------------
 * Epoxy engine (issue #64): selectable second TLS/HTTP engine.
 *
 * The engine is chosen by deployment (Vite define ZL_TRANSPORT reading
 * globalThis.__ZL_TRANSPORT__, same pattern as ZL_WISP_URL), by a host
 * calling setEngine() before init(), or at runtime through the
 * zl:transport control message (DevTools toggle). Default stays
 * "libcurl".
 *
 * Corrections recorded up front (verified against npm metadata 2.1.18-1
 * and the upstream client/src/lib.rs): @mercuryworkshop/epoxy-tls is
 * AGPL-3.0-only, NOT MIT. There is no license win here; the win is
 * payload size and the rustls+hyper stack. Deployments serving either
 * bundle inherit the same AGPL obligations.
 *
 * The vendored variant is the FULL build: fetch + connect_websocket +
 * gzip/brotli decompression + HTTP/2 (the minimal build has fetch only
 * and no WS surface). The wasm is fetched lazily, only when the epoxy
 * engine is actually selected, so the default libcurl payload is
 * unchanged.
 *
 * Verified against upstream lib.rs (2.1.18-1, branch "multiplexed"):
 * - EpoxyClient.fetch(url, options) follows redirects by default; the
 *   engine surfaces 3xx itself, so the adapter passes redirect:
 *   "manual" for libcurl parity (the SW hop-follower owns redirect
 *   mapping).
 * - fetch() defines url/redirected/rawHeaders on the returned
 *   Response; rawHeaders is an object mapping header name -> value or
 *   array of values (set-cookie pairs survive there, past the
 *   forbidden-header filter). The adapter rebuilds the response with
 *   rawHeaders as pairs, the shape the Zeolite cookie jar reads.
 * - connect_websocket(handlers, url, protocols, headers) is async;
 *   EpoxyHandlers(onopen, onclose, onerror, onmessage) - note the
 *   order differs from libcurl's connect(). onopen/onclose carry no
 *   arguments: the peer close code is NOT surfaced, so a Close-frame
 *   close reports 1000 (a completed close handshake is by definition
 *   clean); an error-then-close reports 1006, matching the bridge's
 *   abnormal-close convention.
 * - AbortSignal is not part of the epoxy fetch options surface:
 *   aborted requests run to completion under epoxy. Honest limit,
 *   recorded, not faked.
 * ------------------------------------------------------------------------ */

export type TransportEngine = "libcurl" | "epoxy";

const ENGINE_DEFAULT: TransportEngine =
  ((globalThis as typeof globalThis & { __ZL_TRANSPORT__?: string }).__ZL_TRANSPORT__ === "epoxy")
    ? "epoxy"
    : "libcurl";

let engine: TransportEngine = ENGINE_DEFAULT;

/** Select the TLS/HTTP engine. Takes effect on the next init() call;
    an engine switch mid-session requires a service-worker restart. */
export function setEngine(e: TransportEngine): void {
  if (e !== "libcurl" && e !== "epoxy") {
    throw new Error("zeolite: unknown transport engine " + String(e));
  }
  engine = e;
}

/** Currently selected engine (the one init() would bring up). */
export function currentEngine(): TransportEngine {
  return engine;
}

const EPOXY_MISSING = "zeolite: epoxy transport not vendored (CI must copy @mercuryworkshop/epoxy-tls full/ into app/public/epoxy)";

function epoxyModuleUrl(): string {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.__ZL_EPOXY_URL__ === "string") return g.__ZL_EPOXY_URL__ as string;
  return new URL("epoxy/epoxy.js", self.location.origin + "/").href;
}

function epoxyWasmUrl(): string {
  return new URL("epoxy/epoxy.wasm", self.location.origin + "/").href;
}

/* wasm-bindgen glue is an ES module with INLINE export statements
   (export class/function/const and export default), unlike the libcurl
   bundle's single trailing export list, plus a default-branch
   new URL(..., import.meta.url) that is a SyntaxError inside a Function
   body. Strip the export keywords and pin import.meta.url to the vendored
   wasm URL. Pure, unit-tested (__tests__/transport-select.test.ts). */
export function stripEsmExports(src: string, metaUrl: string): string {
  return src
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+\{/g, "{")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g, "")
    .replace(/import\.meta\.url/g, JSON.stringify(metaUrl));
}

interface EpoxySocketLike {
  send(data: string | ArrayBuffer): Promise<void>;
  close(code: number, reason: string): Promise<void>;
}

interface EpoxyFetchClient {
  fetch(url: string, options: object): Promise<Response>;
  connect_websocket?(
    handlers: unknown,
    url: string,
    protocols: string[],
    headers: Record<string, string>,
  ): Promise<EpoxySocketLike>;
}

interface EpoxyClientOptionsLike {
  wisp_v2: boolean;
}

interface EpoxyHandlersCtor {
  new (
    onopen: () => void,
    onclose: () => void,
    onerror: (err: unknown) => void,
    onmessage: (data: string | Uint8Array) => void,
  ): unknown;
}

interface EpoxyModule {
  init?: (o: { module_or_path: string | WebAssembly.Module }) => Promise<void>;
  EpoxyClient?: new (transport: string, options: EpoxyClientOptionsLike) => EpoxyFetchClient;
  EpoxyClientOptions?: new () => EpoxyClientOptionsLike;
  EpoxyHandlers?: EpoxyHandlersCtor;
}

/** epoxy's rawHeaders object -> the [name, value] pair list the Zeolite
    cookie jar reads (multi-value names flatten; junk filters out).
    Pure, unit-gated (__tests__/epoxy-adapter.test.ts). */
export function epoxyRawHeadersToPairs(raw: unknown): RawHeaders {
  const pairs: RawHeaders = [];
  if (!raw || typeof raw !== "object") return pairs;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") pairs.push([name, value]);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") pairs.push([name, v]);
    }
  }
  return pairs;
}

/** Fetch options for the epoxy client, built for libcurl parity: 3xx
    surfaces (redirect "manual"; the SW hop-follower owns redirect
    mapping), method/headers/body passthrough. Pure, unit-gated. */
export function epoxyFetchOptions(init?: RequestInit): Record<string, unknown> {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers as HeadersInit);
    h.forEach((value, key) => {
      headers[key] = value;
    });
  }
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    headers,
    body: init?.body ?? null,
    redirect: "manual",
  };
}

/* WsHandle payloads are whatever the page posted; the epoxy socket
   accepts string or ArrayBuffer. Blob and typed-array views are
   converted once, here. */
async function epoxyPayload(data: unknown): Promise<string | ArrayBuffer> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (data instanceof Blob) return (await data.arrayBuffer()) as ArrayBuffer;
  throw new Error("zeolite: epoxy ws payload must be string or binary");
}

/** Sync WsHandle over epoxy's async connect_websocket: sends buffer
    until the socket resolves, a close before the socket resolves is
    delivered to it, and the handler order/close-code mapping follows
    the adapter contract documented above. Pure, unit-gated. */
export function epoxyWsHandle(
  h: WsHandlers,
  handlersCtor: EpoxyHandlersCtor,
  connect: (constructed: unknown, url: string, protocols: string[], headers: Record<string, string>) => Promise<EpoxySocketLike>,
  url: string,
  protocols: string[],
  requestHeaders: RawHeaders,
): WsHandle {
  let errored = false;
  let closed = false;
  let sock: EpoxySocketLike | null = null;
  const pending: Array<string | ArrayBuffer> = [];
  const headers: Record<string, string> = Object.fromEntries(requestHeaders) as Record<string, string>;
  const constructed = new handlersCtor(
    () => h.onopen(""),
    () => h.onclose(errored ? 1006 : 1000, ""),
    (err) => {
      errored = true;
      h.onerror(String(err));
    },
    (data) => h.onmessage(data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data),
  );
  connect(constructed, url, protocols, headers)
    .then((s) => {
      sock = s;
      if (closed) {
        void s.close(1000, "").catch(() => undefined);
        return;
      }
      for (const d of pending.splice(0)) {
        void s.send(d).catch((err) => {
          errored = true;
          h.onerror(String(err));
        });
      }
    })
    .catch((err) => {
      errored = true;
      h.onerror(String(err));
    });
  return {
    send(data) {
      void epoxyPayload(data)
        .then((p) => {
          if (sock) {
            void sock.send(p).catch((err) => {
              errored = true;
              h.onerror(String(err));
            });
          } else if (!closed) {
            pending.push(p);
          }
        })
        .catch((err) => {
          errored = true;
          h.onerror(String(err));
        });
    },
    close(code, reason) {
      closed = true;
      if (sock) void sock.close(code, reason ?? "").catch(() => undefined);
    },
  };
}

let epoxyClient: EpoxyFetchClient | null = null;
let epoxyHandlers: EpoxyHandlersCtor | null = null;
let epoxyInitPromise: Promise<void> | null = null;

async function loadEpoxyModule(): Promise<EpoxyModule> {
  const res = await globalThis.fetch(epoxyModuleUrl(), { cache: "no-store" });
  if (!res.ok) throw new Error(EPOXY_MISSING);
  const src = stripEsmExports(await res.text(), epoxyWasmUrl());
  const factory = new Function(
    src + "\nreturn { init: typeof __wbg_init === \"function\" ? __wbg_init : undefined, EpoxyClient, EpoxyClientOptions, EpoxyHandlers };",
  );
  return factory() as EpoxyModule;
}

async function getEpoxy(cfg: { websocket: string }): Promise<EpoxyFetchClient> {
  if (epoxyClient) return epoxyClient;
  if (!epoxyInitPromise) {
    epoxyInitPromise = (async () => {
      const mod = await loadEpoxyModule();
      if (!mod.init || !mod.EpoxyClient || !mod.EpoxyClientOptions) {
        throw new Error("zeolite: epoxy bundle exports incomplete (init/EpoxyClient/EpoxyClientOptions)");
      }
      await mod.init({ module_or_path: epoxyWasmUrl() });
      const options = new mod.EpoxyClientOptions();
      options.wisp_v2 = true;
      epoxyClient = new mod.EpoxyClient(cfg.websocket, options);
      epoxyHandlers = mod.EpoxyHandlers ?? null;
    })();
    epoxyInitPromise = epoxyInitPromise.catch((e) => {
      epoxyInitPromise = null;
      throw e;
    });
  }
  await epoxyInitPromise;
  if (!epoxyClient) throw new Error(EPOXY_MISSING);
  return epoxyClient;
}


/* Load the vendored ESM bundle without `import()`.
 *
 * Service workers on Chromium do not support dynamic import() on
 * ServiceWorkerGlobalScope, so `await import(url)` throws a TypeError
 * and every proxied fetch dies. The bundle is a self-contained ESM
 * module whose only export statement is the trailing
 * `export { ... };` list (no import.meta use, no other exports), so:
 * strip that tail and evaluate the module body with a function
 * constructor, returning the named bindings directly. Verified
 * against the real 2.1 MB @mercuryworkshop/libcurl-transport bundle
 * inside a live service worker. */
async function loadBundle(url: string): Promise<{ LibcurlClient?: unknown; default?: unknown }> {
  /* Module-scope shadowing: this module exports its own fetch(),
   * so a bare fetch() here would recurse into the uninitialized
   * transport and misreport as MISSING. Always pin globalThis. */
  const res = await globalThis.fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(MISSING);
  const src = await res.text();
  const tail = src.match(/export\s*\{[^}]*\}\s*;?\s*$/);
  if (!tail || tail.index === undefined) {
    throw new Error("zeolite: vendored libcurl bundle has no trailing export list");
  }
  const body = src.slice(0, tail.index);
  const factory = new Function(`${body}\nreturn { LibcurlClient, default: LibcurlClient };`);
  return factory() as { LibcurlClient?: unknown; default?: unknown };
}

/* Issue #11: close-delimited empty-body responses (runtime transport
 * patch).
 *
 * libcurl.js 0.7.4 (vendored inside @mercuryworkshop/libcurl-transport
 * 2.0.5) resolves HTTPSession.fetch only when the body starts or cleanly
 * ends: CurlSession.stream_response fires the headers callback - which
 * constructs the Response and resolves the fetch promise - only from the
 * first body chunk (real_data_callback) or from real_end_callback at
 * error === 0. An empty-body response that is close-delimited (no
 * content-length, no chunked framing) never produces a body chunk, and
 * its end-of-body is the peer connection close, which the wasm curl maps
 * to error 56 (RECV_ERROR; the CI verbose trace shows mbedTLS ssl_read
 * returning 0 on the close, and the failure is identical on h2 and forced
 * HTTP/1.1). The full header set was already delivered, but the transport
 * rejects with no response object, so the SW redirect-hop follower never
 * engages and the engine error page answers (craigslist root, #11).
 *
 * Fix: replace stream_response on the CurlSession prototype at load time
 * (a patch on the vendored bundle own objects; the AGPL artifact itself
 * stays untouched and uncommitted) with this transcription of the 0.7.4
 * source plus one change: on error 56 with no body chunk surfaced, and
 * only when the received header set declares a close-delimited body (no
 * transfer-encoding, content-length absent or zero), fire the headers
 * callback first. http.js then resolves only when a real response exists
 * (create_response throws RangeError for status 0, i.e. no response was
 * ever received), so genuine pre-response failures keep their original
 * rejection through end_callback(error).
 *
 * Gates: __tests__/transport-patch.test.ts (callback ordering and
 * scoping) and the transport-gate workflow (suite/transport-diag.mjs:
 * the real craigslist 302 through a local wisp relay, every push to
 * main). */
interface StreamResponseThis {
  create_request(
    url: string,
    data: (chunk: Uint8Array) => void,
    end: (error: number) => void,
    headers: (chunk: Uint8Array) => void,
  ): unknown;
}

function patchedStreamResponse(
  this: StreamResponseThis,
  url: string,
  headers_callback: (stream: ReadableStream) => void,
  end_callback: (error: number) => void,
  abort_signal: AbortSignal | undefined,
): unknown {
  let stream_controller: ReadableStreamDefaultController | undefined;
  let aborted = false;
  let headers_received = false;
  let raw_header_text = "";
  const stream = new ReadableStream({
    start(controller) {
      stream_controller = controller;
    },
  });
  /* Upstream hands the raw header text to a no-op callback; keep
     collecting it (header tokens are ASCII, so latin-1 assembly is
     exact for the framing check below, never decoded as data). */
  const collect_header_text = (chunk: Uint8Array) => {
    let text = "";
    for (let i = 0; i < chunk.length; i++) {
      text += String.fromCharCode(chunk[i]);
    }
    raw_header_text += text;
  };
  const real_data_callback = (new_data: Uint8Array) => {
    if (!headers_received) {
      headers_received = true;
      headers_callback(stream);
    }
    try {
      stream_controller?.enqueue(new_data);
    } catch (e) {
      /* the readable stream has been closed elsewhere, so cancel the
         request (upstream behavior, kept verbatim) */
      if (aborted) return;
      aborted = true;
      if (e instanceof TypeError) {
        end_callback(-1);
      } else {
        throw e;
      }
    }
  };
  const real_end_callback = (error: number) => {
    if (!headers_received && error === 56) {
      /* The #11 fix, scoped: RECV_ERROR with the header set already
         delivered and a close-delimited body is end-of-body, not a
         transport failure. Length-delimited bodies (content-length > 0
         or chunked) keep the original rejection: error 56 before their
         framing completed is truncation, and truncation must fail. */
      const lower = "\r\n" + raw_header_text.toLowerCase();
      const has_length = /(?:^|\r\n)content-length:/.test(lower);
      const length_zero = /(?:^|\r\n)content-length:\s*0(?:\r|$)/.test(lower);
      const has_chunked = /(?:^|\r\n)transfer-encoding:/.test(lower);
      if (!has_chunked && (!has_length || length_zero)) {
        headers_received = true;
        try {
          headers_callback(stream);
        } catch {
          /* no constructible response (status 0): keep the original
             rejection below */
        }
      }
    }
    if (!headers_received && error === 0) {
      headers_received = true;
      headers_callback(stream);
    }
    try {
      stream_controller?.close();
    } catch {
      /* already closed or errored */
    }
    end_callback(error);
  };
  if (abort_signal instanceof AbortSignal) {
    abort_signal.addEventListener("abort", () => {
      if (aborted) return;
      aborted = true;
      if (headers_received) {
        stream_controller?.error("The operation was aborted.");
      }
      real_end_callback(-1);
    });
  }
  return this.create_request(
    url,
    real_data_callback,
    real_end_callback,
    collect_header_text,
  );
}

/* Apply the stream_response patch to a live transport session prototype
   chain. Returns true when the seam is (or already was) patched, false
   when the bundle layout changed. */
export function applyTransportEOF(session: object): boolean {
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(session)) as
    | { stream_response?: unknown; __zl_eof_patched?: boolean }
    | null;
  if (!proto || typeof proto.stream_response !== "function") return false;
  if (proto.__zl_eof_patched) return true;
  proto.stream_response = patchedStreamResponse;
  proto.__zl_eof_patched = true;
  return true;
}

async function getClient(cfg: { websocket: string }): Promise<LibcurlClientLike> {
  if (client && client.ready) return client;
  if (!initPromise) {
    initPromise = (async () => {
      let mod: { LibcurlClient?: unknown; default?: unknown };
      try {
        mod = await loadBundle(moduleUrl());
      } catch {
        initPromise = null;
        throw new Error(MISSING);
      }
      const Ctor = (mod.LibcurlClient ?? mod.default) as
        | (new (o: { wisp: string; websocket?: string }) => LibcurlClientLike)
        | undefined;
      if (typeof Ctor !== "function") {
        initPromise = null;
        throw new Error("zeolite: vendored libcurl bundle exports no LibcurlClient");
      }
      /* Both option spellings are accepted by the client; passing the
         wisp URL through both is harmless and covers API drift. */
      const c = new Ctor({ wisp: cfg.websocket, websocket: cfg.websocket });
      await c.init();
      /* Issue #11 patch: a missing seam is a hard init failure (the
         transport-gate workflow catches layout drift in CI before any
         deploy). Reset initPromise so a later attempt retries. */
      const session = (c as LibcurlClientLike & { session?: unknown }).session;
      if (!session || !applyTransportEOF(session)) {
        initPromise = null;
        throw new Error(
          "zeolite: transport seam missing (CurlSession.stream_response not found; libcurl.js layout changed)",
        );
      }
      client = c;
    })();
  }
  await initPromise;
  if (!client) throw new Error(MISSING);
  return client;
}

export async function init(cfg: { websocket: string }): Promise<void> {
  if (engine === "epoxy") {
    await getEpoxy(cfg);
    return;
  }
  await getClient(cfg);
}

export async function fetch(url: string, init?: RequestInit): Promise<Response> {
  if (engine === "epoxy") {
    if (!epoxyClient) throw new Error("zeolite: transport not initialized (call init first)");
    const res = await epoxyClient.fetch(url, epoxyFetchOptions(init));
    /* Rebuild so rawHeaders is the Zeolite pair shape (epoxy's own
       rawHeaders object maps name -> value | values; set-cookie pairs
       survive past the forbidden-header filter) and resp.headers
       carries the same pairs. Abort signals are not part of the epoxy
       surface; that limit is documented above, not faked. */
    const pairs = epoxyRawHeadersToPairs((res as Response & { rawHeaders?: unknown }).rawHeaders);
    const h = new Headers();
    for (const [k, v] of pairs) h.append(k, v);
    const resp = new Response(res.body as BodyInit | null, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
    (resp as Response & { rawHeaders?: RawHeaders }).rawHeaders = pairs;
    return resp;
  }
  if (!client) throw new Error("zeolite: transport not initialized (call init first)");
  const c = client;
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: RawHeaders = [];
  if (init?.headers) {
    const h = new Headers(init.headers as HeadersInit);
    h.forEach((value, key) => {
      headers.push([key, value]);
    });
  }
  const signal = init?.signal ?? undefined;
  const res = await c.request(new URL(url), method, init?.body ?? null, headers, signal);
  const h2 = new Headers();
  for (const [k, v] of res.headers) h2.append(k, v);
  const resp = new Response(res.body as BodyInit | null, {
    status: res.status,
    statusText: res.statusText,
    headers: h2,
  });
  /* Response construction drops set-cookie (fetch spec: forbidden
     response-header name), so the cookie jar can never read it off
     resp.headers. The transport's raw pairs survive here instead. */
  (resp as Response & { rawHeaders?: RawHeaders }).rawHeaders = res.headers;
  return resp;
}

/* WebSocket (1.3 Carbide). LibcurlClient.connect terminates TLS and
   runs the ws handshake over a raw wisp TCP stream, which is the same
   proven path proxied HTTPS uses. */
export interface WsHandlers {
  onopen(protocol: string): void;
  onmessage(data: Blob | ArrayBuffer | string): void;
  onclose(code: number, reason: string): void;
  onerror(error: string): void;
}
export interface WsHandle {
  send(data: Blob | ArrayBuffer | string): void;
  close(code: number, reason?: string): void;
}
export function openWebSocket(
  url: string,
  protocols: string[],
  h: WsHandlers,
  requestHeaders: RawHeaders = [],
): WsHandle {
  /* Epoxy engine (#64): connect_websocket exists on the full build
     (verified: websocket.rs sits behind the "full" feature). The
     minimal build has no WS surface, so a deployment that vendored
     minimal fails honestly here - no silent fallback, no faked API. */
  if (engine === "epoxy") {
    if (!epoxyClient) throw new Error(EPOXY_MISSING);
    if (!epoxyHandlers || typeof epoxyClient.connect_websocket !== "function") {
      throw new Error("zeolite: epoxy build has no WebSocket API (vendor the full epoxy variant)");
    }
    const handlers = epoxyHandlers;
    const c = epoxyClient;
    return epoxyWsHandle(
      h,
      handlers,
      (constructed, u, p, hdrs) => c.connect_websocket!(constructed, u, p, hdrs),
      url,
      protocols,
      requestHeaders,
    );
  }
  if (!client) throw new Error(MISSING);
  const [send, close] = client.connect(
    new URL(url),
    protocols,
    requestHeaders,
    (protocol) => h.onopen(protocol),
    (data) => h.onmessage(data),
    (code, reason) => h.onclose(code, reason),
    (error) => h.onerror(error),
  );
  /* No ping/lastPongAt seam (#61): connect() (dist 2.0.5, libcurl.js
     0.7.4) exposes no WS control-frame surface, so the wsbridge
     keepalive watchdog stays off against this transport. If a future
     transport build grows WS ping support, add the optional
     ping()/lastPongAt() pair here and the watchdog arms itself. */
  return { send, close };
}
