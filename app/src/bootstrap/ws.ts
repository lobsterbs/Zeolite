/* WebSocket bridge: ws(s):// is routed through the engine controller
   (zl:wsOpen) with native event semantics. Split out of the
   bootstrap entry. Issue #32: the shim no longer knows (or holds) the
   real site origin - a same-origin ws URL stays engine-local on the
   page side, and the SW retargets it via the sender's own virtual
   context (#33). The page's ws.url property and message event origins
   therefore report engine-origin URLs as written, never the target. */

import { swc } from "./siteid";

/* #419: normalize the second constructor argument the way the
   native constructor does: undefined/null -> [], a string -> one
   token, a sequence -> its items, anything else (the options
   object Colyseus passes) -> one coerced token, which fails the
   token check and throws SyntaxError like native instead of
   concatenating a garbage entry into the bridge array. */
function wsProtocolsList(protocols: unknown): string[] {
  let list: unknown[];
  if (protocols === undefined || protocols === null) list = [];
  else if (typeof protocols === "string") list = [protocols];
  else if (Array.isArray(protocols)) list = protocols;
  else if (typeof (protocols as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function")
    list = Array.from(protocols as unknown as Iterable<unknown>);
  else list = [protocols];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of list) {
    const s = String(tok);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(s))
      throw new DOMException("The subprotocol '" + s + "' is invalid.", "SyntaxError");
    if (seen.has(s))
      throw new DOMException("The subprotocol '" + s + "' is invalid.", "SyntaxError");
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function applyWs(w: Record<string, unknown>): void {
/* ---- WebSocket ---------------------------------------------------- */
/* The SW cannot intercept WebSocket upgrades, so ws(s):// URLs are
   bridged: this shim posts zl:wsOpen to the controlling SW with a
   dedicated port. The SW opens the connection through the libcurl
   transport (TLS terminates there; a raw wisp TCP stream runs
   underneath) and relays open/message/error/close back over the port.
   Event semantics match the native constructor, so reconnecting
   libraries keep working. Non-ws schemes go to the native ctor. */

{
  const OWS = w.WebSocket as
    | (new (u: string, p?: string | string[]) => WebSocket)
    | undefined;
  if (OWS) {
    const LJWS = function (url: string, protocols?: string | string[]) {
      let u: URL;
      /* #279: resolve what the page wrote against the calling
         realm base (the native constructor demands an absolute
         URL; the engine accepts the relative references
         same-origin apps use), then apply the native URL
         semantics (#364): an explicit non-ws scheme throws
         SyntaxError like native (the throw is explicit, not
         delegated: Node's native ctor silently upgrades http(s));
         only scheme-less relative references map http(s) to ws(s),
         and a fragment fails like native. */
      const base =
        (w.document as { baseURI?: string } | undefined)?.baseURI ||
        (w.location as { href?: string } | undefined)?.href;
      try {
        u = new URL(url, base);
      } catch {
        throw new DOMException(url, "SyntaxError");
      }
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
      if (hasScheme) {
        if (!/^wss?:$/.test(u.protocol)) {
          throw new DOMException(url, "SyntaxError");
        }
      } else if (u.protocol === "http:") u.protocol = "ws:";
      else if (u.protocol === "https:") u.protocol = "wss:";
      if (!/^wss?:$/.test(u.protocol)) {
        return new OWS(url, protocols);
      }
      if (u.href.includes("#")) {
        throw new DOMException(url, "SyntaxError");
      }
      /* #419: validate and normalize the subprotocol list here,
         before anything reaches the bridge. */
      const protoList = wsProtocolsList(protocols);
      const es = new EventTarget() as unknown as WebSocket;
      /* instanceof parity: the EventTarget keeps its internal slots
         and adopts the real prototype; own plain on-handler props
         shadow the prototype's brand-checked accessors so fire()
         still reads plain data. */
      Object.setPrototypeOf(es, OWS.prototype);
      for (const h of ["onopen", "onmessage", "onerror", "onclose"])
        Object.defineProperty(es, h, {
          writable: true,
          enumerable: true,
          configurable: true,
          value: null,
        });
      let wsState = 0;
      let binType: "blob" | "arraybuffer" = "blob";
      let proto = "";
      /* #293: pre-handshake sends queue at the bridge; count them so
         bufferedAmount is honest state, not a frozen 0. */
      let pend = 0;
      const ch = new MessageChannel();
      let q = Promise.resolve();
      /* The EventTarget has no native on* event-handler slots, so the
   raw property handlers fire after the registered listeners
   (native interleaves in registration order), contained so a
   throwing handler cannot kill the event queue. */
const fire = (e: Event) => {
  es.dispatchEvent(e);
  const h = (es as unknown as Record<string, unknown>)["on" + e.type] as
    | ((ev: Event) => void)
    | undefined;
  try {
    if (h) h.call(es, e);
  } catch { /* contained, like a native listener */ }
};
const disp = (e: Event) => {
  q = q.then(() => {
    fire(e);
  });
};
      ch.port1.onmessage = (ev) => {
        /* This port is dedicated to the bridge: every message on it
           comes from the engine and always carries the fields its ev
           name promises (open: protocol, close: code/clean). */
        const m = ev.data as {
          ev: string;
          data?: unknown;
          code?: number;
          clean?: boolean;
          protocol?: string;
        };
        /* Native parity: once CLOSING/CLOSED no further open or
           message events fire (a late engine open or a message
           racing a close is dropped). */
        if (m.ev === "open") {
          if (wsState >= 2) return;
          wsState = 1;
          pend = 0;
          proto = m.protocol ?? "";
          disp(new Event("open"));
        } else if (m.ev === "message") {
          if (wsState >= 2) return;
          q = q.then(async () => {
            let data: unknown = m.data;
            if (binType === "arraybuffer" && data instanceof Blob) {
              data = await data.arrayBuffer();
            }
            fire(new MessageEvent("message", { data, origin: u.origin }));
          });
        } else if (m.ev === "error") {
          disp(new Event("error"));
        } else if (m.ev === "close") {
          wsState = 3;
          disp(new CloseEvent("close", { code: m.code, wasClean: m.clean }));
        }
      };
      const ctl = swc();
      if (!ctl) {
        /* No controller: fail the way a dead ws endpoint would. */
        wsState = 3;
        disp(new Event("error"));
        disp(new CloseEvent("close", { code: 1006, wasClean: false }));
      } else {
        ctl.postMessage(
          {
            type: "zl:wsOpen",
            /* The URL as written: engine-local for same-origin sockets
               (the SW retargets it), the page's own cross-origin
               choice otherwise. */
            url: u.href,
            protocols: protoList,
          },
          [ch.port2],
        );
      }

      Object.defineProperties(es, {
        readyState: { get: () => wsState },
        url: { value: u.href },
        protocol: { get: () => proto },
        binaryType: {
          get: () => binType,
          set: (v: string) => {
            if (v === "blob" || v === "arraybuffer") binType = v;
          },
        },
        close: {
          value: (code?: number, reason?: string) => {
            if (wsState === 3) return;
            wsState = 2;
            ch.port1.postMessage({ op: "close", code: code ?? 1000, reason });
          },
        },
        send: {
          value: (data: unknown) => {
            /* #493: native BufferSource conversion rejects
               SharedArrayBuffer-backed views before the state check:
               a CLOSING socket still throws TypeError for them, never
               InvalidStateError. Reject before counting or posting. */
            if (
              ArrayBuffer.isView(data) &&
              (data as ArrayBufferView).buffer instanceof SharedArrayBuffer
            )
              throw new TypeError("SharedArrayBuffer-backed views are not valid WebSocket payload data.");
            /* Spec: send() while CONNECTING buffers at the bridge; only
               CLOSING/CLOSED throw. */
            if (wsState >= 2) throw new DOMException("invalid state", "InvalidStateError");
            if (wsState === 0) pend++;
            ch.port1.postMessage({ op: "send", data });
          },
        },
        /* #293: own getter - without it the property resolved to the
           native prototype's brand-checked accessor. Counts messages,
           not bytes: the transport's queue depth is unreachable
           without a bridge ack protocol. */
        bufferedAmount: { get: () => pend },
      });
      return es;
    } as unknown as new (u: string, p?: string | string[]) => WebSocket;
    Object.assign(LJWS as unknown as Record<string, unknown>, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: OWS.prototype });
    (w as { WebSocket?: unknown }).WebSocket = LJWS;
  }
}

}
