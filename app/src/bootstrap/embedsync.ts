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
import { NativeURL } from "./anchorshim";

type Popup = { href: string; fallback: () => void };
const popups = new WeakMap<object, (p: Popup) => void>();
/** #558: a target=_top activation handed to the embedder, with the
    realm's own native drive as the bounded-ack fallback. */
type TopReq = { href: string; fallback: () => void };
const topNavs = new WeakMap<object, (p: TopReq) => void>();
/* The ack is a same-window postMessage round trip; the bound only
   separates a live embedder from the native fallback. */
const TOP_NAV_ACK_MS = 1000;
/** #553: pages that keep the return value of window.open get a
    limited facade instead of null - but only when the popup was
    really routed to the embedder. A swallowed popup (unknown
    embedder, fail closed) still answers null, the same as a natively
    blocked popup. The facade carries no destination: the plaintext
    href rides the existing navigate channel to the host only. */
const facadeRouted = new WeakSet<object>();
const closeReports = new WeakMap<object, (name: string) => void>();
const namedFacades = new Map<string, object>();
export function popupFacade(w: object, name: string | undefined): object | null {
  if (!facadeRouted.has(w)) return null;
  const n = typeof name === "string" ? name : "";
  let f = n ? namedFacades.get(n) : undefined;
  if (!f) {
    f = {
      name: n,
      /* Host state reports arrive in a later slice; closed stays
         honestly false until then. */
      get closed() {
        return false;
      },
      focus() {},
      /* A close request rides the embedder channel; the host owns
         the real window. */
      close() {
        closeReports.get(w)?.(n);
      },
      postMessage() {
        throw new Error("zeolite: popup postMessage relay not wired (see compat)");
      },
    };
    if (n) namedFacades.set(n, f);
  }
  return f;
}
/** #416/#553: a handled popup has a routing target. The synchronous
    return contract is kept by popupFacade; a fail-closed embedder
    still swallows and window.open answers null. */
export function embedPopup(w: object, href: string, fallback: () => void): boolean {
  const open = popups.get(w);
  if (!open) return false;
  open({ href, fallback });
  return true;
}

/** #558: hand a target=_top activation to the embedder (the host
    owns the real top document). True means the request was queued
    or sent; the fallback runs when no ack lands within the bound
    or the handshake fails closed, so standalone realms keep the
    native drive. */
export function embedTopNav(w: object, href: string, fallback: () => void): boolean {
  const send = topNavs.get(w);
  if (!send) return false;
  send({ href, fallback });
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
  const topPending: TopReq[] = [];
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
    facadeRouted.delete(w);
    closeReports.delete(w);
    topNavs.delete(w);
    if (standalone) popups.delete(w);
    else popups.set(w, () => {}); // unknown embedder fails closed
    for (const p of pending.splice(0)) {
      if (standalone) { try { p.fallback(); } catch { /* popup blocked */ } }
    }
    /* #558: a top-nav fallback never leaks the client IP (the
       native drive stays engine-scoped), so both terminal paths
       run it, unlike swallowed popups. */
    for (const p of topPending.splice(0)) {
      try { p.fallback(); } catch { /* the drive owns its errors */ }
    }
  };
  popups.set(w, (p) => { if (pending.length < 32) pending.push(p); });
  topNavs.set(w, (p) => { if (topPending.length < 32) topPending.push(p); });
  /* #553: from the first queued popup on, this document routes
     popups through the embedder and window.open answers a facade.
     A terminal fail-closed handshake un-marks (below), so a
     swallowed popup answers null, native-blocked semantics. */
  facadeRouted.add(w);
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
      try { base = new NativeURL(d.url).origin; } catch { finish(false); return; }
      settled = true;
      cancel();
      origin = d.origin;
      cur = d.url;
      clientId = typeof d.clientId === "string" ? d.clientId : "";
      /* #558: target=_top activations hand the destination to
         the embedder instead of committing the top document on
         this realm's route: a split-origin top commit lands in
         the first-party worker partition, which holds a
         different route key and no transport config, and
         strands on the host fallback shell. The bounded ack
         separates "the embedder took it" from "drive native"
         so a silent host never strands the click. */
      let ackSeq = 0;
      const acks = new Map<string, () => void>();
      const onAckMsg = (ev: Event): void => {
        const e2 = ev as MessageEvent;
        if (e2.origin !== origin) return;
        const m = e2.data as { lb?: string; nonce?: string } | null;
        if (!m || m.lb !== "navigateTabAck" || typeof m.nonce !== "string") return;
        acks.get(m.nonce)?.();
      };
      (w.addEventListener as Window["addEventListener"] | undefined)?.call(
        w as unknown as Window,
        "message",
        onAckMsg,
      );
      topNavs.set(w, (p) => {
        const nonce = "zltop" + ++ackSeq;
        const t = setTimeout(() => {
          if (acks.delete(nonce)) {
            try { p.fallback(); } catch { /* the drive owns its errors */ }
          }
        }, TOP_NAV_ACK_MS);
        acks.set(nonce, () => { clearTimeout(t); acks.delete(nonce); });
        post({ lb: "navigateTab", data: { href: p.href, clientId, ack: nonce } });
      });
      for (const p of topPending.splice(0)) topNavs.get(w)?.(p);
      const open = (p: Popup): void => {
        if (!p.href || p.href === "about:blank") {
          post({ lb: "navigate", data: { href: "", newTab: true, blank: true, clientId } });
          return;
        }
        let u: URL;
        try { u = new NativeURL(p.href, cur); } catch { return; }
        if (!/^https?:$/.test(u.protocol)) return;
        const send = (href: string) => post({ lb: "navigate", data: { href, newTab: true, clientId } });
        const loc = w.location as { origin?: string } | undefined;
        if (u.origin !== loc?.origin) { send(u.href); return; }
        // Worker decoding keeps keyed routes and query routes out of the URL bar.
        if (!u.pathname.startsWith("/__zl_") && !/^[\w-]{12,}$/.test(u.pathname.split("/")[2] ?? "") &&
            !u.searchParams.has("zlNavh")) {
          send(new NativeURL(u.pathname + u.search + u.hash, cur).href);
          return;
        }
        controlQuery({ type: "zl:decodeRoutes", routes: [u.href] }, e => {
          const href = e?.ok === true && e.dests?.[0];
          if (typeof href === "string" && /^https?:\/\//.test(href)) send(u.hash ? href.split("#")[0] + u.hash : href);
        });
      };
      popups.set(w, open);
      facadeRouted.add(w);
      closeReports.set(w, (n: string) => post({ lb: "popupClose", data: { name: n } }));
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
