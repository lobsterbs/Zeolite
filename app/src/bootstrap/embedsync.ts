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

type Popup = { href: string; fallback: () => void; top?: boolean; pid: string; name: string; dead?: boolean };
const popups = new WeakMap<object, (p: Popup) => void>();
/** #553: pages that keep the return value of window.open get a
    limited facade instead of null - but only when the popup was
    really routed to the embedder. A swallowed popup (unknown
    embedder, fail closed) still answers null, the same as a natively
    blocked popup. The facade carries no destination: the plaintext
    href rides the existing navigate channel to the host only.
    Slice 2: ops correlate by an opaque per-open pid (a name cannot
    tell two unnamed popups apart); close/focus/postMessage ride
    lb:popupClose/popupFocus/popupMessage and the host's
    lb:popupState reports flip closed. Delivery of popup messages
    into the popup tab ships with the host integration, exactly
    like the popup rendering surface. */
const facadeRouted = new WeakSet<object>();
const shut = new WeakSet<object>();
const byPid = new Map<string, object>();
const pidOf = new WeakMap<object, string>();
const pendingByPid = new Map<string, Popup>();
const lastOpen = new WeakMap<object, { pid: string; name: string }>();
const ops = new WeakMap<object, (op: string, pid: string, name: string, data?: Record<string, unknown>) => void>();
let pidSeq = 0;
function originOk(t: unknown): boolean {
  if (typeof t !== "string" || t === "") return false;
  try {
    return new NativeURL(t).origin !== "null";
  } catch {
    return false;
  }
}
const namedFacades = new Map<string, object>();
export function popupFacade(w: object): object | null {
  if (!facadeRouted.has(w)) return null;
  const st = lastOpen.get(w);
  if (!st) return null;
  const n = st.name;
  let f = n ? namedFacades.get(n) : undefined;
  if (!f) {
    const pid = st.pid;
    const send = (op: string, data?: Record<string, unknown>): void => {
      ops.get(w)?.(op, pidOf.get(f as object) ?? pid, n, data);
    };
    f = {
      name: n,
      get closed(): boolean {
        return shut.has(f as object);
      },
      focus() {
        send("popupFocus");
      },
      /* The page asked to close; the real window belongs to the
         host, and a still-queued open dies before it ever ships. */
      close() {
        shut.add(f as object);
        const p = pendingByPid.get(pidOf.get(f as object) ?? pid);
        if (p) p.dead = true;
        else send("popupClose");
      },
      postMessage(msg: unknown, targetOrigin?: unknown) {
        const t = typeof targetOrigin === "string" ? targetOrigin : "*";
        if (t !== "*" && !originOk(t)) {
          const DE = (globalThis as Record<string, unknown>).DOMException;
          if (typeof DE === "function")
            throw new (DE as new (m: string, n: string) => Error)("Invalid targetOrigin '" + String(targetOrigin) + "'", "SyntaxError");
          throw new Error("Invalid targetOrigin '" + String(targetOrigin) + "'");
        }
        send("popupMessage", { msg, targetOrigin: t });
      },
    };
    pidOf.set(f, pid);
    byPid.set(pid, f);
    if (n) namedFacades.set(n, f);
  } else {
    /* Native named-window reuse: one facade, the newest open wins;
       a still-queued earlier open is canceled so only the last
       navigation ships. */
    const old = pidOf.get(f);
    if (old !== undefined) {
      const q = pendingByPid.get(old);
      if (q) q.dead = true;
      byPid.delete(old);
      pendingByPid.delete(old);
    }
    pidOf.set(f, st.pid);
    byPid.set(st.pid, f);
  }
  return f;
}
/** #416/#553: a handled popup has a routing target. The synchronous
    return contract is kept by popupFacade; a fail-closed embedder
    still swallows and window.open answers null. The optional top
    flag (#558) routes a target=_top activation instead: the
    embedder owns the real top document, and a realm without a live
    embedder answers false so the caller keeps its native drive. */
export function embedPopup(w: object, href: string, fallback: () => void, top?: boolean, name?: string): boolean {
  const open = popups.get(w);
  if (!open) return false;
  const n = typeof name === "string" ? name : "";
  const pid = "zlp" + ++pidSeq;
  open({ href, fallback, top, pid, name: n });
  lastOpen.set(w, { pid, name: n });
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
    facadeRouted.delete(w);
    ops.delete(w);
    /* every facade this realm minted is terminal now: swallowed
       (fail closed) or moot (standalone answered native windows) */
    for (const f of byPid.values()) shut.add(f);
    byPid.clear();
    pendingByPid.clear();
    namedFacades.clear();
    if (standalone) popups.delete(w);
    else popups.set(w, () => {}); // unknown embedder fails closed (#558 tops too: not routed, not driven)
    for (const p of pending.splice(0)) {
      if (standalone) { try { p.fallback(); } catch { /* popup blocked */ } }
    }
  };
  popups.set(w, (p) => { if (pending.length < 32) { pending.push(p); pendingByPid.set(p.pid, p); } });
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
      const open = (p: Popup): void => {
        /* #558: a top-nav request rides the same channel under its
           own type: the embedder owns the real top, so the realm
           never drives the top natively once the embedder is
           known (a split-origin top commit lands in the
           first-party worker partition, which holds a different
           route key and no transport config, and strands on the
           host shell). No clientId rides this message: the
           embedder routes the active tab. */
        pendingByPid.delete(p.pid);
        if (p.dead) return;
        if (p.top) return post({ lb: "navigateTab", data: { href: p.href } });
        if (!p.href || p.href === "about:blank") {
          post({ lb: "navigate", data: { href: "", newTab: true, blank: true, clientId, pid: p.pid, name: p.name } });
          return;
        }
        let u: URL;
        try { u = new NativeURL(p.href, cur); } catch { return; }
        if (!/^https?:$/.test(u.protocol)) return;
        const send = (href: string) => post({ lb: "navigate", data: { href, newTab: true, clientId, pid: p.pid, name: p.name } });
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
      ops.set(w, (op, pid, name, data) => { post({ lb: op, data: Object.assign({ pid, name }, data) }); });
      for (const p of pending.splice(0)) open(p);
      emit();
      onVlocChange((virt: string) => { if (base) { cur = base + virt; emit(); } });
      /* #553: host state reports flip the facade's closed; origin and
         source pin the sender to the handshake-verified embedder. */
      try {
        (w.addEventListener as Window["addEventListener"] | undefined)?.call(
          w as unknown as Window,
          "message",
          ((ev: MessageEvent) => {
            if (ev.origin !== origin || ev.source !== parent) return;
            const d = ev.data as { lb?: string; data?: { pid?: unknown; closed?: unknown } } | null;
            if (!d || d.lb !== "popupState" || typeof d.data?.pid !== "string") return;
            const f = byPid.get(d.data.pid);
            if (f && d.data.closed === true) shut.add(f);
          }) as EventListener,
        );
      } catch { /* host state reports are optional */ }
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
