/* libcurl-transport adapter (vendored seam).

   The package is AGPL-3.0-only and its dist is 2.1 MB, so it is
   never committed: the CI workflow vendors it (npm i
   @mercuryworkshop/libcurl-transport@2.0.5, copies the dists into
   app/public/libcurl) and the built engine serves it at
   /libcurl/index.mjs. This module loads that bundle at runtime and
   degrades to a clear error when vendoring has not run (the compat
   suite records transport-missing instead of silently passing).

   Why libcurl: a SW cannot terminate TLS, so proxied HTTPS needs a
   client-side engine with a real TLS handshake - the seam where
   fingerprint impersonation applies. AGPL note: anyone serving a
   built engine must honor AGPL-3.0 for the transport and the
   combined work.

   Verified API (dist/index.d.ts, v2.0.5): class LibcurlClient
   { constructor({ wisp, websocket?, proxy?, transport? });
     init(): Promise<void>; ready: boolean;
     request(remote, method, body, headers, signal?):
       Promise<{ body, headers, status, statusText }> }
   Exported as default and as named LibcurlClient. */

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

/* Epoxy engine (issue #64): selectable second TLS/HTTP engine.

   Chosen by deployment (Vite define ZL_TRANSPORT reading
   globalThis.__ZL_TRANSPORT__), by setEngine() before init(), or
   at runtime via zl:transport. Default stays "libcurl".

   Verified against upstream (epoxy-tls 2.1.18-1, lib.rs):
   - @mercuryworkshop/epoxy-tls is AGPL-3.0-only, NOT MIT - no
     license win, the win is payload size and rustls+hyper.
   - The vendored variant is the FULL build (fetch, WS, gzip/
     brotli, HTTP/2); its wasm is fetched lazily, only when epoxy
     is selected, so the default payload is unchanged.
   - EpoxyClient.fetch follows redirects by default; the engine
     surfaces 3xx itself, so the adapter passes
     redirect:"manual" for libcurl parity (the SW owns hops).
   - fetch() defines url/redirected/rawHeaders on the Response;
     rawHeaders maps name -> value | values (set-cookie survives
     past the forbidden-header filter); the adapter rebuilds
     responses with rawHeaders as pairs for the cookie jar.
   - connect_websocket(handlers, url, protocols, headers):
     EpoxyHandlers(onopen, onclose, onerror, onmessage) - order
     differs from libcurl's connect(). No peer close code is
     surfaced: clean close reports 1000, error-close 1006.
   - No AbortSignal in the epoxy fetch options: aborted requests
     run to completion. Honest limit, not faked. */

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
   body - and the full build statically imports its wasm-bindgen JS
   helpers from a data: URL module, the same problem class: import
   statements are SyntaxErrors inside a Function body too, and a service
   worker cannot dynamic-import(). inlineDataImports below decodes each
   data: module and splices it in place of the import statement. Strip
   the export keywords and pin import.meta.url to the vendored wasm URL.
   Pure, unit-tested (__tests__/transport-select.test.ts). */
export function stripEsmExports(src: string, metaUrl: string): string {
  return src
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+\{/g, "{")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g, "")
    .replace(/import\.meta\.url/g, JSON.stringify(metaUrl));
}

/* The full epoxy build imports its wasm-bindgen JS helpers from a
   data: URL module (the "inline helpers" build). import statements
   are SyntaxErrors inside a Function body and a service worker cannot
   dynamic-import(), so decode each data: module and splice its source
   in place of the import statement; stripEsmExports, applied by the
   caller over the combined source, strips the spliced module's export
   keywords. Pure, unit-tested (__tests__/transport-select.test.ts). */
