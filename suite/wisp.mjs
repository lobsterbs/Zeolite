/* Minimal Wisp v2.1 client for the compat suite (2.5 Iodide).

   The suite must drive the REAL engine surface. zeolite-server is a
   wisp relay: exactly /wisp/ (WebSocket) plus a static fallback, and
   no HTTP proxy route has ever existed on it - all rewriting happens
   client-side in the service worker. The 1.9 suite pretended
   otherwise (/j/<b64url> fetches) and, because the compat job had
   never once executed, the first run (36472949276) proved every probe
   404'd. This module speaks the actual protocol as defined in
   crates/wisp-core (frame.rs / packet.rs / handshake.rs): v2 INFO
   handshake over the "wisp" subprotocol, then CONNECT / DATA /
   CONTINUE / CLOSE frames, one frame per WebSocket message, headers
   little-endian.

   Scope: only the frame types the probes need. The transport stack
   (credit windows, UDP, extensions) stays in wisp-core where it
   belongs; this is probe tooling, never a second engine. */

import { Buffer } from "node:buffer";

const T = { CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04, INFO: 0x05 };

/* Close reasons from wisp-core packet.rs that the probes assert on. */
export const CLOSE = {
  VOLUNTARY: 0x02,
  UNREACHABLE_HOST: 0x42,
  CONNECT_REFUSED: 0x44,
  BLOCKED: 0x48,
  AUTH_REQUIRED: 0xc2,
};

export const reasonName = (r) =>
  Object.entries(CLOSE).find(([, v]) => v === r)?.[0] ?? "0x" + (r ?? 0).toString(16);

const frame = (type, streamId, payload = new Uint8Array(0)) => {
  const b = new Uint8Array(5 + payload.length);
  b[0] = type;
  new DataView(b.buffer).setUint32(1, streamId, true);
  b.set(payload, 5);
  return b;
};

/* Open a wisp v2.1 session. Resolves once the server confirms the
   handshake with CONTINUE(0); rejects when the server CLOSEs the
   connection instead (e.g. reason 0xc2 when auth is required and the
   client offers none). */
