/* Same-site frame messaging repair (#128, #130, #131, #132).

   Every engine-routed document is served from one real origin, so
   cross-frame calls name their target by VIRTUAL origin: the
   reCAPTCHA anchor calls parent.postMessage(msg, pageVO), the page
   answers through anchor.contentWindow.postMessage(msg, vo).
   Unproxied those origins match; proxied the browser drops every
   one of them. Provider-direct frames would restore the match but
   leak the user's IP to the upstream site (#32 class, ruled out),
   so frames stay engine-routed and the repair is sender-side:

   - own slot: a foreign targetOrigin is rewritten to the real
     engine origin and delivered natively, in the standard order
     for every call shape; every other shape replays the exact
     argument list so native overload resolution keeps its own
     semantics (a bare legacy port call drops its ports on
     self-delivery and preserves them cross-frame, exactly what
     the unproxied browser does - measured 2026-10-10).
   - parent half (#131): a child whose parent carries the stashed
     native (__zlNativePM) shadows window.parent with a Proxy whose
     postMessage executes the parent's native from the CHILD realm,
     so the browser stamps the genuine caller as ev.source.
   - child half (#132): contentWindow on the iframe/frame
     prototypes returns a cached Proxy whose postMessage executes
     the CHILD stashed native from THIS realm, so parent->child
     calls land with ev.source = the parent, not the child itself.
     The cache is module scope, mintable on demand
     (mintChildProxy) and scanned per frame element
     (childProxyByFrame), so vorigin relabel presents the SAME
     identity to a strict listener even when the event beats the
     realm first post-bootstrap contentWindow read.
   - parity drop (#132): a parseable targetOrigin the recipient's
     __zlVO does not match is DROPPED, exactly what the unproxied
     browser does (self-echo phantoms die here). Marker pending or
     absent: deliver, never break messaging on the race.

   Recipient-side, vorigin.ts re-labels ev.origin with ev.source's
   virtual origin and ev.source with the shared child proxy.
   Residuals: window.top and window.frames[i] are LegacyUnforgeable
   and keep receiver-side behavior (a top-path cross-realm call
   still delivers with the top realm's source). */
type AnyRecord = Record<string, any>;

/* #132: the child-proxy cache. One map per realm (each realm loads
   its own bootstrap instance). Populated by the contentWindow
   getter or minted on demand by vorigin relabel, so every surface
   hands out the identical proxy object. */
const childProxies = new WeakMap<object, AnyRecord>();

/* The cached child proxy for a child window this realm has already
   read through contentWindow, or undefined. A child never read that
   way keeps its raw window identity: a raw reference held by page
   code then still compares equal to the delivered ev.source. */
export function childProxyOf(child: unknown): AnyRecord | undefined {
  const c = child as AnyRecord | null;
  if (!c || typeof c !== "object") return undefined;
  return childProxies.get(c);
}

/* Mint (or fetch) the shared child proxy for a same-origin child
   carrying the stashed native. A cross-origin child throws on the
   property read and stays raw; a child without the stash (native
   or pre-bootstrap) stays raw too. Exported for vorigin relabel:
   an event can arrive before this realm ever read that sender
   through contentWindow, while the strict listener does a LIVE
   contentWindow read inside its own handler - both surfaces must
   converge on one proxy, so the first need mints it and every
   later read (getter or relabel) finds the same cache entry
   (#132 race). */
export function mintChildProxy(real: string, child: unknown): AnyRecord | undefined {
  const c = child as AnyRecord | null;
  if (!c || typeof c !== "object") return undefined;
  let px = childProxies.get(c);
  if (px) return px;
  let np: ((...a: unknown[]) => void) | undefined;
  try {
    np = c.__zlNativePM;
  } catch {
    return undefined; /* cross-origin child: raw identity */
  }
  if (typeof np !== "function") return undefined;
  px = proxyOf(c, senderPm(c, np, real));
  childProxies.set(c, px);
  return px;
}

/* The shared proxy for a delivered event sender, only when the
   sender is one of THIS document frame children. Scoping keeps a
   parent or top-level sender raw (window.parent/top are not
   contentWindow reads). Reading el.contentWindow runs the
   shimmed getter, which populates the cache; the unwrapped
   compare then catches a stashed child, and a raw return means
   the child has no bootstrap yet and keeps its raw identity. */
