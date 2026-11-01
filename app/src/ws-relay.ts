/* #511: WebSocket-over-relay factory. Every proxied page WebSocket is
   bridged through the engine; on LB-class deployments the wisp
   transport is auth-refused, so the bridge wedges silently (the
   "Joining Game" hang: no open, no error, no close ever reaches the
   page). When the embedder registered a relay channel, the WebSocket
   rides it instead: the same guarded embedder egress as relayed
   fetches, with the engine-built handshake identity (per-origin
   virtual Origin, jar cookies, per-site UA). Frame protocol over the
   relay port (typed zl:ws*, rid-keyed, disjoint from fetch replies):
   - out: zl:wsRelay {rid,url,protocols,headers}, zl:wsSend
     {rid,data,bin}, zl:wsClose {rid,code,reason}
   - in: zl:wsOpen {rid,protocol}, zl:wsData {rid,data,bin},
     zl:wsClose {rid,code,reason}, zl:wsError {rid,error}
   Binary rides structured clone on the port hop (no base64) and
   native binary frames on the embedder hop. ponytail ceiling: no
   cross-fallback to wisp when the relay ws fails - the page gets an
   honest error, never a wedged or double-opened socket.
   Close parity: onclose fires when the close handshake completes
   (the echoed zl:wsClose or the bounded fallback timer), not when
   close() is called. The conn stays registered while closing, so the
   late close frame still dispatches exactly once.

   bufferedAmount note (#546): the relay arm exposes no write-
   acceptance (the embedder hop carries no ack surface), so there is
   deliberately no zl:wsDrain frame - adding one would be protocol
   without a producer. Relay sockets stay bridge-queue-accounted: the
   page counter drains when the bridge's send() returns, exactly like
   the wisp arm without the optional drainAt() seam. */

import { relaySendWs, relaySubscribe } from "./relayfetch";
import type { WsFactory } from "./wsbridge";

interface Conn {
  onopen: (protocol: string) => void;
  onmessage: (data: unknown) => void;
  onclose: (code: number, reason: string) => void;
  onerror: (error: string) => void;
  opened: boolean;
  closing: boolean;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

const conns = new Map<number, Conn>();
let ridSeq = 0;

const CLOSE_FALLBACK_MS = 5000;

function drop(rid: number, c: Conn): void {
  if (c.closeTimer !== null) clearTimeout(c.closeTimer);
  conns.delete(rid);
}

relaySubscribe((m) => {
  const msg = m as {
    type?: string;
    rid?: unknown;
    protocol?: string;
    data?: unknown;
    bin?: boolean;
    code?: number;
    reason?: string;
    error?: string;
  };
  if (typeof msg?.rid !== "number") return;
  const c = conns.get(msg.rid);
  if (!c) return;
  if (msg.type === "zl:wsOpen") {
    c.opened = true;
    c.onopen(msg.protocol ?? "");
  } else if (msg.type === "zl:wsData") {
    /* Native parity: the page default binaryType is blob, so binary
       arrives as a Blob (the shim converts when the page asks for
       arraybuffer). */
    c.onmessage(
      msg.bin === true
        ? new Blob([(msg.data as Uint8Array).slice().buffer as ArrayBuffer])
        : (msg.data as string),
    );
  } else if (msg.type === "zl:wsClose") {
    drop(msg.rid, c);
    c.onclose(msg.code ?? 1006, msg.reason ?? "");
  } else if (msg.type === "zl:wsError") {
    /* Channel death: honest error out; the bridge ends pre-open
       sockets itself (1006), so a close is only reported here when
       the socket had already opened. */
    drop(msg.rid, c);
    c.onerror(msg.error ?? "relay ws failed");
    if (c.opened) c.onclose(1006, "");
  }
});

function toU8(d: unknown): Uint8Array | null {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) {
    const v = d as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

export const relayWsFactory: WsFactory = {
  open(url, protocols, h, headers) {
    const rid = ++ridSeq;
    const conn: Conn = {
      onopen: h.onopen,
      onmessage: h.onmessage,
      onclose: h.onclose,
      onerror: h.onerror,
      opened: false,
      closing: false,
      closeTimer: null,
    };
    conns.set(rid, conn);
    if (!relaySendWs({ type: "zl:wsRelay", rid, url, protocols, headers: headers ?? [] })) {
      conns.delete(rid);
      throw new Error("relay channel unavailable");
    }
    return {
      send: (data) => {
        const c = conns.get(rid);
        /* Native would throw InvalidStateError after close(); the
           bridge has no catch arm there, so drop instead. */
        if (!c || c.closing) return;
        if (typeof data === "string") {
          relaySendWs({ type: "zl:wsSend", rid, data, bin: false });
          return;
        }
        const u8 = toU8(data);
        if (u8) {
          relaySendWs({ type: "zl:wsSend", rid, data: u8, bin: true });
          return;
        }
        if (data instanceof Blob) {
          /* Async payload: send is sync by contract, so the conversion
             races; a dead or closing conn drops the frame honestly. */
          void data
            .arrayBuffer()
            .then((ab) => {
              const cu = conns.get(rid);
              if (cu && !cu.closing) {
                relaySendWs({ type: "zl:wsSend", rid, data: new Uint8Array(ab), bin: true });
              }
            })
            .catch(() => {});
        }
      },
      close: (code, reason) => {
        const c = conns.get(rid);
        if (!c || c.closing) return;
        c.closing = true;
        if (!relaySendWs({ type: "zl:wsClose", rid, code, reason: reason ?? "" })) {
          conns.delete(rid);
          c.onclose(1006, "relay channel died");
          return;
        }
        /* Native parity: the close event fires when the handshake
           completes (the echoed zl:wsClose carries the code). A dead
           channel never echoes, so the fallback bounds the wait. */
        c.closeTimer = setTimeout(() => {
          if (conns.get(rid) !== c) return;
          conns.delete(rid);
          c.onclose(code, reason ?? "");
        }, CLOSE_FALLBACK_MS);
      },
    };
  },
};
