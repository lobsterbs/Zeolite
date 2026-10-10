/* Same-site frame messaging repair (issues #128, #130).

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
   replay reaches the recipient but portless (#130 residual). */

export function applyPostMessage(w: Record<string, unknown>): void {
  const native = w.postMessage as ((...a: unknown[]) => void) | undefined;
  if (typeof native !== "function") return;
  let real = "";
  try {
    real = (w.location as Location | undefined)?.origin ?? "";
  } catch {
    return;
  }
  if (!real) return;
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
}
