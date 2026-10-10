/* Same-site frame messaging repair (issues #128, #130, #131).

   Every engine-routed document is served from one real origin, so a
   page that messages its own same-site frame addresses it by the
   frame's VIRTUAL origin: win.postMessage(msg, "https://site.example")
   names a window whose real origin is the engine. The browser would
   drop the message with a console warning and the frame protocol
   times out (reCAPTCHA: the postMessage origin-mismatch warning,
   then a spin/timeout).

   The frame stays engine-routed on purpose: provider-direct would
   connect the user's browser straight to the upstream site and leak
   the user's IP (the #32 class - ruled out).

   The repair (#130): a targetOrigin that parses to a foreign origin
   is rewritten to the REAL engine origin and the call is delivered
   natively - the browser then provides a real ev.source and truly
   transferred ports. The recipient's filter (vorigin.ts) re-labels
   the message event with the sender's virtual origin, so listeners
   see exactly what an unproxied same-site delivery would show.

   Two call shapes must both work: the standard
   postMessage(msg, targetOrigin, transfer) and the legacy WebKit
   order postMessage(msg, transfer, targetOrigin). Virtual-target
   calls of both shapes re-emit in the standard order; native-path
   calls replay the caller's EXACT argument list so overload
   resolution sees the same call shape it would unproxied (a
   legacy two-arg call must not gain a phantom third argument, and a
   malformed targetOrigin keeps the native SyntaxError). One shape
   is exempt: the bare two-argument legacy port call
   postMessage(msg, [ports]) is re-emitted in the standard order
   against the real origin, because Chromium's legacy overload
   drops the transferred ports on same-origin delivery - the exact
   replay reaches the recipient but portless (#130 residual).

   The identity repair (#131): the wrapper above re-emits from the
   realm it was CREATED in, so a cross-realm call - the reCAPTCHA
   anchor calling parent.postMessage - lands on the page's wrapper
   and the re-emission executes in the PAGE realm: the browser
   stamps ev.source with the page window and the recipient cannot
   tell the message from the page's own (measured: the anchor's
   setup events arrive from=self and the page's grecaptcha drops
   them; the widget spins and times out). A receiver-side wrapper
   cannot know its caller, so the repair is sender-side: the child
   shadows its own window.parent getter (parent is a configurable
   accessor - measured; top is LegacyUnforgeable and stays native)
   with a Proxy whose postMessage executes the parent's stashed
   native (__zlNativePM) from the CHILD realm. The browser then
   stamps the genuine caller's window as ev.source, transfers the
   ports through the normalized standard shape, and the targetOrigin
   is rewritten exactly like the wrapper does. The parent's own
   wrapper keeps serving self-calls and receive-path normalization;
   patched children simply stop routing through it. Honest limits:
   window.top and window.frames[i] callers keep the receiver-side
   behavior (documented residual), and a cross-origin parent (the
   real-world shape) throws on the realm probe and keeps everything
   native, which is correct: cross-origin callers reach built-ins
   and never see the wrapper at all. */

type AnyRecord = Record<string, any>;

/* #131: the child-side half. Runs in every engine realm (from
   applyPostMessage) and every guarded inline child realm (from
   navguard's guardChild): a child whose parent is a patched engine
   realm shadows window.parent so the parent's postMessage reads
   route through the child realm. */
export function applySenderShim(w: AnyRecord): void {
  let real = "";
  try {
    real = (w.location as Location | undefined)?.origin ?? "";
  } catch {
    return;
  }
  if (!real) return;
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
  const native = np;
  const shim = function (msg: unknown, a2: unknown, a3: unknown): void {
    /* Standard order (msg, targetOrigin, transfer), legacy WebKit
       order (msg, transfer, targetOrigin) and the bare legacy port
       call (msg, [ports]) all deliver in the standard order, the
       same normalization the page-side wrapper applies. */
    const origin = typeof a2 === "string" ? a2 : typeof a3 === "string" ? a3 : undefined;
    let to = origin;
    /* #130 residual on the parent path too: the bare legacy port
       call carries no targetOrigin anywhere, so deliver against the
       real origin or Chromium's legacy overload drops the ports. */
    if (typeof origin !== "string" && Array.isArray(a2)) to = real;
    if (typeof origin === "string" && origin !== "*" && origin !== "/") {
      let want = "";
      try {
        want = new URL(origin).origin;
      } catch {
        want = ""; /* malformed: the native keeps its SyntaxError */
      }
      if (want && want !== real) to = real;
    }
    const ports = typeof a2 === "string" ? a3 : a2;
    if (Array.isArray(ports)) native.call(target, msg, to, ports);
    else native.call(target, msg, to);
  };
  const px = new Proxy(target, {
    get(t: AnyRecord, p: string | symbol): unknown {
      if (p === "postMessage") return shim;
      const d = Reflect.getOwnPropertyDescriptor(t, p);
      const v = Reflect.get(t, p, t);
      /* Bind only configurable functions: a non-configurable target
         property must keep its exact identity through the proxy
         (invariant), and unforgeable members reject a proxy
         receiver anyway. */
      return !d || !d.configurable || typeof v !== "function"
        ? v
        : (v as (...a: unknown[]) => unknown).bind(t);
    },
  });
  try {
    Object.defineProperty(w, "parent", {
      get: () => px,
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
    if (typeof origin === "string" && origin !== "*" && origin !== "/") {
      let want = "";
      try {
        want = new URL(origin).origin;
      } catch {
        want = ""; // malformed: keep the native SyntaxError below
      }
      if (want && want !== real) {
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
    /* Legacy bare two-argument port call: postMessage(msg, [ports])
       with no targetOrigin anywhere. Chromium's legacy overload
       delivers the message but DROPS the ports on the event
       (measured: ev.ports.length 0 on a same-origin delivery), which
       kills every port-channel frame protocol - reCAPTCHA hands its
       anchor the private setup port in exactly this shape and the
       widget times out waiting on a port that never arrived
       (#130 residual). The wrapped window always lives on the real
       engine origin, so re-emitting in the standard order against
       it is the same delivery with the ports actually transferred.
       Unproxied this shape targets a cross-origin frame, where the
       legacy overload preserves ports; no engine frame is ever
       cross-origin, so the rewrite is behavior-preserving here. */
    if (args.length === 2 && Array.isArray(a2)) {
      native.call(w, args[0], real, a2);
      return;
    }
    /* Replay the caller's exact argument list so the native overload
       resolution sees the same call shape it would unproxied. */
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
  /* #131: this realm's own calls to its parent get the child-side
     half (a no-op for a top-level realm). */
  applySenderShim(w);
}