export function wispSession(base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws").replace(/\/$/, "") + "/wisp/", "wisp");
    ws.binaryType = "arraybuffer";
    const streams = new Map();
    let nextStream = 1;
    // Guards the handshake: a socket that dies before CONTINUE(0) (server
    // not listening yet, refused, or no /wisp/ route) must reject instead
    // of leaving the promise pending forever.
    let settled = false;
    const handshakeTimer = setTimeout(() => {
      finishHandshake(new Error("wisp handshake timed out (no CONTINUE(0) within 5s)"));
      try {
        ws.close();
      } catch {}
    }, 5000);
    const finishHandshake = (err, sessionOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      err ? reject(err) : resolve(sessionOut);
    };
    const session = {
      openTcp(host, port) {
        const sid = nextStream++;
        const stream = {
          id: sid,
          onData: null,
          onClose: null,
          closeReason: null,
          closed: false,
          _recv(c) {
            if (!stream.closed) stream.onData && stream.onData(c);
          },
          _close(r) {
            if (stream.closed) return;
            stream.closed = true;
            stream.closeReason = r;
            stream.onClose && stream.onClose(r);
          },
          send(b) {
            if (!stream.closed && ws.readyState === 1) ws.send(frame(T.DATA, sid, b));
          },
          close() {
            if (!stream.closed && ws.readyState === 1) {
              ws.send(frame(T.CLOSE, sid, new Uint8Array([CLOSE.VOLUNTARY])));
            }
            stream._close(CLOSE.VOLUNTARY);
          },
        };
        streams.set(sid, stream);
        const h = Buffer.from(host, "utf8");
        if (h.length > 255) throw new Error("hostname too long for wisp CONNECT");
        const p = new Uint8Array(4 + h.length);
        p[0] = 0x01; // stream kind: TCP
        new DataView(p.buffer).setUint16(1, port, true);
        p[3] = h.length;
        p.set(h, 4);
        ws.send(frame(T.CONNECT, sid, p));
        // v2 flow control: the server's relay reader spends one credit
        // per DATA packet it sends downstream, starting from zero. With
        // no initial CONTINUE grant the relay deadlocks: the server
        // waits for a grant while the client waits for data. Announce
        // the client receive window up front.
        ws.send(frame(T.CONTINUE, sid, new Uint8Array([128, 0, 0, 0])));
        return stream;
      },
      close() {
        try {
          ws.close();
        } catch {}
      },
    };
    ws.addEventListener("message", (ev) => {
      const b = new Uint8Array(ev.data);
      const type = b[0];
      const id = new DataView(b.buffer).getUint32(1, true);
      const payload = b.slice(5);
      if (type === T.INFO) {
        // Server INFO(0, 2.1, extensions). Reply with a bare v2.1 INFO.
        ws.send(frame(T.INFO, 0, new Uint8Array([2, 1])));
      } else if (type === T.CONTINUE) {
        if (id === 0) finishHandshake(null, session);
        // Per-stream grants from the server are the client's send
        // window; probes send one small request per stream, so the
        // initial grant is never exhausted. Nothing else to do.
      } else if (type === T.DATA) {
        // One credit is spent per relayed DATA packet; top the window
        // back up per packet received so the server keeps reading
        // upstream (the grant is an absolute window, not a delta).
        ws.send(frame(T.CONTINUE, id, new Uint8Array([16, 0, 0, 0])));
        streams.get(id)?._recv(payload);
      } else if (type === T.CLOSE) {
        const reason = payload.length ? payload[0] : 0x01;
        if (id === 0) {
          finishHandshake(new Error("wisp connection refused: " + reasonName(reason)));
        } else {
          streams.get(id)?._close(reason);
        }
      }
    });
    ws.addEventListener("close", () => {
      // Session death closes every open stream (pending streamRequests
      // resolve with whatever they collected; closeReason 0 = abnormal),
      // and an unestablished session rejects instead of hanging.
      finishHandshake(new Error("wisp session closed before the handshake completed (server not listening, refused, or no /wisp/ route)"));
      for (const s of streams.values()) s._close(0);
    });
    ws.addEventListener("error", () => {
      // Undici can deliver only an "error" event for a refused
      // connection (no "close" follows); settle the handshake here too.
      finishHandshake(new Error("wisp session error before the handshake completed (server not listening or refused)"));
    });
  });
}

/* Send one raw request on a fresh stream and collect relayed bytes
   until the upstream closes the stream (send Connection: close) or
   the session dies. Resolves with { bytes, closeReason } - including
   the SSRF/auth close reasons so callers can assert on them.
   opts.first fires with the first relayed byte (TTFB measurement). */
export function streamRequest(session, host, port, request, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  return new Promise((resolve, reject) => {
    let stream = null;
    const chunks = [];
    const timer = setTimeout(() => {
      try {
        stream && stream.close();
      } catch {}
      reject(new Error("stream request timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    stream = session.openTcp(host, port);
    stream.onData = (c) => {
      chunks.push(c);
      opts.first && opts.first();
    };
    stream.onClose = (reason) => {
      clearTimeout(timer);
      resolve({ bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))), closeReason: reason });
    };
    stream.send(typeof request === "string" ? new TextEncoder().encode(request) : request);
  });
}

/* Status code from the first line of a raw HTTP response, or null. */
export const statusLine = (resp) => {
  const nl = resp.bytes.indexOf(10);
  const head = resp.bytes.subarray(0, nl < 0 ? resp.bytes.length : nl).toString("latin1").trim();
  const m = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/);
  return m ? parseInt(m[1], 10) : null;
};

/* Body bytes after the empty line of a raw HTTP response. */
export const bodyOf = (resp) => {
  const i = resp.bytes.indexOf(Buffer.from("\r\n\r\n", "latin1"));
  return i < 0 ? Buffer.alloc(0) : resp.bytes.subarray(i + 4);
};