export function inlineDataImports(src: string): string {
  return src.replace(
    /import\s*\{[^}]*\}\s*from\s*(["'])data:text\/javascript;base64,([A-Za-z0-9+/=]*)\1\s*;?/g,
    (_match: string, _quote: string, b64: string) => atob(b64),
  );
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
  const src = stripEsmExports(inlineDataImports(await res.text()), epoxyWasmUrl());
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

/* Issue #11: close-delimited empty-body responses.

   libcurl.js 0.7.4 resolves HTTPSession.fetch only when the body
   starts (first chunk) or cleanly ends (error === 0). An
   empty-body response that is close-delimited (no content-length,
   no chunked framing) never produces a body chunk, and the peer
   close maps to curl error 56, so the transport rejects with no
   response object (craigslist root, #11) and the SW redirect-hop
   follower never engages.

   Fix: replace CurlSession.prototype.stream_response at load time
   (a patch on the vendored bundle's own objects; the AGPL artifact
   stays untouched and uncommitted) with a transcription of the
   0.7.4 source plus one change: on error 56 with no body chunk
   surfaced, and only when the received header set declares a
   close-delimited body (no transfer-encoding, content-length
   absent or zero), fire the headers callback first. http.js
   resolves only when a real response exists; genuine
   pre-response failures keep their original rejection.

   Gates: __tests__/transport-patch.test.ts (callback ordering,
   scoping) and the transport-gate workflow (suite/
   transport-diag.mjs, craigslist 302 through a local wisp relay;
   dispatch-only since 2026-10-05, run manually when the
   transport seam changes). */
interface StreamResponseThis {
  /* Stashed by the request_async wrapper (see applyTransportEOF):
     the request method, captured once at the synchronous entry of
     this call. Default "GET" when no wrapper ran (a bare
     stream_response call keeps the pre-patch behavior). */
  __zl_req_method?: unknown;
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
  /* The request method is not an argument here: request_async hands it
     to the wasm only after this call (via _http_set_options), so the
     request_async wrapper in applyTransportEOF stashes it on the
     session for the synchronous duration of this call. Captured once,
     at entry - nothing can interleave between the stash and this
     synchronous body. */
  const reqMethod = String(this.__zl_req_method ?? "GET").toUpperCase();
  /* Upstream hands the raw header text to a no-op callback; keep
     collecting it (header tokens are ASCII, so latin-1 assembly is
     exact for the framing check below, never decoded as data). */
  const collect_header_text = (chunk: Uint8Array) => {
    let text = "";
    for (let i = 0; i < chunk.length; i++) {
      text += String.fromCharCode(chunk[i]);
    }
    raw_header_text += text;
    /* RFC 9110 bodiless responses (#92/#96): a 204 or 304 response
       ends at the header block - the response IS the headers. The
       wasm curl does not special-case them: with no content-length
       and no chunked framing (the normal shape of a 304) it waits
       for a phantom body until the peer closes the connection, so a
       keep-alive 204/304 stalls the fetch for the server's whole
       keep-alive window (5s on the CI fixture) before the error-56
       salvage in real_end_callback finally surfaces it. Fire the
       headers callback the moment a complete 204/304 block arrives.
       The same framing hole hits HEAD (#92): the wasm sends the
       method as a custom request string, so a HEAD answer that
       declares content-length (the normal HEAD shape) also waits
       for a phantom body until the keep-alive close, and the page
       sees a 502 after the whole window. A HEAD response ends at
       the header block by definition, so any complete HEAD block
       surfaces the same way. Only the LAST complete block counts: a
       followed redirect or an interim 1xx accumulates earlier
       blocks ahead of the final status, and 1xx blocks are never
       terminal (the >= 200 bound excludes them for HEAD). */
    if (headers_received) return;
    const blocks = raw_header_text.split("\r\n\r\n");
    /* the final element is the not-yet-terminated block ("" right
       after a terminator); complete blocks precede it */
    if (blocks.length < 2) return;
    const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(
      blocks[blocks.length - 2],
    );
    if (!statusMatch) return;
    const status = Number(statusMatch[1]);
    if (
      status !== 204 &&
      status !== 304 &&
      !(reqMethod === "HEAD" && status >= 200)
    ) {
      return;
    }
    headers_received = true;
    let surfaced = false;
    try {
      /* A Response with a null-body status may not carry a body at
         all - even a closed, empty stream is a body and makes the
         upstream Response construction throw TypeError - so the
         headers callback must receive null, not the stream;
         create_response then builds the only legal shape. The HEAD
         surface passes null for the same reason: the phantom body is
         empty by definition, and an empty stream body would surface
         a "complete" stream the wasm then errors on. */
      headers_callback(null as unknown as ReadableStream);
      surfaced = true;
    } catch {
      /* Bundle-shape fallback: hand over the (closed, empty) stream
         in case a different build accepts it. */
      try {
        headers_callback(stream);
        surfaced = true;
      } catch {
        /* no constructible response (status 0): fall through to the
           end-callback rejection and salvage paths below */
      }
    }
    if (surfaced) {
      try {
        stream_controller?.close();
      } catch {
        /* already closed or errored */
      }
    } else {
      headers_received = false;
    }
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
        try {
          stream_controller?.error("The operation was aborted.");
        } catch {
          /* already closed (bodiless surface) or errored: the
             stream reached its terminal state, abort is a no-op
             on it */
        }
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
  /* The HEAD surface needs the request method at stream_response time,
     but the wasm only learns it afterwards (request_async passes it
     through _http_set_options once the handle exists). Wrap
     request_async on the HTTPSession prototype to stash the method on
     the session for the duration of its synchronous body;
     patchedStreamResponse reads and captures it at entry. A missing
     request_async seam is bundle layout drift, same policy as a
     missing stream_response: hard failure. */
  const httpProto = Object.getPrototypeOf(session) as
    | {
        request_async?: unknown;
        __zl_method_patched?: boolean;
      }
    | null;
  if (!httpProto || typeof httpProto.request_async !== "function") {
    return false;
  }
  if (proto.__zl_eof_patched && httpProto.__zl_method_patched) return true;
  const orig = httpProto.request_async as (
    this: { __zl_req_method?: string },
    url: string,
    params: { method?: string },
    body: unknown,
  ) => Promise<unknown>;
  proto.stream_response = patchedStreamResponse;
  proto.__zl_eof_patched = true;
  httpProto.request_async = function (
    this: { __zl_req_method?: string },
    url: string,
    params: { method?: string },
    body: unknown,
  ): Promise<unknown> {
    /* request_async's body runs synchronously through
       this.stream_response() (a new Promise executor, no await before
       it), so nothing can interleave between this stash and the
       patched capture. Reset afterwards so a later bare
       stream_response call cannot inherit a stale method. */
    this.__zl_req_method = String(params?.method ?? "GET").toUpperCase();
    try {
      return orig.call(this, url, params, body);
    } finally {
      this.__zl_req_method = "GET";
    }
  };
  httpProto.__zl_method_patched = true;
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

/* Issue #74: connect-class failure detection + transport reset. A dead
   or never-opened wisp websocket is transport state, not a destination
   failure. The SW resets the singleton here and retries once instead of
   serving terminal 502s from a poisoned client. Pure surface, unit-gated
   in __tests__/transport-select.test.ts.
   #104: libcurl error 52 (server returned nothing) joins the class.
   An upstream that closed a pooled connection (plain HTTP often sends
   Connection: close) answers the reused connection with an empty
   reply; the reset drops the connection cache so the one retry rides
   a new connection. A genuine empty HTTP response still carries
   status and headers and is never error 52, so the retry cannot mask
   a real answer. */
import { setTransportState, transportState } from "./transport-lifecycle";

const CONNECT_CLASS_RE =
  /websocket did not open|failed sending data|failure when receiving data|server returned nothing|error code (?:52|55|56)\b/i;

export function isConnectClassError(err: unknown): boolean {
  return CONNECT_CLASS_RE.test(String(err));
}

/** Drop the libcurl/epoxy singletons so the next init() brings up a
    fresh transport with a new wisp websocket. Never throws. */
export function reset(): void {
  if (transportState() === "connecting" || transportState() === "connected") {
    setTransportState("dead", "singleton reset");
  }
  client = null;
  initPromise = null;
  epoxyClient = null;
  epoxyInitPromise = null;
}

/* ---- Wisp socket lifecycle watcher (#74 follow-up) ------------------
   The wasm transports create the browser WebSocket to the wisp endpoint
   and never surface its lifecycle. We cannot change the wasm - but the
   socket comes from this scope's WebSocket constructor. installWispWatcher
   wraps it once at module evaluation (before any transport init), observes
   every socket whose URL matches the endpoint of the last init() config,
   and when the last live one closes it drops the singletons and
   proactively re-inits with capped exponential backoff, so the next
   request finds a live transport instead of failing. Purely
   observational: the transports keep owning their sockets' events.
   ponytail: the timer glue is live-verified, not unit-gated; the pure
   part (reconnectDelay) is unit-tested in transport-select.test.ts. */

/** Capped exponential reconnect backoff: 1s doubling, 60s ceiling.
    Negative attempts clamp to the first step. */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, Math.max(0, attempt)), 60000);
}

interface WatcherGlobal {
  WebSocket?: typeof WebSocket;
  location?: { href: string };
}

const WATCH_FLAG = "__zlWispWatch";
const liveWisp = new Set<WebSocket>();
let lastCfg: { websocket: string } | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return; // one timer at most
  const delay = reconnectDelay(reconnectAttempt++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    /* A socket constructed since scheduling means someone re-initialized
       already - do not kill a live transport. */
    if (!lastCfg || liveWisp.size > 0) return;
    reset();
    init(lastCfg).catch(scheduleReconnect);
  }, delay);
}

