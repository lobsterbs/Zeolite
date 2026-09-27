/* Zeolite runtime bootstrap. Injected into proxied HTML by the
 rewriter ( right after opens).

 Budget: under 5 KB minified (CI enforces). It only patches behavior:
 storage scoping, history, Worker constructors, WebSocket routing.
 URL-level fetch/XHR need no patch: pages navigate within engine-local
 paths that the service worker intercepts natively.

 Page-global contract (set by the rewriter at injection time):
 window.__ZL = { dest: "https://real.site/page" }
 falls back to document.baseURI when absent. */

const w = window as unknown as Record<string, unknown>;
const ZL = ((w.__ZL as { dest: string } | undefined) ??
 { dest: document.baseURI }) as { dest: string };

/* ---- per-site storage scoping ------------------------------------- */
/* Everything is prefixed by a short stable hash of the site origin:
 engine-origin storage is never touched by a proxied site, and two
 proxied sites never see each other's data. The prefix doubles as the
 session-export filter: everything under "zl::" travels in the
 blob, everything else stays put. */

function siteKey(): string {
 try {
 return String(new URL(ZL.dest).origin);
 } catch {
 return "unknown";
 }
}

function fnv1a(s: string): string {
 let h = 0x811c9dc5;
 for (let i = 0; i < s.length; i++) {
 h ^= s.charCodeAt(i);
 h = (h * 0x01000193) >>> 0;
 }
 return h.toString(36);
}

const SITE = "zl:" + fnv1a(siteKey());
const KEY = (k: string) => SITE + ":" + k;

/* One scanner for clear/key/length: keeps the scoped Storage cheap
 and the minified bootstrap inside its CI size budget. */
function siteKeys(store: Storage): string[] {
 const ks: string[] = [];
 for (let i = 0; i < store.length; i++) {
 const k = store.key(i);
 if (k && k.startsWith(SITE + ":")) ks.push(k);
 }
 return ks;
}

{
 const LS = w.localStorage;
 if (LS && typeof LS === "object") {
 const store = LS as Storage;
 const api = {
 getItem: (k: string) => store.getItem(KEY(k)),
 setItem: (k: string, v: string) => store.setItem(KEY(k), v),
 removeItem: (k: string) => store.removeItem(KEY(k)),
 clear: () => {
 siteKeys(store).forEach((k) => store.removeItem(k));
 },
 key: (i: number) => siteKeys(store)[i] ?? null,
 get length() {
 return siteKeys(store).length;
 },
 };
 const scoped = Object.assign(Object.create(Storage.prototype), api) as Storage;
 try {
 Object.defineProperty(w, "localStorage", { value: scoped, configurable: true });
 } catch { /* read-only context: storage then stays unscoped */ }
 }
}

/* ---- history ------------------------------------------------------- */
/* Same-origin engine paths mean pushState works natively; this patch
 only normalizes URL arguments so the address bar never leaks a raw
 destination string outside the engine path scheme. */

{
 const push = History.prototype.pushState;
 const replace = History.prototype.replaceState;
 History.prototype.pushState = function (s: unknown, t: string, u?: string | URL) {
 return push.call(this, s, t, u === undefined ? undefined : String(u));
 };
 History.prototype.replaceState = function (s: unknown, t: string, u?: string | URL) {
 return replace.call(this, s, t, u === undefined ? undefined : String(u));
 };
}

/* ---- Worker constructor ------------------------------------------- */
/* Workers load same-origin engine paths (intercepted by the SW); blob
 workers pass through untouched since their fetches go through the
 SW anyway. */

{
 const OW = w.Worker as (new (u: string | URL, o?: WorkerOptions) => Worker) | undefined;
 if (OW) {
 const W = function (u: string | URL, o?: WorkerOptions) {
 return new OW(String(u), o);
 } as unknown as typeof OW;
 W.prototype = OW.prototype;
 (w as { Worker?: unknown }).Worker = W;
 }
}

/* ---- WebSocket ---------------------------------------------------- */
/* The SW cannot intercept WebSocket upgrades, so ws(s):// URLs are
   bridged: this shim posts zl:wsOpen to the controlling SW with a
   dedicated port. The SW opens the connection through the libcurl
   transport (TLS terminates there; a raw wisp TCP stream runs
   underneath) and relays open/message/error/close back over the port.
   Event semantics match the native constructor, so reconnecting
   libraries keep working. Non-ws schemes go to the native ctor. */

{
  const OWS = w.WebSocket as
    | (new (u: string, p?: string | string[]) => WebSocket)
    | undefined;
  if (OWS) {
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
        q = q.then(() => es.dispatchEvent(e));
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
      const ctl = navigator.serviceWorker?.controller;
      if (!ctl) {
        fail();
      } else {
        ctl.postMessage(
          {
            type: "zl:wsOpen",
            url,
            protocols:
              protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols],
          },
          [ch.port2],
        );
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
            if (wsState !== 1) throw new DOMException("invalid state", "InvalidStateError");
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
    (w as { WebSocket?: unknown }).WebSocket = LJWS;
  }
}
