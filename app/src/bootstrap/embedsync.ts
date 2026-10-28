/* Registered-embedder URL/title/icon sync and popup routing.
   targetOrigin and the host's source-window check bound every messages
   to the owning tab. Page metadata is page-reported, not attestation.
   Standalone top-level documents retain native popup behavior.
   #491: the embedder handshake is a bounded retry state machine, not
   one shot. A single transient failure (busy/restarted worker, a
   failed control-channel send, an absent controller at install) must
   not permanently disable page identity and URL sync for the page's
   lifetime: every attempt re-resolves the active controller, a
   shared attempt budget bounds the whole recovery (MAX_ATTEMPTS x
   5s), and controllerchange re-arms the handshake. Exhausting the
   budget keeps the same honest terminal path as before (unknown
   embedder fails closed, queued popups are not routed). */
import { controlQuery } from "./controlquery";
import { onVlocChange } from "./vloc";

type Popup = { href: string; fallback: () => void };
const popups = new WeakMap<object, (p: Popup) => void>();
/** #416: a handled popup has no WindowProxy: window.open returns null. */
export function embedPopup(w: object, href: string, fallback: () => void): boolean {
  const open = popups.get(w);
  if (!open) return false;
  open({ href, fallback });
  return true;
}

export function applyEmbedSync(w: Record<string, unknown>): void {
  let parent: unknown;
  try { parent = w.parent; } catch { return; }
  if (!parent || parent === w) return;
  let origin = "";
  let base = "";
  let cur = "";
  let clientId = "";
  const pending: Popup[] = [];
  let settled = false;
  /* #491: handshake state - the current channel, its timer, and the
     shared attempt budget (initial attempts plus retries, including
     no-controller rounds and controllerchange re-arms). */
  let cancel = () => {};
  let attempts = 0;
  const finish = (standalone: boolean): void => {
    if (settled) return;
    settled = true;
    cancel();
    if (standalone) popups.delete(w);
    else popups.set(w, () => {}); // unknown embedder fails closed
    for (const p of pending.splice(0)) {
      if (standalone) { try { p.fallback(); } catch { /* popup blocked */ } }
    }
  };
  popups.set(w, (p) => { if (pending.length < 32) pending.push(p); });
  const post = (m: unknown): void => {
    try { (parent as { postMessage(m: unknown, o: string): void }).postMessage(m, origin); }
    catch { /* embedder gone */ }
  };
  const emit = (): void => {
    if (!origin || !cur) return;
    const doc = w.document as Document | undefined;
    let title = "";
    let favicon = "";
    try {
      title = doc ? doc.title : "";
      favicon = String((doc?.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? "").slice(0, 2048);
    } catch { /* no readable metadata */ }
    post({ lb: "nav", data: { url: cur, title, clientId, favicon } });
  };
  const startHandshake = (): void => {
    if (settled) return;
    if (++attempts > 4) { finish(false); return; }
    cancel = controlQuery({ type: "zl:getEmbedder" }, d => {
      if (settled) return;
      if (!d) { pending.length = 0; startHandshake(); return; }
      if (d?.ok !== true) { finish(false); return; }
      if (d.origin === null) { finish(true); return; }
      if (typeof d.origin !== "string" || !/^https:\/\/[^/]+$/.test(d.origin) ||
          typeof d.url !== "string" || !/^https?:\/\//.test(d.url)) { finish(false); return; }
      try { base = new URL(d.url).origin; } catch { finish(false); return; }
      settled = true;
      cancel();
      origin = d.origin;
      cur = d.url;
      clientId = typeof d.clientId === "string" ? d.clientId : "";
      const open = (p: Popup): void => {
        if (!p.href || p.href === "about:blank") {
          post({ lb: "navigate", data: { href: "", newTab: true, blank: true, clientId } });
          return;
        }
        let u: URL;
        try { u = new URL(p.href, cur); } catch { return; }
        if (!/^https?:$/.test(u.protocol)) return;
        const send = (href: string) => post({ lb: "navigate", data: { href, newTab: true, clientId } });
        const loc = w.location as { origin?: string } | undefined;
        if (u.origin !== loc?.origin) { send(u.href); return; }
        // Worker decoding keeps keyed routes and query routes out of the URL bar.
        if (!u.pathname.startsWith("/__zl_") && !/^[\w-]{12,}$/.test(u.pathname.split("/")[2] ?? "") &&
            !u.searchParams.has("zlNavh")) {
          send(new URL(u.pathname + u.search + u.hash, cur).href);
          return;
        }
        controlQuery({ type: "zl:decodeRoutes", routes: [u.href] }, e => {
          const href = e?.ok === true && e.dests?.[0];
          if (typeof href === "string" && /^https?:\/\//.test(href)) send(u.hash ? href.split("#")[0] + u.hash : href);
        });
      };
      popups.set(w, open);
      for (const p of pending.splice(0)) open(p);
      emit();
      onVlocChange((virt: string) => { if (base) { cur = base + virt; emit(); } });
    });
  };
  /* #491: a controller appearing or being replaced mid-life re-arms
     the handshake within the same bounded budget. */
  const sw = (navigator as { serviceWorker?: { addEventListener?: (t: string, fn: () => void) => void } })
    .serviceWorker;
  try { sw?.addEventListener?.("controllerchange", () => {
    if (!settled) { cancel(); pending.length = 0; startHandshake(); }
  }); } catch { /* clock retries remain */ }
  startHandshake();
  (w.addEventListener as Window["addEventListener"] | undefined)?.call(w as unknown as Window, "load", emit);
  const MO = (w as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const doc = w.document as Document | undefined;
  if (typeof MO === "function" && doc) {
    try {
      const mo = new MO(emit);
      if (doc.head) mo.observe(doc.head, { subtree: true, characterData: true, childList: true,
        attributes: true, attributeFilter: ["href", "rel"] });
    } catch { /* changes still ride load and location events */ }
  }
}
