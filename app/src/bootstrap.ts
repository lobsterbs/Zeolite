/* Zeolite runtime bootstrap. Injected into proxied HTML by the
 rewriter ( right after opens).

 Budget: under 5 KB minified (CI enforces). It only patches behavior:
 storage scoping, storage/cookie virtualization, the shared-worker
 port relay, WebSocket routing, the worker WebSocket relay and the
 navigator.serviceWorker shim.
 URL-level fetch/XHR need no patch: pages navigate within engine-local
 paths that the service worker intercepts natively.

 Page-global contract (set by the rewriter at injection time):
 window.__ZL = { dest: "https://real.site/page" }
 falls back to document.baseURI when absent. */

import { swShimApply } from "./swshim";

const w = window as unknown as Record<string, unknown>;
const ZL = ((w.__ZL as { dest: string } | undefined) ??
 { dest: document.baseURI }) as { dest: string };

/* ---- per-site storage scoping ------------------------------------- */
/* Everything is prefixed by a short stable hash of the site origin:
 engine-origin storage is never touched by a proxied site, and two
 proxied sites never see each other's data. The prefix doubles as the
 session-export filter: everything under "zl::" travels in the
 blob, everything else stays put. */

function fnv1a(s: string): string {
 let h = 0x811c9dc5;
 for (let i = 0; i < s.length; i++) {
 h ^= s.charCodeAt(i);
 h = (h * 0x01000193) >>> 0;
 }
 return h.toString(36);
}

/* The page origin ("" when unparseable): the storage prefix derives
 from it and the cookie / serviceWorker shims share it. */
const ORIGIN = (() => {
 try {
 return new URL(ZL.dest).origin;
 } catch {
 return "";
 }
})();
const SITE = "zl:" + fnv1a(ORIGIN || "unknown");
const P = SITE + ":";
const pre = (n: unknown) => P + String(n);

/* One scanner for clear/key/length: keeps the scoped Storage cheap
 and the minified bootstrap inside its CI size budget. */
function siteKeys(store: Storage): string[] {
 const ks: string[] = [];
 for (let i = 0; i < store.length; i++) {
 const k = store.key(i);
 if (k?.startsWith(P)) ks.push(k);
 }
 return ks;
}

{
 for (const name of ["localStorage", "sessionStorage"] as const) {
 const LS = w[name] as Storage | undefined;
 if (!LS) continue;
 const scoped = {
 getItem: (k: string) => LS.getItem(pre(k)),
 setItem: (k: string, v: string) => LS.setItem(pre(k), v),
 removeItem: (k: string) => LS.removeItem(pre(k)),
 clear: () => {
 siteKeys(LS).forEach((k) => LS.removeItem(k));
 },
 key: (i: number) => siteKeys(LS)[i] ?? null,
 get length() {
 return siteKeys(LS).length;
 },
 } as Storage;
 try {
 Object.defineProperty(w, name, { value: scoped, configurable: true });
 } catch { /* read-only context: storage then stays unscoped */ }
 }
}

/* ---- IndexedDB + Cache API names ---------------------------------- */
/* 1.5 Silicide: DB and cache names get the same site prefix, so two
 proxied sites never share a database or a cache, and neither ever
 touches an engine-own one (the engine's IndexedDB and Cache usage
 lives in the service worker, not the page). */

{
 const IDB = w.indexedDB as IDBFactory | undefined;
 if (IDB) {
 const OPEN = IDB.open.bind(IDB);
 const DEL = IDB.deleteDatabase.bind(IDB);
 /* databases() is deliberately absent (honest unimplemented API):
    wrapping it would risk leaking engine-own database names. cmp()
    (2.2 Arsenide) compares two prefixed names, so ordering stays
    consistent inside the site scope; it is absent when the host
    factory does not provide it, rather than faked. */
 const shim: Record<string, unknown> = {
 open: (n: unknown, v?: number) => OPEN(pre(n), v),
 deleteDatabase: (n: unknown) => DEL(pre(n)),
 };
 if (typeof IDB.cmp === "function") {
 const CMP = IDB.cmp.bind(IDB);
 shim.cmp = (a: unknown, b: unknown) => CMP(pre(a), pre(b));
 }
 try {
 (w as Record<string, unknown>).indexedDB = shim;
 } catch { /* read-only: stays unscoped */ }
 }
}

{
 const CA = w.caches as CacheStorage | undefined;
 if (CA) {
 const OPEN = CA.open.bind(CA);
 const DEL = CA.delete.bind(CA);
 const HAS = CA.has.bind(CA);
 const KEYS = CA.keys.bind(CA);
 const own = (n: string) => n.startsWith(P);
 const shim: Record<string, unknown> = {
 open: (n: unknown) => OPEN(pre(n)),
 delete: (n: unknown) => DEL(pre(n)),
 has: (n: unknown) => HAS(pre(n)),
 keys: () => KEYS().then((ks) => ks.filter(own).map((n) => n.slice(SITE.length + 1))),
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
 (w as Record<string, unknown>).caches = shim;
 } catch { /* read-only: stays unscoped */ }
 }
}

