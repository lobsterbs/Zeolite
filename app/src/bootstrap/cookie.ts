/* document.cookie virtualization, per-origin: the authoritative jar
   lives in the service worker, the page keeps an optimistic local
   copy. Split out of the bootstrap entry. Issue #32: the gate is the
   opaque site token (a truthy virtualization identity), not the real
   origin; the jar origin is recovered SW-side from the sender's own
   client route, never from a page-supplied string. */

import { swc } from "./siteid";

/** #534: does a document.cookie write shape a deletion? RFC 6265
    deletion attributes only: max-age <= 0, or an already-past Expires.
    The bootstrap bundle stays independent of the RFC 6265 5.1.1
    cookie-date parser (size gate), so Expires parsing uses Date.parse
    and an unparsable date is honestly NOT a deletion: the
    authoritative jar reply corrects the copy either way. */
export function deletionShaped(v: string): boolean {
  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const part of v.split(";").slice(1)) {
    const i = part.indexOf("=");
    const key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : part.slice(i + 1).trim();
    if (key === "max-age" && /^-?[0-9]+$/.test(val)) maxAge = Number(val);
    else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    }
  }
  if (maxAge !== null && maxAge <= 0) return true;
  return expires !== null && expires <= Date.now();
}

export function applyCookie(site: string, doc: Document = document): void {
/* ---- document.cookie (virtual, per-origin) ------------------------ */
/* The getter must be synchronous, the authoritative jar lives in
 the service worker: the page keeps an optimistic local copy, every
 read refreshes it asynchronously from the jar, every write applies
 locally first (read-after-write works) and is forwarded for RFC 6265
 admission. Eventually consistent across windows; exact at the jar.
 #534 deletion consistency contract: a deletion-shaped write
 (max-age <= 0 or an already-past Expires) removes the name from
 the optimistic copy immediately, so a read right after the write
 never observes the stale value; the authoritative jar reply then
 corrects the copy (restoring identities the deletion did not
 match, and confirming the deletion at the jar within
 milliseconds). */

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
 /* #534: a deletion-shaped write removes the name from the
    optimistic copy immediately (the consistency contract above);
    the jar reply confirms or corrects. */
 if (!deletionShaped(v)) keep.push(name + "=" + val);
 cur = keep.join("; ");
 sy(v);
 },
 });
 sy();
 } catch { /* non-configurable: cookie stays native */ }
 }
}


}
