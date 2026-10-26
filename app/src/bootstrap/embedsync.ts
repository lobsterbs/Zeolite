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
import { swc } from "./siteid";
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
  let hch: MessageChannel | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const MAX_ATTEMPTS = 4;
  const finish = (standalone: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (hch) {
      hch.port1.onmessage = null;
      try { hch.port1.close(); } catch { /* already closed */ }
      try { hch.port2.close(); } catch { /* transferred or already closed */ }
      hch = null;
    }
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
      title = typeof doc?.title === "string" ? doc.title : "";
      favicon = String((doc?.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? "").slice(0, 2048);
    } catch { /* no readable metadata */ }
    post({ lb: "nav", data: { url: cur, title, clientId, favicon } });
  };
  const dropHandshake = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (hch) {
      hch.port1.onmessage = null;
      try { hch.port1.close(); } catch { /* already closed */ }
      try { hch.port2.close(); } catch { /* transferred or already closed */ }
      hch = null;
    }
  };
  const startHandshake = (): boolean => {
    if (settled) return true;
    if (attempts >= MAX_ATTEMPTS) { finish(false); return false; }
    /* #491: resolve the controller on EVERY attempt; the one
       captured at install may be a dead/replaced worker. */
    const ctl = swc();
    if (!ctl) {
      /* No controller yet: retryable on the same bounded clock
         (and re-armed by controllerchange), not a terminal exit. */
      attempts++;
      timer = setTimeout(() => { dropHandshake(); startHandshake(); }, 5000);
      return true;
    }
    attempts++;
    const ch = new MessageChannel();
    hch = ch;
    ch.port1.onmessage = (ev) => {
      if (settled) return;
      const d = ev.data as { origin?: unknown; url?: unknown; clientId?: unknown } | null;
      if (d?.origin == null) { finish(true); return; }
      if (typeof d.origin !== "string" || !/^https:\/\/[^/]+$/.test(d.origin) ||
          typeof d.url !== "string" || !/^https?:\/\//.test(d.url)) { finish(false); return; }
      try { base = new URL(d.url).origin; } catch { finish(false); return; }
      settled = true;
      dropHandshake();
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
        const route = new MessageChannel();
        const deadline = setTimeout(() => { route.port1.onmessage = null; route.port1.close(); }, 5000);
        route.port1.onmessage = (e) => {
          clearTimeout(deadline);
          route.port1.onmessage = null;
          route.port1.close();
          const href = e.data?.dests?.[0];
          if (typeof href === "string" && /^https?:\/\//.test(href)) send(u.hash ? href.split("#")[0] + u.hash : href);
        };
        try { ctl.postMessage({ type: "zl:decodeRoutes", routes: [u.href] }, [route.port2]); }
        catch { clearTimeout(deadline); route.port1.onmessage = null; route.port1.close(); }
      };
      popups.set(w, open);
      for (const p of pending.splice(0)) open(p);
      emit();
      onVlocChange((virt: string) => { if (base) { cur = base + virt; emit(); } });
    };
    timer = setTimeout(() => { dropHandshake(); startHandshake(); }, 5000);
    try { ctl.postMessage({ type: "zl:getEmbedder" }, [ch.port2]); }
    catch { dropHandshake(); startHandshake(); return false; }
    return true;
  };
  /* #491: a controller appearing or being replaced mid-life re-arms
     the handshake within the same bounded budget. */
  const sw = (navigator as { serviceWorker?: { addEventListener?: (t: string, fn: () => void) => void } })
    .serviceWorker;
  if (sw && typeof sw.addEventListener === "function") {
    try { sw.addEventListener("controllerchange", () => { if (!settled) { dropHandshake(); startHandshake(); } }); }
    catch { /* a realm without lifecycle events keeps the clock retries */ }
  }
  startHandshake();
  const AE = w.addEventListener as ((t: string, fn: () => void) => void) | undefined;
  if (typeof AE === "function") AE.call(w, "load", emit);
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