export function childProxyByFrame(w: AnyRecord, real: string, src: unknown): AnyRecord | undefined {
  const hit = childProxyOf(src);
  if (hit) return hit;
  try {
    const els = (w.document as Document | undefined)?.querySelectorAll("iframe,frame");
    if (!els) return undefined;
    for (const el of els) {
      try {
        /* A pre-bootstrap child reads raw here, and mint then
           returns undefined (no stash), so raw stays raw. */
        const cw = (el as AnyRecord).contentWindow as AnyRecord | undefined;
        if (cw && (cw.window as unknown) === src) return mintChildProxy(real, src);
      } catch {
        /* cross-origin frame element: skip */
      }
    }
  } catch {
    /* no document: raw stays raw */
  }
  return undefined;
}

/* The sender-side delivery function shared by the parent half and
   the child half: normalize every call shape (standard order,
   legacy WebKit order, the bare legacy port call) into the
   standard order, apply the #132 parity drop, then run the
   recipient's stashed native so the incumbent realm is the
   CALLER's (ev.source = the genuine caller window). */
function senderPm(
  target: AnyRecord,
  native: (...a: unknown[]) => void,
  real: string,
): (msg: unknown, a2: unknown, a3: unknown) => void {
  return function (msg, a2, a3) {
    const origin = typeof a2 === "string" ? a2 : typeof a3 === "string" ? a3 : undefined;
    let to = origin;
    /* #130 residual: the bare legacy port call carries no
       targetOrigin anywhere, so deliver against the real origin or
       Chromium's legacy overload drops the ports. */
    if (typeof origin !== "string" && Array.isArray(a2)) to = real;
    if (typeof origin === "string" && origin !== "*" && origin !== "/" && origin !== real) {
      let want = "";
      try {
        want = new URL(origin).origin;
      } catch {
        want = ""; /* malformed: the native keeps its SyntaxError */
      }
      if (want && want !== real) {
        const vo = target.__zlVO;
        if (typeof vo === "string" && vo && want !== vo) return; /* #132 parity: the real web drops this */
        to = real;
      }
    }
    const ports = typeof a2 === "string" ? a3 : a2;
    if (Array.isArray(ports)) native.call(target, msg, to, ports);
    else native.call(target, msg, to);
  };
}

/* Transparent proxy for a target window: postMessage routes through
   the sender shim; other reads pass through, binding configurable
   functions (a non-configurable property must keep its exact
   identity through the proxy, and unforgeable members reject a
   proxy receiver anyway). */
function proxyOf(
  target: AnyRecord,
  pm: (msg: unknown, a2: unknown, a3: unknown) => void,
): AnyRecord {
  return new Proxy(target, {
    get(t: AnyRecord, p: string | symbol): unknown {
      if (p === "postMessage") return pm;
      const d = Reflect.getOwnPropertyDescriptor(t, p);
      const v = Reflect.get(t, p, t);
      return !d || !d.configurable || typeof v !== "function"
        ? v
        : (v as (...a: unknown[]) => unknown).bind(t);
    },
  });
}

/* #132 child half: shadow contentWindow on the iframe/frame
   prototypes so a parent messaging its child delivers from the
   PARENT realm (the unproxied shape). Cached per child window so
   identity holds across reads. A child without the stash (native,
   pre-bootstrap, cross-origin) keeps its raw window. */
function applyChildWindowShim(w: AnyRecord, real: string): void {
  const wrap = (child: unknown): unknown => {
    const c = child as AnyRecord | null;
    if (!c || typeof c !== "object") return child;
    return mintChildProxy(real, c) ?? child;
  };
  const shadow = (ctorName: string): void => {
    const proto = (w[ctorName] as AnyRecord | undefined)?.prototype as AnyRecord | undefined;
    if (!proto) return; /* no frames in this context (tests, workers) */
    const d = Object.getOwnPropertyDescriptor(proto, "contentWindow");
    if (!d || !d.configurable || typeof d.get !== "function") return;
    if ((d.get as AnyRecord).__zlCW) return; /* already ours */
    const orig = d.get as (this: AnyRecord) => unknown;
    const get = function (this: AnyRecord): unknown {
      try {
        return wrap(orig.call(this));
      } catch {
        return orig.call(this);
      }
    };
    (get as AnyRecord).__zlCW = 1;
    try {
      Object.defineProperty(proto, "contentWindow", { get, configurable: true });
    } catch {
      /* locked: the native getter stays */
    }
  };
  shadow("HTMLIFrameElement");
  shadow("HTMLFrameElement");
}

