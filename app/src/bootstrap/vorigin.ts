/* Per-realm virtual-origin marker + message-event origin filter (#130).

   The engine serves every virtual site from one real origin, so a
   natively delivered frame message arrives with the ENGINE origin
   and a real ev.source. This module makes the page-realm surface
   look unproxied:

   - the marker: the bootstrap asks the engine controller
     (zl:getVirtualOrigin) for THIS client's own virtual origin,
     recovered worker-side from the client's engine route, never from
     a page-supplied claim, and installs it as a non-enumerable
     window.__zlVO.
   - the filter: page-registered "message" listeners (addEventListener
     and window.onmessage) receive events whose origin is re-labelled
     with ev.source.__zlVO when the sender carries the marker, and
     whose source is re-labelled with the shared contentWindow proxy
     when the sender is a child this realm has already read through
     contentWindow (#132 identity: gstatic's channel establisher
     checks ev.source === iframe.contentWindow, and the shimmed
     getter hands out the proxy). Events from the engine itself
     (worker pushes, unmarked frames, native child realms) keep
     their native origin and source.

   Honest tradeoffs, deliberate (#32 relaxation, user-authorized):
   page-realm scripts can read their own site's origin from __zlVO at
   runtime (the destination still never enters the injected init
   script), and a spoofed __zlVO can relabel a message with another
   virtual site's origin - but every engine frame is already
   same-origin scriptable, so no new capability is granted. Without
   a controller, or when the reply never lands, the module installs
   nothing and listeners keep the native engine-origin view. */

import { swc } from "./siteid";
import { childProxyOf } from "./postmsg";

export function applyVirtualOrigin(w: Record<string, unknown>): void {
  const ctl = swc();
  if (!ctl) return;
  let real = "";
  try {
    real = (w.location as Location | undefined)?.origin ?? "";
  } catch {
    return;
  }
  if (!real) return;

  /* ---- marker: this realm's own virtual origin ------------------ */
  const ch = new MessageChannel();
  ch.port1.onmessage = (ev) => {
    const vo = (ev.data as { vo?: unknown }).vo;
    if (typeof vo !== "string" || !vo) return;
    try {
      Object.defineProperty(w, "__zlVO", { value: vo, configurable: true });
    } catch {
      /* sealed or pre-occupied: the filter stays inert for this sender */
    }
  };
  try {
    ctl.postMessage({ type: "zl:getVirtualOrigin" }, [ch.port2]);
  } catch {
    return; // no channel: no marker, and no filter to feed
  }

  /* ---- filter: re-label engine-origin message events ------------- */
  const relabel = (ev: unknown): unknown => {
    const e = ev as { origin?: unknown; source?: unknown };
    if (!e || e.origin !== real) return ev;
    /* #132 identity: the strict channel establisher compares
       ev.source with the iframe's contentWindow. The shimmed getter
       returns a cached proxy, so the delivered event must present
       that SAME proxy or the comparison fails and the setup port is
       never taken (the reCAPTCHA widget then times out). Cache hits
       only: a sender this realm never read through contentWindow
       keeps its raw identity, so a raw reference still compares
       equal. */
    const src = e.source;
    if (src && typeof src === "object" && (src as object) !== (w as object)) {
      const px = childProxyOf(src);
      if (px) {
        try {
          Object.defineProperty(e, "source", { get: () => px, configurable: true });
        } catch {
          /* not redefinable: the listener sees the raw window */
        }
      }
    }
    const vo = (src as Record<string, unknown> | null | undefined)?.__zlVO;
    if (typeof vo !== "string" || !vo) return ev;
    try {
      Object.defineProperty(e, "origin", { get: () => vo, configurable: true });
    } catch {
      /* not redefinable: the listener sees the engine origin */
    }
    return ev;
  };

  const nativeAdd = (w.addEventListener as (...a: unknown[]) => unknown).bind(w);
  const nativeRemove = (w.removeEventListener as (...a: unknown[]) => unknown).bind(w);
  const fwd = new WeakMap<object, (this: unknown, ev: unknown) => unknown>();
  const addWrap = function (...a: unknown[]): unknown {
    if (a[0] === "message" && typeof a[1] === "function") {
      const orig = a[1] as (ev: unknown) => unknown;
      const f = function (this: unknown, ev: unknown) {
        orig.call(this, relabel(ev));
      };
      fwd.set(orig, f);
      return nativeAdd(a[0], f, a[2]);
    }
    return nativeAdd(...a);
  };
  const remWrap = function (...a: unknown[]): unknown {
    const f =
      a[0] === "message" && typeof a[1] === "function"
        ? fwd.get(a[1] as object)
        : undefined;
    return nativeRemove(a[0], f ?? a[1], a[2]);
  };
  /* ponytail: no half-install restore - addEventListener and
     removeEventListener are same-class Window accessors, they fail
     together; a realm where only one is configurable would strand
     registered listeners, add restore logic if that ever shows up. */
  try {
    Object.defineProperty(w, "addEventListener", { value: addWrap, configurable: true });
    Object.defineProperty(w, "removeEventListener", { value: remWrap, configurable: true });
  } catch {
    /* read-only: listeners see the engine origin (documented) */
  }

  /* window.onmessage: the handler slot is the property itself, so
     the stored value is the relaying wrapper (an honest identity
     drift: code reading window.onmessage back sees the wrapper). */
  let onmsg: ((ev: unknown) => unknown) | null = null;
  try {
    Object.defineProperty(w, "onmessage", {
      configurable: true,
      enumerable: true,
      get: () => onmsg,
      set: (fn: unknown) => {
        onmsg =
          typeof fn === "function"
            ? (ev: unknown) => (fn as (e: unknown) => unknown).call(w, relabel(ev))
            : null;
      },
    });
  } catch {
    /* read-only: onmessage sees the engine origin (documented) */
  }
}