/* ---- document.cookie (virtual, per-origin) ------------------------ */
/* The getter must be synchronous, the authoritative jar lives in the
 service worker: the page keeps an optimistic local copy, every read
 refreshes it asynchronously from the jar, every write applies locally
 first (read-after-write works) and is forwarded for RFC 6265
 admission. Eventually consistent across windows; exact at the jar.
 Deletion (max-age=0 or a past Expires) is not detected optimistically;
 the jar reply corrects the copy within milliseconds. */

{
 const ctl =
 (navigator as { serviceWorker?: { controller?: ServiceWorker } })
 .serviceWorker?.controller;
 if (ctl && ORIGIN) {
 let cur = "";
 /* One channel lives for the page's lifetime: the SW keeps the far
    end and answers every message with the authoritative jar view. */
 const ch = new MessageChannel();
 ch.port1.onmessage = (ev) => {
 const d = ev.data as { cookie?: string };
 if (typeof d.cookie === "string") cur = d.cookie;
 };
 ctl.postMessage({ type: "zl:docCookie", origin: ORIGIN }, [ch.port2]);
 const sy = (set?: string) => ch.port1.postMessage({ set });
 try {
 Object.defineProperty(document, "cookie", {
 configurable: true,
 get: () => {
 sy();
 return cur;
 },
 set: (v: string) => {
 const pair = v.split(";")[0];
 const eq = pair.indexOf("=");
 const name = (eq > 0 ? pair.slice(0, eq) : pair).trim();
 if (!name) return;
 const val = eq > 0 ? pair.slice(eq + 1).trim() : "";
 const keep = (cur ? cur.split("; ") : []).filter(
 (p) => p.slice(0, p.indexOf("=")) !== name,
 );
 keep.push(name + "=" + val);
 cur = keep.join("; ");
 sy(v);
 },
 });
 sy();
 } catch { /* non-configurable: cookie stays native */ }
 }
}

/* ---- worker WebSocket relay + serviceWorker shim ------------------- */
/* 1.6 Hydride: workers have no direct channel to the service worker.
 The worker prelude posts its zl:wsOpen to the parent page; this relay
 forwards it (with the transferred port) to the engine controller.
 2.3 Selenide: shared workers have no parent-page postMessage, so
 their prelude posts the same message on its newest connect port -
 the SharedWorker wrapper below hooks that port into this same relay. */

const relay = (e: MessageEvent) => {
 const d = e.data as { zl?: string; msg?: unknown };
 if (d?.zl === "ws") (navigator as { serviceWorker?: { controller?: { postMessage: (m: unknown, p?: MessagePort[]) => void } } }).serviceWorker?.controller?.postMessage(d.msg, e.ports as unknown as MessagePort[]);
};
addEventListener("message", relay);

/* SharedWorker ctor wrapper (2.3 Selenide): the wrapper does not touch
 the script URL (same routing story as dedicated workers: relative
 URLs resolve engine-local, the SW recovers the destination) - it
 only bridges the worker's WebSocket control messages, which arrive
 on the SharedWorker's port instead of a page message event. Page
 code never sees the traffic; a read-only SharedWorker property
 keeps the native ctor (no relay, documented limit). */
{
 const OSW = w.SharedWorker as (new (u: string, o?: string) => SharedWorker) | undefined;
 if (OSW) {
 const wrap = function (u: string, o?: string) {
 const s = new OSW(u, o);
 s.port.addEventListener("message", relay);
 return s;
 };
 try {
 w.SharedWorker = wrap;
 } catch { /* read-only: shared workers stay unrelayed */ }
 }
}

/* navigator.serviceWorker shim: per-origin virtual registrations in
 the site-scoped localStorage. No script ever runs - the engine owns
 the only real scope (browser security, documented not hacked). */

{
 const NS = (navigator as { serviceWorker?: unknown }).serviceWorker;
 if (NS && ORIGIN) {
  const LS = w.localStorage as unknown as Storage;
  swShimApply(NS as object, { get: () => LS.getItem("swreg"), set: (v: string) => LS.setItem("swreg", v), clear: () => LS.removeItem("swreg") }, ZL.dest);
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
        throw new DOMException(url, "SyntaxError");
      }
      if (!/^wss?:$/.test(u.protocol)) {
        return new OWS(url, protocols);
      }
      const es = new EventTarget() as unknown as WebSocket;
      let wsState = 0;
      let binType: "blob" | "arraybuffer" = "blob";
      let proto = "";
      const ch = new MessageChannel();
      let q = Promise.resolve();
      const disp = (e: Event) => {
        q = q.then(() => {
          es.dispatchEvent(e);
        });
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
    Object.assign(LJWS as unknown as Record<string, unknown>, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: OWS.prototype });
    (w as { WebSocket?: unknown }).WebSocket = LJWS;
  }
}
