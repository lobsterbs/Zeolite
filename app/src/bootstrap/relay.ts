/* Worker WebSocket relay, Worker/SharedWorker channel hooks and the
   navigator.serviceWorker shim. Split out of the bootstrap entry.
   Issue #32: the entry passes an opaque site token (the virtualization
   gate) and the page's own engine URL (the shim's base), never the
   real destination. */

import { swShimApply } from "../swshim";
import { swc } from "./siteid";

/* The wrapper shapes the prelude posts (zl:"ws" / zl:"mint") must
   never reach app handlers on a tapped channel. */
const isWrapper = (d: unknown): boolean =>
 !!d &&
 typeof d === "object" &&
 ((d as { zl?: unknown }).zl === "ws" || (d as { zl?: unknown }).zl === "mint");

/* Tap a worker channel (a dedicated Worker object, a SharedWorker
   port) so app-registered message handlers skip wrapper shapes while
   the relay listener - registered before the tap - still sees them.
   onmessage becomes an own property shadowing the native accessor;
   a lazily-registered internal listener delivers non-wrapper
   messages, matching native order (the handler fires relative to
   listeners by assignment time, and setting onmessage starts a
   MessagePort, which addEventListener never does).
   addEventListener("message") callbacks are wrapped through a
   WeakMap so removeEventListener maps back. */
const tapChannel = (t: Worker | MessagePort): void => {
 const nativeAdd = t.addEventListener.bind(t) as (...a: unknown[]) => void;
 const nativeRemove = t.removeEventListener.bind(t) as (...a: unknown[]) => void;
 const wrapped = new WeakMap<object, EventListener>();
 let app: ((ev: MessageEvent) => unknown) | null = null;
 let delivery = false;
 const deliver = (ev: Event) => {
  if (app && !isWrapper((ev as MessageEvent).data)) {
   try {
    app.call(t, ev as MessageEvent);
   } catch { /* contained, like a native handler */ }
  }
 };
 Object.defineProperty(t, "onmessage", {
  configurable: true,
  enumerable: true,
  get: () => app,
  set: (fn: unknown) => {
   app = typeof fn === "function" ? (fn as (ev: MessageEvent) => unknown) : null;
   if (app && !delivery) {
    delivery = true;
    nativeAdd("message", deliver);
    const st = (t as { start?: () => void }).start;
    if (typeof st === "function") st.call(t);
   }
  },
 });
 t.addEventListener = function (this: Worker | MessagePort, ...a: unknown[]) {
  if (a[0] === "message" && typeof a[1] === "function") {
   const orig = a[1] as EventListener;
   const fwd: EventListener = (ev: Event) => {
    if (isWrapper((ev as MessageEvent).data)) return;
    orig.call(t, ev);
   };
   wrapped.set(orig, fwd);
   return nativeAdd(a[0], fwd, a[2]);
  }
  return nativeAdd(...a);
 } as unknown as (...a: unknown[]) => void;
 t.removeEventListener = function (this: Worker | MessagePort, ...a: unknown[]) {
  const fwd =
   a[0] === "message" && typeof a[1] === "function" ? wrapped.get(a[1] as object) : undefined;
  return nativeRemove(a[0], fwd ?? a[1], a[2]);
 } as unknown as (...a: unknown[]) => void;
};

export function applyRelay(w: Record<string, unknown>, site: string, pageUrl: string): void {
/* ---- worker WebSocket relay + serviceWorker shim ------------------- */
/* 1.6 Hydride: workers have no direct channel to the service worker.
 The worker prelude posts its zl:wsOpen to the parent page; this relay
 forwards it (with the transferred port) to the engine controller.
 2.3 Selenide: shared workers have no parent-page postMessage, so
 their prelude posts the same message on its newest connect port - the
 SharedWorker wrapper below hooks that port into this same relay.
 #54 residual 2: the prelude also mints through this relay (a
 zl:"mint" wrapper carries a zl:mint control message the same way),
 so worker fetch inputs ride keyed routes like the page's own
 seams. The wrappers ride the app's own channels (a dedicated
 Worker's object, a SharedWorker's port), so each hook below
 taps its channel after the relay listener: app handlers never
 see a wrapper shape. */

const relay = (e: MessageEvent) => {
 const d = e.data as { zl?: string; msg?: unknown };
 if (d && (d.zl === "ws" || d.zl === "mint")) {
    const ctl = swc();
 if (ctl) ctl.postMessage(d.msg, e.ports as unknown as MessagePort[]);
 else {
 /* No controller: the page shim fails closed; the relay must too, or
 a worker-relayed socket hangs CONNECTING forever. The terminal error
 carries the close code (the worker prelude closes on it). */
 const p = e.ports[0];
 if (p) {
 /* #54: a mint port is refused (ok:false), not sent a socket
 error - the caller resolves null immediately instead of
 waiting out its mint timeout. */
 if (d.zl === "mint") p.postMessage({ ok: false, error: "no controller" });
 else p.postMessage({ ev: "error", code: 1006, clean: false });
 p.close();
 }
 }
 }
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
 tapChannel(s.port);
 return s;
 };
 try {
 w.SharedWorker = wrap;
 } catch { /* read-only: shared workers stay unrelayed */ }
 }
}

/* Dedicated Worker hook: a dedicated worker's postMessage lands on
 the Worker object's own message channel, not the window, so the
 relay listens there too; the tap keeps wrappers out of the app's
 handlers. The script URL stays untouched (same routing story as
 the SharedWorker wrapper: relative URLs resolve engine-local, the
 SW recovers the destination). */
{
 const OW = w.Worker as (new (u: string, o?: WorkerOptions) => Worker) | undefined;
 if (OW) {
 const wrap = function (u: string, o?: WorkerOptions) {
 const wk = new OW(u, o);
 wk.addEventListener("message", relay);
 tapChannel(wk);
 return wk;
 };
 try {
 w.Worker = wrap;
 } catch { /* read-only: dedicated workers stay unrelayed */ }
 }
}

/* navigator.serviceWorker shim: per-origin virtual registrations in
 the site-scoped localStorage. No script ever runs - the engine owns
 the only real scope (browser security, documented not hacked).
 Issue #32: the shim base is the page's own engine URL, so the stored
 records contain engine-local strings, never the real destination. */

{
 const NS = (navigator as { serviceWorker?: unknown }).serviceWorker;
 if (NS && site) {
  const LS = w.localStorage as unknown as Storage;
  const K = "swreg";
  swShimApply(NS as object, { get: () => LS.getItem(K), set: (v: string) => LS.setItem(K, v), clear: () => LS.removeItem(K) }, pageUrl);
 }
}


}
