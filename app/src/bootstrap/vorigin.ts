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
     and window.onmessage) receive events whose source is re-labelled
     with the shared contentWindow proxy when the sender is a child
     this realm has already read through contentWindow (#132
     identity: gstatic's channel establisher checks ev.source ===
     iframe.contentWindow, and the shimmed getter hands out the
     proxy). ev.origin deliberately stays the native ENGINE origin
     (#132 follow-up: recipients such as the reCAPTCHA channel
     establishers derive the origin they expect from the rewritten
     src/co= URLs, which point at the engine; a virtual-origin
     relabel made every origin check fail and the setup port was
     never taken, so the widget timed out). Events from the engine
     itself (worker pushes, unmarked frames, native child realms)
     keep their native origin and source.

   Honest tradeoffs, deliberate (#32 relaxation, user-authorized):
   page-realm scripts can read their own site's origin from __zlVO at
   runtime (the destination still never enters the injected init
   script); the marker no longer drives an origin relabel (see the
   filter note above), it only feeds the sender-side parity checks
   in postmsg. Without a controller, or when the reply never lands,
   the module installs nothing and listeners keep the native
   engine-origin view. */

import { swc } from "./siteid";
import { childProxyByFrame } from "./postmsg";

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

  /* ---- filter: re-label engine-origin message event sources ------ */
  const relabel = (ev: unknown): unknown => {
    const e = ev as { origin?: unknown; source?: unknown };
    if (!e || e.origin !== real) return ev;
    /* #132 identity: the strict channel establisher compares
       ev.source with a LIVE iframe.contentWindow read. The shimmed
       getter and this relabel share one per-child proxy cache, and
       a miss is allowed to MINT the entry when the sender is one
       of this document frame children, so the first delivered
       event and every later read converge on the same proxy
       instead of racing raw-vs-proxy while the anchor is rebuilt
       (the widget timed out on exactly that loop). Strangers stay
       raw. */
    const src = e.source;
    if (src && typeof src === "object" && (src as object) !== (w as object)) {
      const px = childProxyByFrame(w, real, src);
      if (px) {
        try {
          Object.defineProperty(e, "source", { get: () => px, configurable: true });
        } catch {
          /* not redefinable: the listener sees the raw window */
        }
      }
    }
    /* #132 follow-up: ev.origin deliberately stays the native ENGINE
       origin. Channel establishers (reCAPTCHA gstatic among them)
       derive the origin they expect from the rewritten src/co= URLs,
       which point at the engine; relabeling to the sender's virtual
       origin made every origin check fail and the setup port was
       never taken (the widget timed out on exactly that). */
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
