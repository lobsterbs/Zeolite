/* Same-site frame messaging repair (issue #128).

   Every engine-routed document is served from one real origin, so a
   page that messages its own same-site frame addresses it by the
   frame's VIRTUAL origin: win.postMessage(msg, "https://site.example")
   names a window whose real origin is the engine. The browser drops
   the message with a console warning and the frame protocol times
   out (reCAPTCHA enterprise on google search: the postMessage
   origin-mismatch warning, then "Failed to fetch" reported to
   google's own jserror endpoint).

   The frame stays engine-routed on purpose: passing it
   provider-direct would connect the user's browser straight to the
   upstream site and leak the user's IP (the #32 class - ruled out).

   The repair: when this window's postMessage is called with a
   targetOrigin that parses to an origin different from the real
   one, the payload is delivered locally as a synthetic "message"
   event whose origin is the origin the caller intended - exactly
   the sender origin an unproxied same-site listener would see.
   Matching targets, "*" and "/" keep the native path untouched, and
   a malformed targetOrigin keeps the native SyntaxError.

   Known gaps, deliberate: ev.source is null on the synthetic path
   (the real sender window is not observable from the recipient);
   the payload is only structured-cloned when the host exposes
   structuredClone; cross-VIRTUAL-site messages (a page messaging a
   frame of a different virtual site) carry the target's origin
   rather than the sender's - pre-repair those were dropped
   outright, and the receiver's own origin check still guards it.
   Install style follows the #35 lesson: defineProperty, plain
   assignment no-ops on accessor-only properties. */

type MsgEventCtor = new (t: string, init?: Record<string, unknown>) => unknown;

function makeMessageEvent(
  ME: MsgEventCtor | undefined,
  data: unknown,
  origin: string,
  transfer: unknown[] | undefined,
): unknown {
  const ports = Array.isArray(transfer) ? transfer : [];
  const init = { data, origin, source: null, ports, lastEventId: "" };
  if (ME) {
    try {
      return new ME("message", init);
    } catch {
      /* fall through to the stand-in */
    }
  }
  /* Structural stand-in with the same readable fields for hosts
     without a MessageEvent constructor (the isolation.ts #37
     pattern: honest fields, never a fake API). */
  return { type: "message", ...init };
}

export function applyPostMessage(w: Record<string, unknown>): void {
  const native = w.postMessage as
    | ((m: unknown, t?: unknown, tr?: unknown[]) => void)
    | undefined;
  const dispatch = w.dispatchEvent as ((e: unknown) => boolean) | undefined;
  if (typeof native !== "function" || typeof dispatch !== "function") return;
  let real = "";
  try {
    real = (w.location as Location | undefined)?.origin ?? "";
  } catch {
    return;
  }
  if (!real) return;
  const ME = w.MessageEvent as MsgEventCtor | undefined;
  const clone = w.structuredClone as
    | ((m: unknown, o?: { transfer: unknown[] }) => unknown)
    | undefined;
  const wrapped = function (
    msg: unknown,
    targetOrigin?: unknown,
    transfer?: unknown[],
  ): void {
    if (
      typeof targetOrigin === "string" &&
      targetOrigin !== "*" &&
      targetOrigin !== "/"
    ) {
      let want = "";
      try {
        want = new URL(targetOrigin).origin;
      } catch {
        want = ""; // malformed: keep the native SyntaxError below
      }
      if (want && want !== real) {
        let data = msg;
        if (typeof clone === "function") {
          try {
            data = clone(
              msg,
              Array.isArray(transfer) ? { transfer } : undefined,
            );
          } catch {
            data = msg; // non-cloneable payload: deliver by reference
          }
        }
        try {
          dispatch.call(w, makeMessageEvent(ME, data, want, transfer));
        } catch {
          /* a listener threw during dispatch: not ours to surface */
        }
        return;
      }
    }
    native.call(w, msg, targetOrigin, transfer);
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
