/* Zeolite worker prelude (Phase 6, 1.6 Hydride). The service worker
   prepends this to every classic/shared worker script it serves, with
   three baked-in globals on the injected first line:
     self.__ZL_PREFIX__      the live engine route prefix
     self.__ZL_SCHEME__      the live route scheme (issue #20)
     self.__ZL_WORKER_URL__  the upstream worker script URL

   Inside the worker: importScripts() arguments and fetch() inputs are
   routed through the engine codec (a raw cross-origin importScripts
   would bypass the engine and its subresource fetches would fail; a
   root-relative worker fetch resolves engine-local and escapes to the
   embedder origin), and worker
   WebSocket is bridged over postMessage to the parent page, which
   relays to the engine's existing zl:wsOpen seam. 2.3 Selenide:
   shared workers bridge the same way over their newest connect port
   (no parent page postMessage exists there); module workers get
   specifier routing from the SW body pass instead of this prelude,
   where importScripts does not exist (their fetch() inputs still
   route from here). */

import { encodeDest, setScheme } from "./codec";

/** Route one worker-issued URL (an importScripts() argument or a
    fetch() input) through the engine codec, resolved against the
    upstream worker URL. Engine-local, opaque (blob:/data:) and
    unparseable arguments are returned untouched. */
export function routeWorkerUrl(
  prefix: string,
  workerUrl: string,
  engineOrigin: string,
  arg: string,
): string {
  let abs: URL;
  try {
    abs = new URL(arg, workerUrl);
  } catch {
    return arg;
  }
  if (abs.origin === engineOrigin) return arg;
  if (abs.protocol !== "http:" && abs.protocol !== "https:") return arg;
  /* The worker realm starts at codec defaults, so the live scheme is
     baked beside the prefix: without it a mirror deployment encodes
     b64u routes the SW can never decode (issue #20). */
  setScheme(prefix, G.__ZL_SCHEME__);
  return encodeDest(abs.href);
}

/* ---- in-worker wiring ------------------------------------------------
   Guarded so importing this module under vitest (or in a module
   worker, where importScripts does not exist) is a no-op. */

const G = globalThis as unknown as {
  importScripts?: (...args: string[]) => void;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  __ZL_PREFIX__?: string;
  __ZL_SCHEME__?: "b64u" | "mirror";
  __ZL_WORKER_URL__?: string;
  WebSocket?: new (u: string, p?: string | string[]) => WebSocket;
  postMessage?: (m: unknown, t?: Transferable[]) => void;
  location?: { href: string; origin: string };
};

/* The baked prefix marks a prelude-injected worker context; plain
   module imports (vitest) stay no-ops. */
const prefix = G.__ZL_PREFIX__;
const workerUrl = G.__ZL_WORKER_URL__ ?? G.location?.href ?? "";
const engineOrigin = G.location?.origin ?? "";

if (prefix && typeof G.importScripts === "function") {
  const IS = G.importScripts.bind(globalThis);
  (globalThis as { importScripts?: unknown }).importScripts = (...args: string[]) =>
    IS(...args.map((a) => routeWorkerUrl(prefix, workerUrl, engineOrigin, a)));
}

/* Issue #4: a worker fetch() with a root-relative URL resolves against
   the worker script's engine-local URL, escapes to the embedder origin
   and 404s. Same rule as importScripts: resolve against the upstream
   worker URL and route cross-origin http(s) through the codec. Both
   classic and module workers get this prelude. */
if (prefix && typeof G.fetch === "function") {
  const OF = G.fetch.bind(globalThis);
  (globalThis as { fetch?: unknown }).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    /* Request objects carry one-shot bodies that cannot be replayed
       through a rebuilt URL; they pass to the native fetch untouched. */
    if (url === null) return OF(input, init);
    return OF(routeWorkerUrl(prefix, workerUrl, engineOrigin, url), init);
  };
}

/* Dedicated-worker WebSocket bridge: same event semantics as the page
   bootstrap shim, but the channel is opened towards the parent page,
   which forwards to the service worker. 2.3 Selenide: shared workers
   have no parent-page postMessage, so the shim relays over the newest
   connect port instead - the page-side bootstrap relay (installed on
   worker.port by the SharedWorker constructor wrapper) carries the
   transferred port to the SW once, and all event traffic then flows on
   the shim's private MessageChannel. The engine is the relay, not a
   page: no page code ever sees a WebSocket event. A shared shim with
   no connected port fails closed (error + 1006 close), never native. */
