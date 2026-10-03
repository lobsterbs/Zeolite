/* Zeolite worker prelude (Phase 6, 1.6 Hydride). The service worker
   prepends this to every classic/shared worker script it serves, with
   the live route prefix baked as a global, and appends one init line
   after the module source:
     self.__zlPreludeInit && self.__zlPreludeInit(<route-json>)
   The init argument is the worker's own engine route (encodeDest of
   the upstream script URL). installWorkerPrelude decodes it with the
   shared codec and keeps the real URL in the closure: issue #32
   removed the self.__ZL_WORKER_URL__ global, which handed the
   upstream URL to any worker script that cared to read it. The
   prefix stays a global - it is the engine's own route shape, not a
   secret.

   Inside the worker: importScripts() arguments and fetch() inputs are
   routed through the engine codec (a raw cross-origin importScripts
   would bypass the engine and its subresource fetches would fail; a
   root-relative worker fetch resolves engine-local and escapes to
   the embedder origin), and worker
   WebSocket is bridged over postMessage to the parent page, which
   relays to the engine's existing zl:wsOpen seam. 2.3 Selenide:
   shared workers bridge the same way over their newest connect port
   (no parent page postMessage exists there); module workers get
   specifier routing from the SW body pass instead of this prelude,
   where importScripts does not exist (their fetch() inputs still
   route from here). */

import { decodePath, encodeDest, setScheme } from "./codec";

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
  /* The worker realm starts at codec defaults, so the live prefix is
     re-asserted here: without it a rotated deployment encodes routes
     the SW decodes under a different shape (issue #20). */
  setScheme(prefix);
  return encodeDest(abs.href);
}

/* ---- worker mint (#54 residual 5) ----------------------------------
   The worker realm has no service worker, so a worker-side mint
   rides the same relay a worker WebSocket rides: the prelude posts
   a zl:mint control message (wrapped for the page relay, which
   forwards it with the transferred port) and the engine replies on
   the port with the minted route. Contract identical to the page
   client: resolve the route or null - null means the caller falls
   back to the legacy codec route. Successes memoize; failures are
   deleted so a retry after the page settles can succeed. */

const mintMemo = new Map<string, Promise<string | null>>();

/** Mint an engine route from a worker, over the page relay post
    (dedicated workers: the parent-page postMessage; shared workers:
    the newest connect port). post returns false when it cannot
    deliver; a silent port times out to null. */
export function mintUrlViaRelay(
  post: ((m: unknown, t?: Transferable[]) => boolean | void) | null,
  dest: string,
  timeout = 5000,
): Promise<string | null> {
  if (!post) return Promise.resolve(null);
  const hit = mintMemo.get(dest);
  if (hit) return hit;
  const p = new Promise<string | null>((resolve) => {
    const ch = new MessageChannel();
    let done = false;
    const fin = (route: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(route);
    };
    const timer = setTimeout(() => fin(null), timeout);
    ch.port1.onmessage = (ev) => {
      const m = ev.data as { ok?: boolean; route?: unknown };
      fin(typeof m?.route === "string" ? m.route : null);
    };
    let delivered = false;
    try {
      delivered = post({ zl: "mint", msg: { type: "zl:mint", dest } }, [ch.port2]) !== false;
    } catch {
      delivered = false;
    }
    if (!delivered) fin(null);
  });
  mintMemo.set(dest, p);
  p.then((route) => {
    if (!route) mintMemo.delete(dest);
  });
  return p;
}

/* ---- in-worker wiring ------------------------------------------------
   Guarded so importing this module under vitest (or in a module
   worker, where importScripts does not exist) stays inert until the
   baked init line runs. */

const G = globalThis as unknown as {
  importScripts?: (...args: string[]) => void;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  __ZL_PREFIX__?: string;
  __zlPreludeInit?: (route: string) => void;
  WebSocket?: new (u: string, p?: string | string[]) => WebSocket;
  postMessage?: (m: unknown, t?: Transferable[]) => void;
  location?: { href: string; origin: string };
  addEventListener?: (t: string, l: (ev: MessageEvent) => void) => void;
  onconnect?: unknown;
};

let installed = false;

/** Install the prelude hooks for this worker. Called by the baked
    init line with the worker's own engine route; the upstream URL it
    decodes to lives in the closure and never becomes a global
    (issue #32). Idempotent: a stray double init line keeps the first
    wiring instead of double-wrapping importScripts or fetch. */
