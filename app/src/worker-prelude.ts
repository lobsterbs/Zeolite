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
import { siteToken } from "./pageload";
import { validateWsClose } from "./ws-close";
import { wsPayload } from "./ws-payload";

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
  const r = encodeDest(abs.href);
  /* #537: a blob worker's location is opaque (blob:), so a
     root-relative engine route is unparseable there. Serve absolute
     engine URLs to every caller: engine-served workers resolve them
     the same way, blob workers only work with the absolute form. */
  return engineOrigin && r.startsWith("/") ? engineOrigin + r : r;
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
/* Issue #229: successful mints used to stay memoized for the lifetime
   of the worker realm, so a long-lived worker fetching many unique
   destinations grew the map without bound. The memo is now capped;
   the least recently used entry is evicted. Dropping an entry only
   costs a re-mint round trip - the SW-side route-key history keeps
   old minted routes decodable. */
const MINT_MEMO_CAP = 256;

/** Mint an engine route from a worker, over the page relay post
    (dedicated workers: the Worker object's own message channel;
    shared workers: the newest connect port). The page bootstrap
    hooks both channels and filters wrapper shapes out of the app's
    handlers. post returns false when it cannot deliver; a silent
    port times out to null. */
export function mintUrlViaRelay(
  post: ((m: unknown, t?: Transferable[]) => boolean | void) | null,
  dest: string,
  timeout = 5000,
): Promise<string | null> {
  if (!post) return Promise.resolve(null);
  const hit = mintMemo.get(dest);
  if (hit) {
    // LRU by recency: re-insert so eviction order tracks usage.
    mintMemo.delete(dest);
    mintMemo.set(dest, hit);
    return hit;
  }
  const p = new Promise<string | null>((resolve) => {
    const ch = new MessageChannel();
    let done = false;
    const fin = (route: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ch.port1.onmessage = null;
      ch.port1.close();
      ch.port2.close();
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
  if (mintMemo.size >= MINT_MEMO_CAP) {
    const oldest = mintMemo.keys().next();
    if (!oldest.done) mintMemo.delete(oldest.value);
  }
  mintMemo.set(dest, p);
  p.then((route) => {
    /* #459: delete only OUR entry - an evicted promise settling
       after a newer mint for the same dest must not drop it. */
    if (!route && mintMemo.get(dest) === p) mintMemo.delete(dest);
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
  __ZL_SITE__?: string;
  __zlPreludeInit?: (route: string) => void;
  WebSocket?: new (u: string, p?: string | string[]) => WebSocket;
  postMessage?: (m: unknown, t?: Transferable[]) => void;
  location?: { href: string; origin: string };
  addEventListener?: (t: string, l: (ev: MessageEvent) => void) => void;
  onconnect?: unknown;
  Worker?: new (u: string, o?: WorkerOptions) => Worker;
  XMLHttpRequest?: new () => XMLHttpRequest;
  URL?: { createObjectURL: (b: unknown) => string; revokeObjectURL: (u: string) => void };
  Blob?: new (p: unknown[], o?: { type: string }) => unknown;
  __ZL_WORKER_BASE__?: string;
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
  /* #537: blob workers get the creating page's virtual URL baked as
     __ZL_WORKER_BASE__; it wins over the decoded route (the /zl-bw/
     engine route under them is not a usable base for their relative
     fetch/importScripts resolution). */
  const base = typeof G.__ZL_WORKER_BASE__ === "string" ? G.__ZL_WORKER_BASE__ : "";
  const workerUrl = base || (decodePath(route) ?? G.location?.href ?? "");
  const engineOrigin = G.location?.origin ?? "";

  /* #171: worker realms get the same per-site storage scoping the
     page bootstrap installs (indexedDB, caches, BroadcastChannel,
     all prefixed "zl:<site>:"). Opaque worker scripts (blob:/data:)
     have no decodable upstream URL, so the SW bakes
     self.__ZL_SITE__ into their prelude head; route workers derive
     the token from their upstream URL instead. */
  const site = G.__ZL_SITE__ ?? siteToken(workerUrl);
  applyWorkerStorage(globalThis, "zl:" + site + ":");

  if (typeof G.importScripts === "function") {
    const IS = G.importScripts.bind(globalThis);
    (globalThis as { importScripts?: unknown }).importScripts = (...args: string[]) =>
      IS(...args.map((a) => routeWorkerUrl(prefix, workerUrl, engineOrigin, a)));
  }
  /* #537: workers created INSIDE a worker (nested blob workers) get
     the same treatment the page bootstrap gives page-created blob
     workers: the original blob source is read synchronously (a sync
     XHR of a blob: URL completes before app code can revoke it),
     inlined behind an import of the engine's /zl-bw/ prelude route,
     and the nested realm inherits this realm's site token and base.
     Any failure falls back to the native constructor (documented
     residual), which still leaves fetches engine-routed through
     the #34 interception path. */
  if (typeof G.Worker === "function" && typeof G.XMLHttpRequest === "function") {
    const OW = G.Worker;
    const XHR = G.XMLHttpRequest;
    const readBlob = (u: string): string | null => {
      try {
        const x = new XHR();
        x.open("GET", u, false);
        x.send(null);
        return x.status === 200 && typeof x.responseText === "string" ? x.responseText : null;
      } catch {
        return null;
      }
    };
    const NW = function (u: string, o?: WorkerOptions): Worker {
      if (typeof u === "string" && u.startsWith("blob:")) {
        const text = readBlob(u);
        if (text !== null) {
          try {
            const mod = !!(o && o.type === "module");
            const bw = engineOrigin + "/zl-bw/?c=" + encodeURIComponent(JSON.stringify({ s: site, b: workerUrl }));
            /* static import declaration for module wrappers (see
               relay.ts); the module wrapper self-revokes at the end
               of its body because Chromium 131 resolves a module
               worker's blob asynchronously, past this constructor,
               so an immediate revoke kills the load */
            const src = mod
              ? "import " + JSON.stringify(bw) + ";\n" + text +
                "\n;try{URL.revokeObjectURL(self.location.href)}catch{}"
              : "importScripts(" + JSON.stringify(bw) + ");\n" + text;
            const wu = G.URL!.createObjectURL(new G.Blob!([src], { type: "text/javascript" }));
            const wk = new OW(wu, o);
            if (!mod) try { G.URL!.revokeObjectURL(wu); } catch { /* best effort */ }
            return wk;
          } catch { /* fall through to native */ }
        }
      }
      return new OW(u, o);
    } as unknown as new (u: string, o?: WorkerOptions) => Worker;
    Object.defineProperty(NW, "name", { value: "Worker", configurable: true });
    try { G.Worker = NW; } catch { /* read-only: nested workers stay native */ }
  }

  /* #537: a nested dedicated worker's mint/WebSocket relays arrive
     here (its G.postMessage posts to THIS realm, not the page).
     Forward wrapper shapes up the chain so they reach the page tap
     and the engine; app messages stay untouched, and anything that
     is not a wrapper shape never moves. Without this arm a nested
     worker rides the legacy codec route (its documented fallback). */
  if (typeof G.addEventListener === "function" && typeof G.postMessage === "function") {
    G.addEventListener("message", (ev: MessageEvent) => {
      const d = ev.data as { zl?: unknown } | null;
      if (d && typeof d === "object" && (d.zl === "ws" || d.zl === "mint")) {
        try { G.postMessage!(d, (ev.ports ?? []) as MessagePort[]); } catch { /* dropped */ }
      }
    });
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
     records either. The legacy codec route stays the fallback (a
     refused mint, a timeout, a page whose Worker hook could not
     install). Request objects carry one-shot
     bodies that cannot be replayed through a rebuilt URL; they pass
     to the native fetch untouched, a documented residual. */
  if (typeof G.fetch === "function") {
    const OF = G.fetch.bind(globalThis);
    /* Dedicated workers post the wrapper on the Worker object's
       own message channel; shared workers use their newest connect
       port. The page bootstrap's Worker/SharedWorker hooks carry
       both to the engine and filter them out of the app's
       handlers. */
    const post: ((m: unknown, t?: Transferable[]) => boolean | void) | null =
      typeof G.postMessage === "function"
        ? (m, t) => {
            G.postMessage!(m, t);
            return true;
          }
        : (m, t) => {
            const p = pickRelayPort(sharedPorts as MessagePort[]);
            if (!p) return false;
            p.postMessage(m, t ?? []);
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
      /* #537: minted routes arrive root-relative; a blob worker's
         base cannot resolve them, so anchor engine routes to the
         worker's real origin (the blob inner origin for blob
         workers, the engine origin for engine-served ones). */
      const absRoute = (r: string | null): string | null =>
        r && r.startsWith("/") ? engineOrigin + r : r;
      return mintUrlViaRelay(post, abs.href).then((route) => {
        const headers = new Headers(init?.headers);
        headers.set("x-zl-init", "worker-fetch");
        return OF(
          absRoute(route) ?? routeWorkerUrl(prefix, workerUrl, engineOrigin, url),
          { ...init, headers },
        );
      });
    };
  }

  /* Dedicated-worker WebSocket bridge: same event semantics as the page
     bootstrap shim, but the channel is opened towards the parent page
     (the page bootstrap's Worker constructor hook carries it to the
     service worker and filters the wrapper out of the app's
     handlers). 2.3 Selenide: shared workers
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
      /* instanceof parity: the EventTarget keeps its internal slots
         and adopts the real prototype; own plain on-handler props
         shadow the prototype's brand-checked accessors so
         fireHandler still reads plain data. */
      Object.setPrototypeOf(es, OWS.prototype);
      for (const h of ["onopen", "onmessage", "onerror", "onclose"])
        Object.defineProperty(es, h, {
          writable: true,
          enumerable: true,
          configurable: true,
          value: null,
        });
      let wsState = 0;
      let binType: "blob" | "arraybuffer" = "blob";
      let proto = "";
      let bufferedBytes = 0;
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
          bytes?: number;
        };
        /* Native parity: once CLOSING/CLOSED no further open or
           message events fire (a late engine open or a message
           racing a close is dropped). */
        if (m?.ev === "open") {
          if (wsState >= 2) return;
          wsState = 1;
          proto = m.protocol ?? "";
          disp(new Event("open"));
        } else if (m?.ev === "message") {
          if (wsState >= 2) return;
          q = q.then(async () => {
            let data: unknown = m.data;
            if (binType === "arraybuffer" && data instanceof Blob) {
              data = await data.arrayBuffer();
            }
            fire(new MessageEvent("message", { data, origin: u.origin }));
          });
        } else if (m?.ev === "drain") {
          if (typeof m.bytes === "number" && Number.isFinite(m.bytes) && m.bytes >= 0)
            bufferedBytes = Math.max(0, bufferedBytes - Math.floor(m.bytes));
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
        /* Counts bytes pending acceptance by the SW bridge; actual
           Wisp/network flush completion is not observable. */
        bufferedAmount: { get: () => bufferedBytes },
        extensions: { value: "" },
        close: {
          value: (code?: number, reason?: string) => {
            const normalized = validateWsClose(code, reason);
            if (wsState >= 2) return;
            wsState = 2;
            ch.port1.postMessage({ op: "close", code: normalized.code ?? 1000, reason: normalized.reason });
          },
        },
        send: {
          value: (data: unknown) => {
            const payload = wsPayload(data);
            if (wsState === 0) throw new DOMException("invalid state", "InvalidStateError");
            if (wsState >= 2) { bufferedBytes += payload.bytes; return; }
            ch.port1.postMessage({ op: "send", data: payload.data });
            bufferedBytes += payload.bytes;
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

/* #171: per-site storage scoping for worker realms, mirroring the
   page bootstrap's bootstrap/storage.ts + isolation.ts shims: DB and
   cache names carry the site prefix (two proxied sites never share a
   database or a cache, and neither touches an engine-own one), and
   BroadcastChannel names are prefixed the same way. databases() is
   exposed prefix-filtered with stripped names only where the host
   factory provides it (#555); elsewhere it stays honestly absent.
   Exported so worker.test.ts pins it. */
export function applyWorkerStorage(t: Record<string, unknown>, P: string): void {
  const pre = (n: string) => P + n;
  {
    const IDB = t.indexedDB as IDBFactory | undefined;
    if (IDB) {
      const OPEN = IDB.open.bind(IDB);
      const DEL = IDB.deleteDatabase.bind(IDB);
      const shim: Record<string, unknown> = {
        open: (n: string, v?: number) => OPEN(pre(n), v),
        deleteDatabase: (n: string) => DEL(pre(n)),
      };
      const DBS = (IDB as unknown as {
        databases?: () => Promise<Array<{ name?: string; version?: number }>>;
      }).databases;
      if (typeof DBS === "function") {
        const call = DBS.bind(IDB);
        shim.databases = async () =>
          (await call())
            .filter((d) => typeof d.name === "string" && d.name.startsWith(P))
            .map((d) => ({ name: (d.name as string).slice(P.length), version: d.version }));
      }
      if (typeof IDB.cmp === "function") {
        const CMP = IDB.cmp.bind(IDB);
        shim.cmp = (a: string, b: string) => CMP(pre(a), pre(b));
      }
      try {
        Object.defineProperty(t, "indexedDB", { value: shim, configurable: true });
      } catch { /* read-only: stays unscoped */ }
    }
  }
  {
    const CA = t.caches as CacheStorage | undefined;
    if (CA) {
      const OPEN = CA.open.bind(CA);
      const DEL = CA.delete.bind(CA);
      const HAS = CA.has.bind(CA);
      const KEYS = CA.keys.bind(CA);
      const own = (n: string) => n.startsWith(P);
      const shim: Record<string, unknown> = {
        open: (n: string) => OPEN(pre(n)),
        delete: (n: string) => DEL(pre(n)),
        has: (n: string) => HAS(pre(n)),
        keys: () => KEYS().then((ks) => ks.filter(own).map((n) => n.slice(P.length))),
        match: async (rq: Request | string, o?: CacheQueryOptions) => {
          for (const n of await KEYS()) {
            if (!own(n)) continue;
            const hit = await (await CA.open(n)).match(rq, o);
            if (hit) return hit;
          }
          return undefined;
        },
      };
      try {
        Object.defineProperty(t, "caches", { value: shim, configurable: true });
      } catch { /* read-only: stays unscoped */ }
    }
  }
  {
    const BC = t.BroadcastChannel as (new (name: string) => BroadcastChannel) | undefined;
    if (typeof BC === "function") {
      const BCtor: new (name: string) => BroadcastChannel = BC;
      const ScopedChannel = function (this: unknown, name: string): BroadcastChannel & { name: string } {
        const real = new BCtor(P + name);
        return {
          name,
          get onmessage() {
            return real.onmessage;
          },
          set onmessage(fn) {
            real.onmessage = fn;
          },
          get onmessageerror() {
            return real.onmessageerror;
          },
          set onmessageerror(fn) {
            real.onmessageerror = fn;
          },
          postMessage: (m: unknown) => real.postMessage(m),
          close: () => real.close(),
          addEventListener: (ev: string, l: unknown, o?: unknown) =>
            real.addEventListener(ev, l as EventListener, o as boolean | AddEventListenerOptions),
          removeEventListener: (ev: string, l: unknown, o?: unknown) =>
            real.removeEventListener(ev, l as EventListener, o as boolean | EventListenerOptions),
          dispatchEvent: (ev: Event) => real.dispatchEvent(ev),
        };
      };
      try {
        Object.defineProperty(t, "BroadcastChannel", { value: ScopedChannel, configurable: true });
      } catch { /* read-only: stays unscoped */ }
    }
  }
}

/* The baked init line calls this global after the module source. */
G.__zlPreludeInit = installWorkerPrelude;
