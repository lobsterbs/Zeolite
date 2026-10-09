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

   Two call shapes must both work: the standard
   postMessage(msg, targetOrigin, transfer) and the legacy WebKit
   order postMessage(msg, transfer, targetOrigin), whose targetOrigin
   may be omitted entirely (defaults to "*"). The legacy overload is
   live in the spec and in Chromium; reCAPTCHA's frame protocol uses
   the bare two-argument form postMessage(msg, [port]). Delegation
   must replay the ORIGINAL argument list: re-emitting that call as
   (msg, [port], undefined) makes the binding pick the standard
   overload and throw "Invalid target origin '[object MessagePort]'"
   (seen live on the anchor frame once #129 routed it engine-side).

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
  ports: unknown,
): unknown {
  const list = Array.isArray(ports) ? ports : [];
  const init = { data, origin, source: null, ports: list, lastEventId: "" };
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
  const native = w.postMessage as ((...a: unknown[]) => void) | undefined;
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
    | ((m: unknown) => unknown)
    | undefined;
  const wrapped = function (...args: unknown[]): void {
    const msg = args[0];
    const a2 = args[1];
    const a3 = args[2];
    /* Standard order: (msg, targetOrigin, transfer). Legacy WebKit
       order: (msg, transfer, targetOrigin). */
    const origin = typeof a2 === "string" ? a2 : typeof a3 === "string" ? a3 : undefined;
    const ports = typeof a2 === "string" ? a3 : a2;
    if (typeof origin === "string" && origin !== "*" && origin !== "/") {
      let want = "";
      try {
        want = new URL(origin).origin;
      } catch {
        want = ""; // malformed: keep the native SyntaxError below
      }
      if (want && want !== real) {
        let data = msg;
        if (typeof clone === "function") {
          try {
            /* No transfer list: same-realm delivery keeps the ports
               live for the recipient. structuredClone with a
               transfer would neuter them into an unreachable clone
               and kill the channel with the message. */
            data = clone(msg);
          } catch {
            data = msg; // non-cloneable payload: deliver by reference
          }
        }
        try {
          dispatch.call(w, makeMessageEvent(ME, data, want, ports));
        } catch {
          /* a listener threw during dispatch: not ours to surface */
        }
        return;
      }
    }
    /* Replay the caller's exact argument list so the native
       overload resolution sees the same call shape it would
       unproxied (a legacy two-arg call must not gain a third
       undefined argument). */
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