export function installWorkerPrelude(route: string): void {
  const prefix = G.__ZL_PREFIX__;
  if (!prefix || installed) return; /* not a prelude context, or already wired */
  installed = true;
  setScheme(prefix);
  const workerUrl = decodePath(route) ?? G.location?.href ?? "";
  const engineOrigin = G.location?.origin ?? "";

  if (typeof G.importScripts === "function") {
    const IS = G.importScripts.bind(globalThis);
    (globalThis as { importScripts?: unknown }).importScripts = (...args: string[]) =>
      IS(...args.map((a) => routeWorkerUrl(prefix, workerUrl, engineOrigin, a)));
  }

  /* Shared-worker connect ports, collected before the fetch hook so
     the mint path can pick the newest one at call time (the WS shim
     below picks the same way). */
  const sharedPorts: unknown[] = [];
  const SHARED =
    typeof G.postMessage !== "function" &&
    typeof G.onconnect !== "undefined";
  if (SHARED && typeof G.addEventListener === "function") {
    G.addEventListener("connect", (ev) => {
      const p = ev.ports?.[0];
      if (p) sharedPorts.push(p);
    });
  }

  /* Issue #4: a worker fetch() with a root-relative URL resolves against
     the worker script's engine-local URL, escapes to the embedder origin
     and 404s. Same rule as importScripts: resolve against the upstream
     worker URL and route cross-origin http(s) through the codec. Both
     classic and module workers get this prelude.
     #54 residual 5: cross-origin http(s) inputs mint first - the
     keyed route leaves nothing decodable in the worker's request
     records either. The legacy codec route stays the fallback (no
     relay, refused mint, timeout). Request objects carry one-shot
     bodies that cannot be replayed through a rebuilt URL; they pass
     to the native fetch untouched, a documented residual. */
  if (typeof G.fetch === "function") {
    const OF = G.fetch.bind(globalThis);
    const post: ((m: unknown, t?: Transferable[]) => boolean | void) | null =
      typeof G.postMessage === "function"
        ? (m, t) => {
            G.postMessage!(m, t);
            return true;
          }
        : (m, t) => {
            const p = pickRelayPort(sharedPorts as MessagePort[]);
            if (!p) return false;
            p.postMessage(m, t);
            return true;
          };
    (globalThis as { fetch?: unknown }).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
      if (url === null) return OF(input, init);
      let abs: URL;
      try {
        abs = new URL(url, workerUrl);
      } catch {
        return OF(input, init);
      }
      if (abs.origin === engineOrigin) return OF(input, init);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") return OF(input, init);
      return mintUrlViaRelay(post, abs.href).then((route) =>
        OF(route ?? routeWorkerUrl(prefix, workerUrl, engineOrigin, url), init),
      );
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
      /* Same contract as the page shim: raw on* handlers fire after
         the registered listeners, contained. */
      const fire = (e: Event) => {
        es.dispatchEvent(e);
        fireHandler(es, e);
      };
      const disp = (e: Event) => {
        q = q.then(() => void fire(e));
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
            fire(new MessageEvent("message", { data, origin: u.origin }));
          });
        } else if (m?.ev === "error") {
          disp(new Event("error"));
          /* A terminal error carries the close code: the page relay's
             fail-close when no service worker controls the page. The
             engine bridge sends error and close as separate events,
             so its errors carry no code and behave as before. */
          if (m.code) {
            wsState = 3;
            disp(new CloseEvent("close", { code: m.code, wasClean: m.clean !== false }));
          }
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
        url: { value: u.href },
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
}

/** The port a shared-worker shim relays over: the newest connect port.
    Pure, testable. */
export function pickRelayPort<T>(ports: T[]): T | null {
  return ports.length ? ports[ports.length - 1] : null;
}

/** Invoke a raw "on"+type event-handler property on a shim target.
    The shims' EventTarget has no native event-handler slots, so the
    dispatch seam calls this after the registered listeners (native
    interleaves in registration order); a throwing handler is
    contained so it cannot kill the event queue. Exported so
    worker.test.ts pins the contract. */
export function fireHandler(t: object, e: Event): void {
  const h = (t as Record<string, unknown>)["on" + e.type] as
    | ((ev: Event) => unknown)
    | undefined;
  try {
    if (h) h.call(t, e);
  } catch { /* contained, like a native listener */ }
}

/* The baked init line calls this global after the module source. */
G.__zlPreludeInit = installWorkerPrelude;
