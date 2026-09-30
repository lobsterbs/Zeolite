/* WebSocket bridge: ws(s):// is routed through the engine controller
   (zl:wsOpen) with native event semantics. Split out of the bootstrap
   entry; the body is unchanged. */

import { swc } from "./siteid";

export function applyWs(w: Record<string, unknown>, ORIGIN: string): void {
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
      try {
        u = new URL(url);
      } catch {
        throw new DOMException(url, "SyntaxError");
      }
      if (!/^wss?:$/.test(u.protocol)) {
        return new OWS(url, protocols);
      }
      /* Issue #4: a same-origin ws from a proxied page means the
         virtual origin. The engine host serves no ws endpoints, so
         wss://<engine host>/x would fail; retarget to the site. */
      if (ORIGIN && u.origin === (w.location as { origin: string }).origin) {
        try {
          const vp = u.protocol;
          u = new URL(u.pathname + u.search, ORIGIN);
          u.protocol = vp;
        } catch {
          /* unparseable virtual origin: keep engine-local */
        }
      }
      const es = new EventTarget() as unknown as WebSocket;
      let wsState = 0;
      let binType: "blob" | "arraybuffer" = "blob";
      let proto = "";
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
        if (m.ev === "open") {
          wsState = 1;
          proto = m.protocol ?? "";
          disp(new Event("open"));
        } else if (m.ev === "message") {
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
            /* u.href, not the original string: a same-origin URL may
               have been retargeted to the virtual origin above. */
            url: u.href,
            protocols: ([] as string[]).concat(protocols ?? []),
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
            /* Spec: send() while CONNECTING buffers at the bridge; only
               CLOSING/CLOSED throw. */
            if (wsState >= 2) throw new DOMException("invalid state", "InvalidStateError");
            ch.port1.postMessage({ op: "send", data });
          },
        },
      });
      return es;
    } as unknown as new (u: string, p?: string | string[]) => WebSocket;
    Object.assign(LJWS as unknown as Record<string, unknown>, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: OWS.prototype });
    (w as { WebSocket?: unknown }).WebSocket = LJWS;
  }
}

}
