/* WebSocket bridge (1.3 Carbide). Pages cannot reach a proxied
   ws(s):// server directly: the SW owns the transport. The bootstrap
   shim posts zl:wsOpen with a dedicated port; this bridge opens the
   connection through the injectable factory (the vendored libcurl
   transport: TLS terminates there, a raw wisp TCP stream runs
   underneath), relays events both ways, keeps per-connection
   accounting through hooks and drops every connection from the
   registry at close or teardown. ws:// is upgraded to wss:// before
   the factory sees it, so plaintext WebSocket never leaves the
   transport. */

export interface WsHandle {
  send(data: unknown): void;
  close(code: number, reason?: string): void;
}

export interface WsFactory {
  open(
    url: string,
    protocols: string[],
    h: {
      onopen(protocol: string): void;
      onmessage(data: unknown): void;
      onclose(code: number, reason: string): void;
      onerror(error: string): void;
    },
  ): WsHandle;
}

export interface WsHooks {
  /** Connection attempt started (factory accepted). Returns a token. */
  attempt(url: string, upgraded: boolean): unknown;
  /** Handshake done, connection usable. */
  onReady(token: unknown, protocol: string, ms: number): void;
  /** rx/tx byte accounting (one direction per call). */
  onBytes(token: unknown, rx: number, tx: number): void;
  /** Connection ended; clean marks a normal close handshake. */
  onClose(token: unknown, code: number, clean: boolean, ms: number): void;
  /** Tracing seam (no-op unless tracing is on). */
  trace(d: {
    subsystem: string;
    rule?: string;
    original: string;
    result: string;
    resource?: string;
  }): void;
}

/** Minimal port shape the bridge needs (MessagePort satisfies it). */
export interface PortLike {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

const ENC = new TextEncoder();

function byteSize(d: unknown): number {
  if (typeof d === "string") return ENC.encode(d).length;
  if (d instanceof Blob) return d.size;
  if (d instanceof ArrayBuffer) return d.byteLength;
  if (ArrayBuffer.isView(d)) return (d as ArrayBufferView).byteLength;
  return 0;
}

interface Conn {
  handle: WsHandle;
  token: unknown;
  url: string;
  ready: boolean;
  t0: number;
}

export class WsBridge {
  private conns = new Map<PortLike, Conn>();

  constructor(private factory: WsFactory, private hooks: WsHooks) {}

  get size(): number {
    return this.conns.size;
  }

  open(port: PortLike, url: string, protocols: string[]): void {
    const upgraded = url.startsWith("ws://");
    const target = upgraded ? "wss://" + url.slice("ws://".length) : url;
    if (upgraded) {
      this.hooks.trace({
        subsystem: "websocket",
        rule: "upgrade",
        original: url,
        result: target,
        resource: "websocket",
      });
    }
    const token = this.hooks.attempt(url, upgraded);
    const conn: Conn = {
      handle: null as unknown as WsHandle,
      token,
      url: target,
      ready: false,
      t0: Date.now(),
    };
    this.conns.set(port, conn);
    port.onmessage = (ev) => {
      const m = ev.data as { op?: string; data?: unknown; code?: number; reason?: string };
      const c = this.conns.get(port);
      if (!c) return;
      if (m?.op === "send" && c.ready) {
        this.hooks.onBytes(c.token, 0, byteSize(m.data));
        this.hooks.trace({ subsystem: "websocket", original: "tx", result: c.url, resource: "websocket" });
        c.handle.send(m.data);
      } else if (m?.op === "close") {
        try {
          c.handle.close(m.code ?? 1000, m.reason ?? "");
        } catch {
          this.end(port, 1006, false, "send failed");
        }
      }
    };
    try {
      conn.handle = this.factory.open(target, protocols, {
        onopen: (protocol) => {
          if (this.conns.get(port) !== conn) return;
          conn.ready = true;
          this.hooks.onReady(conn.token, protocol, Date.now() - conn.t0);
          this.hooks.trace({ subsystem: "websocket", original: target, result: "open", resource: "websocket" });
          port.postMessage({ ev: "open", protocol });
        },
        onmessage: (data) => {
          if (this.conns.get(port) !== conn) return;
          this.hooks.onBytes(conn.token, byteSize(data), 0);
          this.hooks.trace({ subsystem: "websocket", original: "rx", result: conn.url, resource: "websocket" });
          port.postMessage({ ev: "message", data });
        },
        onclose: (code, reason) => this.end(port, code, true, reason),
        onerror: (err) => {
          if (this.conns.get(port) !== conn) return;
          port.postMessage({ ev: "error", error: String(err) });
          this.hooks.trace({ subsystem: "websocket", original: target, result: "error", resource: "websocket" });
          /* An error before the handshake completed means the
             connection is dead: end it now instead of waiting for a
             close that may never come. */
          if (!conn.ready) this.end(port, 1006, false, String(err));
        },
      });
    } catch (err) {
      this.conns.delete(port);
      port.onmessage = null;
      this.hooks.onClose(token, 1006, false, 0);
      port.postMessage({ ev: "error", error: String(err) });
      port.postMessage({ ev: "close", code: 1006, clean: false });
      port.close();
    }
  }

  /** Teardown: close and forget every live connection. */
  closeAll(): void {
    for (const [port, conn] of [...this.conns]) {
      try {
        conn.handle.close(1000, "teardown");
      } catch {
        /* already gone */
      }
      this.end(port, 1000, true, "teardown");
    }
  }

  private end(port: PortLike, code: number, clean: boolean, reason?: string): void {
    const conn = this.conns.get(port);
    if (!conn) return;
    this.conns.delete(port);
    port.onmessage = null;
    this.hooks.onClose(conn.token, code, clean, Date.now() - conn.t0);
    if (!clean) {
      this.hooks.trace({
        subsystem: "websocket",
        original: conn.url,
        result: "abnormal close " + code + (reason ? ": " + reason : ""),
        resource: "websocket",
      });
    }
    port.postMessage({ ev: "close", code, clean, reason });
    port.close();
  }
}
