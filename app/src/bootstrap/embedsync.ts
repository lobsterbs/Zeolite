/* Embedder URL/title sync (#107 phase 2, LobsterBrowse split-origin).

   In split-origin mode proxied documents render on a separate content
   origin, so the embedder's same-origin poll cannot read the frame
   and the URL bar and tab title freeze at the load-time value. This
   module asks the engine controller (zl:getEmbedder) for the
   registered embedder origin and THIS client's own virtual URL, then
   re-posts every location or title change up to the embedder through
   the parent's NATIVE postMessage channel using the embedder's
   existing {lb:"nav"} frame message schema: the toolbar, tab strip
   and history update with no same-origin read at all.

   Trust model: the targetOrigin gate means the payload only ever
   reaches a window actually at the registered origin, and the
   embedder re-validates sender + origin on its side. A hostile page
   lives at the same origin as this bootstrap, so it can forge a
   {lb:"nav"} of its own: the split-mode URL bar is frame-reported,
   a bounded spoof (the forger only repaints its own tab display),
   documented in LobsterBrowse's AGENTS.md. Without a registered
   embedder (same-origin design, or the register page never acked)
   nothing installs and nothing is ever sent. */

import { swc } from "./siteid";
import { onVlocChange } from "./vloc";

export function applyEmbedSync(w: Record<string, unknown>): void {
  let parent: unknown;
  try {
    parent = w.parent;
  } catch {
    return;
  }
  /* a top-level document has no embedder to sync. */
  if (!parent || parent === w) return;
  const ctl = swc();
  if (!ctl) return;

  let origin = "";
  let base = "";
  let cur = "";
  const title = (): string => {
    try {
      const d = w.document as { title?: unknown } | undefined;
      return typeof d?.title === "string" ? d.title : "";
    } catch {
      return "";
    }
  };
  const post = (m: unknown): void => {
    try {
      (parent as { postMessage(m: unknown, o: string): void }).postMessage(m, origin);
    } catch {
      /* embedder gone: nothing to sync */
    }
  };
  const emit = (): void => {
    if (!origin || !cur) return;
    const t = title();
    post({ lb: "nav", data: t ? { url: cur, title: t } : { url: cur } });
  };

  const ch = new MessageChannel();
  ch.port1.onmessage = (ev) => {
    const d = ev.data as { origin?: unknown; url?: unknown } | null;
    if (!d || typeof d.origin !== "string" || !/^https:\/\/[^/]+$/.test(d.origin)) return;
    if (typeof d.url !== "string" || !/^https?:\/\//.test(d.url)) return;
    try {
      base = new URL(d.url).origin;
    } catch {
      return;
    }
    origin = d.origin;
    cur = d.url;
    emit();
    /* Later virtual-path changes (pushState, replaceState, popstate,
       hashchange) re-emit with the same base origin. The hook only
       ever hands over decoded REAL virtual paths: vloc fires it at
       its two real-path choke points, so an opaque engine route can
       never ride this channel into the embedder URL bar. */
    onVlocChange((virt: string) => {
      if (base) {
        cur = base + virt;
        emit();
      }
    });
  };
  try {
    ctl.postMessage({ type: "zl:getEmbedder" }, [ch.port2]);
  } catch {
    return; // no channel: no sync, the poll owns nothing here
  }

  const AE = w.addEventListener as ((t: string, fn: () => void) => void) | undefined;
  if (typeof AE === "function") AE.call(w, "load", emit);
  /* Title: <title> text mutations plus the title element's creation
     (a document.title write creates one in head). Node tests have no
     MutationObserver: the guard keeps them running. */
  const MO = (w as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const doc = w.document as Document | undefined;
  if (typeof MO === "function" && doc) {
    try {
      const mo = new MO(emit);
      const t = doc.querySelector("title");
      if (t) mo.observe(t, { subtree: true, characterData: true, childList: true });
      if (doc.head) mo.observe(doc.head, { childList: true });
    } catch {
      /* no observer: title changes ride load + location events */
    }
  }
}