const sharedPorts: unknown[] = [];
const SHARED =
  typeof G.postMessage !== "function" &&
  typeof (globalThis as { onconnect?: unknown }).onconnect !== "undefined";
if (SHARED && typeof (globalThis as { addEventListener?: unknown }).addEventListener === "function") {
  (globalThis as unknown as { addEventListener: (t: string, l: (ev: MessageEvent) => void) => void }).addEventListener("connect", (ev) => {
    const p = ev.ports?.[0];
    if (p) sharedPorts.push(p);
  });
}

/** The port a shared-worker shim relays over: the newest connect port.
    Pure, testable. */
export function pickRelayPort<T>(ports: T[]): T | null {
  return ports.length ? ports[ports.length - 1] : null;
}

if ((typeof G.postMessage === "function" || SHARED) && typeof G.WebSocket === "function") {
  const OWS = G.WebSocket;
  const LJWS = function (url: string, protocols?: string | string[]) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new DOMException(String(url), "SyntaxError");
    }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") {
      return protocols === undefined ? new OWS(url) : new OWS(url, protocols);
    }
    const es = new EventTarget() as unknown as WebSocket;
    let wsState = 0;
    let binType: "blob" | "arraybuffer" = "blob";
    let proto = "";
    const ch = new MessageChannel();
    let q = Promise.resolve();
    const disp = (e: Event) => {
      q = q.then(() => void es.dispatchEvent(e));
    };
    const fail = () => {
      wsState = 3;
      disp(new Event("error"));
      disp(new CloseEvent("close", { code: 1006, wasClean: false }));
    };
    ch.port1.onmessage = (ev) => {
      const m = ev.data as {
        ev?: string;
        data?: unknown;
        code?: number;
        clean?: boolean;
        protocol?: string;
      };
      if (m?.ev === "open") {
        wsState = 1;
        proto = m.protocol ?? "";
        disp(new Event("open"));
      } else if (m?.ev === "message") {
        q = q.then(async () => {
          let data: unknown = m.data;
          if (binType === "arraybuffer" && data instanceof Blob) {
            data = await data.arrayBuffer();
          }
          es.dispatchEvent(new MessageEvent("message", { data, origin: u.origin }));
        });
      } else if (m?.ev === "error") {
        disp(new Event("error"));
      } else if (m?.ev === "close") {
        wsState = 3;
        disp(new CloseEvent("close", { code: m.code ?? 1005, wasClean: m.clean !== false }));
      }
    };
    const wsMsg = {
      zl: "ws",
      msg: {
        type: "zl:wsOpen",
        url,
        protocols: protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols],
      },
    };
    if (typeof G.postMessage === "function") {
      G.postMessage(wsMsg, [ch.port2]);
    } else {
      const relay = pickRelayPort(sharedPorts as MessagePort[]);
      if (!relay) {
        fail();
      } else {
        relay.postMessage(wsMsg, [ch.port2]);
      }
    }

    Object.defineProperties(es, {
      readyState: { get: () => wsState },
      url: { value: url },
      protocol: { get: () => proto },
      binaryType: {
        get: () => binType,
        set: (v: string) => {
          if (v === "blob" || v === "arraybuffer") binType = v;
        },
      },
      bufferedAmount: { value: 0 },
      extensions: { value: "" },
      close: {
        value: (code?: number, reason?: string) => {
          if (wsState === 3) return;
          wsState = 2;
          ch.port1.postMessage({ op: "close", code: code ?? 1000, reason });
        },
      },
      send: {
        value: (data: unknown) => {
          /* Spec: send() while CONNECTING buffers (the bridge queues
             until the handshake completes); only CLOSING/CLOSED throw. */
          if (wsState >= 2) throw new DOMException("invalid state", "InvalidStateError");
          ch.port1.postMessage({ op: "send", data });
        },
      },
    });
    return es;
  } as unknown as new (u: string, p?: string | string[]) => WebSocket;
  (LJWS as unknown as { CONNECTING: number }).CONNECTING = 0;
  (LJWS as unknown as { OPEN: number }).OPEN = 1;
  (LJWS as unknown as { CLOSING: number }).CLOSING = 2;
  (LJWS as unknown as { CLOSED: number }).CLOSED = 3;
  (LJWS as unknown as { prototype: object }).prototype = OWS.prototype;
  (globalThis as { WebSocket?: unknown }).WebSocket = LJWS;
}
