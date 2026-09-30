/* Worker WebSocket relay, SharedWorker port hook and the
   navigator.serviceWorker shim. Split out of the bootstrap entry.
   Issue #32: the entry passes an opaque site token (the virtualization
   gate) and the page's own engine URL (the shim's base), never the
   real destination. */

import { swShimApply } from "../swshim";
import { swc } from "./siteid";

export function applyRelay(w: Record<string, unknown>, site: string, pageUrl: string): void {
/* ---- worker WebSocket relay + serviceWorker shim ------------------- */
/* 1.6 Hydride: workers have no direct channel to the service worker.
 The worker prelude posts its zl:wsOpen to the parent page; this relay
 forwards it (with the transferred port) to the engine controller.
 2.3 Selenide: shared workers have no parent-page postMessage, so
 their prelude posts the same message on its newest connect port - the
 SharedWorker wrapper below hooks that port into this same relay. */

const relay = (e: MessageEvent) => {
 const d = e.data as { zl?: string; msg?: unknown };
 if (d && d.zl === "ws") {
    const ctl = swc();
 if (ctl) ctl.postMessage(d.msg, e.ports as unknown as MessagePort[]);
 else {
 /* No controller: the page shim fails closed; the relay must too, or
 a worker-relayed socket hangs CONNECTING forever. The terminal error
 carries the close code (the worker prelude closes on it). */
 const p = e.ports[0];
 if (p) {
 p.postMessage({ ev: "error", code: 1006, clean: false });
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
 return s;
 };
 try {
 w.SharedWorker = wrap;
 } catch { /* read-only: shared workers stay unrelayed */ }
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