/* #131/#132: the sender-side halves. Runs in every engine realm
   (from applyPostMessage) and every guarded inline child realm
   (from navguard's guardChild). */
export function applySenderShim(w: AnyRecord): void {
  let real = "";
  try {
    real = (w.location as Location | undefined)?.origin ?? "";
  } catch {
    return;
  }
  if (!real) return;
  /* The child half applies in every realm: any engine realm can be
     the parent of an iframe. */
  applyChildWindowShim(w, real);
  let pw: AnyRecord | undefined;
  let np: ((...a: unknown[]) => void) | undefined;
  try {
    pw = w.parent as AnyRecord | undefined;
    np = pw?.__zlNativePM as ((...a: unknown[]) => void) | undefined;
  } catch {
    return; /* cross-origin parent: access throws, native stays */
  }
  if (!pw || (pw as unknown) === (w as unknown)) return; /* top-level realm */
  if (typeof np !== "function") return; /* unpatched parent: native stays */
  const target = pw;
  try {
    Object.defineProperty(w, "parent", {
      /* mintChildProxy shares the child-proxies cache, so a
         listener comparing ev.source === window.parent sees the
         same object the relabel presents for a parent sender. */
      get: () => mintChildProxy(real, target) ?? target,
      configurable: true,
      enumerable: true,
    });
  } catch {
    /* parent refuses the shadow: native stays */
  }
}

export function applyPostMessage(w: AnyRecord): void {
  const native = w.postMessage as ((...a: unknown[]) => void) | undefined;
  if (typeof native !== "function") return;
  let real = "";
  try {
    real = (w.location as Location | undefined)?.origin ?? "";
  } catch {
    return;
  }
  if (!real) return;
  /* #131: stash the native where a patched child can reach it before
     the wrapper takes the own slot. A sealed window keeps its native
     messaging (documented gap, same as the wrap failure below). */
  try {
    Object.defineProperty(w, "__zlNativePM", {
      value: native,
      configurable: true,
    });
  } catch {
    /* sealed: children of this realm keep the native parent path */
  }
  const wrapped = function (...args: unknown[]): void {
    const a2 = args[1];
    const a3 = args[2];
    /* Standard order: (msg, targetOrigin, transfer). Legacy WebKit
       order: (msg, transfer, targetOrigin). */
    const origin = typeof a2 === "string" ? a2 : typeof a3 === "string" ? a3 : undefined;
    if (typeof origin === "string" && origin !== "*" && origin !== "/" && origin !== real) {
      let want = "";
      try {
        want = new URL(origin).origin;
      } catch {
        want = ""; // malformed: keep the native SyntaxError below
      }
      if (want && want !== real) {
        /* #132 parity: the unproxied browser drops a call whose
           targetOrigin does not match the recipient's origin; the
           marker still pending -> deliver (never break on the
           race). */
        const vo = w.__zlVO;
        if (typeof vo === "string" && vo && want !== vo) return;
        /* Foreign target: deliver on the real origin so the browser
           provides ev.source and transfers the ports; the recipient's
           filter re-labels the event with the sender's virtual
           origin. Standard order regardless of the caller's shape. */
        const ports = typeof a2 === "string" ? a3 : a2;
        if (Array.isArray(ports)) native.call(w, args[0], real, ports);
        else native.call(w, args[0], real);
        return;
      }
    }
    /* Replay the caller's exact argument list so the native
       overload resolution sees the same call shape it would
       unproxied. The bare legacy port call postMessage(msg, [ports])
       keeps native semantics that way: the ports die on
       self-delivery and survive cross-frame (measured 2026-10-10
       against the unproxied widget), which is exactly the shape
       page code expects - re-emitting it in standard order would
       deliver phantom self-ports a first-match setup listener
       steals. */
    native.apply(w, args);
  };
  try {
    Object.defineProperty(w, "postMessage", {
      value: wrapped,
      configurable: true,
    });
  } catch {
    /* read-only: native messaging stays (documented gap) */
  }
  /* #131/#132: this realm's own calls get the sender-side halves
     (a no-op parent half for a top-level realm). */
  applySenderShim(w);
}
