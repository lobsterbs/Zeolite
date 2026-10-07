/* document.cookie virtualization, per-origin: the authoritative jar
   lives in the service worker, the page keeps an optimistic local
   copy. Split out of the bootstrap entry. Issue #32: the gate is the
   opaque site token (a truthy virtualization identity), not the real
   origin; the jar origin is recovered SW-side from the sender's own
   client route, never from a page-supplied string. */

import { swc } from "./siteid";

export function applyCookie(site: string, doc: Document = document): void {
/* ---- document.cookie (virtual, per-origin) ------------------------ */
/* The getter must be synchronous, the authoritative jar lives in
 the service worker: the page keeps an optimistic local copy, every
 read refreshes it asynchronously from the jar, every write applies
 locally first (read-after-write works) and is forwarded for RFC 6265
 admission. Eventually consistent across windows; exact at the jar.
 Deletion (max-age=0 or a past Expires) is not detected optimistically;
 the jar reply corrects the copy within milliseconds. */

{
 const ctl = swc();
 if (ctl && site) {
 let cur = "";
 /* One channel lives for the page's lifetime: the SW keeps the far
    end and answers every message with the authoritative jar view. */
 const ch = new MessageChannel();
 ch.port1.onmessage = (ev) => {
 const d = ev.data as { cookie?: string };
 if (typeof d.cookie === "string") cur = d.cookie;
 };
 ctl.postMessage({ type: "zl:docCookie" }, [ch.port2]);
 const sy = (set?: string) => ch.port1.postMessage({ set });
 try {
 /* #108: the document is a parameter so a guarded child realm
   (about:blank/srcdoc) gets its own surface virtualized; the
   channel still rides the guarding page's controller. */
 Object.defineProperty(doc, "cookie", {
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


}
