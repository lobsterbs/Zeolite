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
  /* Cookie jar access is not part of the declared API; it may exist
     on the session. Probed defensively at runtime. */
  session?: unknown;
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

async function getClient(cfg: { websocket: string }): Promise<LibcurlClientLike> {
  if (client && client.ready) return client;
  if (!initPromise) {
    initPromise = (async () => {
      let mod: { LibcurlClient?: unknown; default?: unknown };
      try {
        mod = (await import(/* @vite-ignore */ moduleUrl())) as typeof mod;
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
  return new Response(res.body as BodyInit | null, {
    status: res.status,
    statusText: res.statusText,
    headers: h2,
  });
}

/* Cookie jar access: the libcurl session holds cookies internally
   (per-site persistence across requests). Direct read/write is not in
   the declared API, so probe the session defensively and fail
   honestly rather than pretend. */
function sessionMethod(name: string): ((...args: unknown[]) => unknown) | null {
  const s = client?.session;
  if (s && typeof s === "object" && name in (s as Record<string, unknown>)) {
    const fn = (s as Record<string, unknown>)[name];
    if (typeof fn === "function") return fn as (...args: unknown[]) => unknown;
  }
  return null;
}

export async function getCookies(_url: string): Promise<Array<{ name: string; value: string }>> {
  if (!client) throw new Error("zeolite: transport not initialized (call init first)");
  const fn = sessionMethod("getCookies") ?? sessionMethod("dumpCookies");
  if (!fn) throw new Error("zeolite: cookie export not supported by vendored transport");
  const out = (await fn.call(client.session, _url)) as Array<{ name: string; value: string }>;
  return Array.isArray(out) ? out : [];
}

export async function setCookies(
  _url: string,
  _cookies: Array<{ name: string; value: string }>,
): Promise<void> {
  if (!client) throw new Error("zeolite: transport not initialized (call init first)");
  const fn = sessionMethod("setCookies") ?? sessionMethod("loadCookies");
  if (!fn) throw new Error("zeolite: cookie import not supported by vendored transport");
  await fn.call(client.session, _url, _cookies);
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
