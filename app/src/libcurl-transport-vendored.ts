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
  await getClient(cfg);
}

export async function fetch(url: string, init?: RequestInit): Promise<Response> {
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
  close(code: number, reason: string): void;
}
export function openWebSocket(
  url: string,
  protocols: string[],
  h: WsHandlers,
  requestHeaders: RawHeaders = [],
): WsHandle {
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
  return { send, close };
}