/** Wrap the scope's WebSocket so wisp-endpoint sockets can be observed.
    Idempotent; a no-op where no WebSocket exists (tests, non-SW hosts). */
export function installWispWatcher(g: WatcherGlobal = globalThis as WatcherGlobal): void {
  const Orig = g.WebSocket;
  if (!Orig || (Orig as unknown as Record<string, unknown>)[WATCH_FLAG]) return;
  class ZlWispWebSocket extends Orig {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      try {
        const base = g.location?.href ?? "https://localhost/";
        const target = new URL(String(url), base);
        const wisp = lastCfg ? new URL(lastCfg.websocket, base) : null;
        if (!wisp || target.origin !== wisp.origin || target.pathname !== wisp.pathname) return;
        liveWisp.add(this);
        this.addEventListener("open", () => {
          reconnectAttempt = 0; // healthy again: backoff restarts from 1s
          setTransportState("connected", "wisp socket open");
        });
        this.addEventListener("close", () => {
          liveWisp.delete(this);
          if (liveWisp.size === 0) {
            setTransportState("dead", "last wisp socket closed");
            if (lastCfg) scheduleReconnect();
          }
        });
      } catch {
        /* not a parseable URL: none of our business */
      }
    }
  }
  (ZlWispWebSocket as unknown as Record<string, unknown>)[WATCH_FLAG] = true;
  g.WebSocket = ZlWispWebSocket as typeof WebSocket;
}

installWispWatcher();

export async function init(cfg: { websocket: string }): Promise<void> {
  lastCfg = cfg;
  setTransportState("connecting", "init " + engine);
  try {
    if (engine === "epoxy") {
      await getEpoxy(cfg);
    } else {
      await getClient(cfg);
    }
  } catch (err) {
    setTransportState("dead", "init failed");
    throw err;
  }
  setTransportState("connected", "init ok " + engine);
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
  /* Null-body statuses (#92/#96): a 204/304 Response may not carry
     even an empty stream (TypeError), and the client hands back
     whatever the session built - normalize to the only legal
     shape. Semantically identical: these statuses have no body by
     definition. */
  const nullBody = res.status === 204 || res.status === 304;
  const resp = new Response(nullBody ? null : (res.body as BodyInit | null), {
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
