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
export function openWebSocket(url: string, protocols: string[], h: WsHandlers): WsHandle {
  if (!client) throw new Error(MISSING);
  const [send, close] = client.connect(
    new URL(url),
    protocols,
    [],
    (protocol) => h.onopen(protocol),
    (data) => h.onmessage(data),
    (code, reason) => h.onclose(code, reason),
    (error) => h.onerror(error),
  );
  return { send, close };
}

