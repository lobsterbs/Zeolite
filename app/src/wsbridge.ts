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
  /* Keepalive seam (#61), optional: send one WS ping frame. Absent
     means the transport cannot emit WS control frames and the bridge
     watchdog stays off (honest degradation, not a silent
     approximation). Returns false when the send failed. */
  ping?(): boolean;
  /* Keepalive seam (#61), optional: epoch ms of the last received
     pong. The watchdog treats a ping as answered only when this
     advances between ticks. */
  lastPongAt?(): number;
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
    /** Handshake request headers (per-origin virtual WS identity,
        deep-integration item 4; empty = transport default, the
        pre-item-4 single bridge identity). */
    headers?: Array<[string, string]>,
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
  /** Sends that arrived before the handshake completed. WebSocket
      semantics: send() while CONNECTING buffers, so pages that write
      immediately after new WebSocket() do not lose data while the
      transport initializes or the handshake runs. */
  pending: unknown[];
  /* Keepalive watchdog state (#61): interval handle, consecutive
     unanswered pings, pong timestamp seen at the previous tick. */
  ka?: ReturnType<typeof setInterval>;
  missed: number;
  lastPong: number;
}

export interface WsBridgeOptions {
  /** Watchdog ping interval in ms; 0 disables the watchdog. */
  keepaliveIntervalMs?: number;
  /** Consecutive unanswered pings before an abnormal close. */
  keepaliveMisses?: number;
}

export class WsBridge {
  private conns = new Map<PortLike, Conn>();
  private kaInterval: number;
  private kaMisses: number;

  constructor(
    private factory: WsFactory,
    private hooks: WsHooks,
    opts?: WsBridgeOptions,
  ) {
    this.kaInterval = opts?.keepaliveIntervalMs ?? 30_000;
    this.kaMisses = opts?.keepaliveMisses ?? 2;
  }

  get size(): number {
    return this.conns.size;
  }

  open(port: PortLike, url: string, protocols: string[], headers?: Array<[string, string]>): void {
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
      pending: [],
      missed: 0,
      lastPong: 0,
    };
    this.conns.set(port, conn);
    port.onmessage = (ev) => {
      const m = ev.data as { op?: string; data?: unknown; code?: number; reason?: string };
      const c = this.conns.get(port);
      if (!c) return;
      if (m?.op === "send") {
        if (c.ready) {
          this.hooks.onBytes(c.token, 0, byteSize(m.data));
          this.hooks.trace({ subsystem: "websocket", original: "tx", result: c.url, resource: "websocket" });
          c.handle.send(m.data);
        } else {
          c.pending.push(m.data);
        }
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
          /* #61 keepalive watchdog: only when the transport can both
             send WS pings and observe pongs. A transport without the
             seam (the vendored libcurl bundle today) never starts a
             timer, so quiet server-push sockets stay open. */
          if (
            this.kaInterval > 0 &&
            typeof conn.handle.ping === "function" &&
            typeof conn.handle.lastPongAt === "function"
          ) {
            conn.lastPong = conn.handle.lastPongAt();
            conn.ka = setInterval(() => {
              if (this.conns.get(port) !== conn) return;
              const ponged = conn.handle.lastPongAt!();
              if (ponged > conn.lastPong) conn.missed = 0;
              else conn.missed++;
              conn.lastPong = ponged;
              if (conn.missed >= this.kaMisses) {
                this.end(port, 1006, false, "keepalive timeout");
                return;
              }
              if (!conn.handle.ping!()) this.end(port, 1006, false, "keepalive send failed");
            }, this.kaInterval);
          }
          /* Flush everything buffered during the handshake, after the
             open event so page onopen handlers run first (native
             order). */
          for (const d of conn.pending.splice(0)) {
            this.hooks.onBytes(conn.token, 0, byteSize(d));
            this.hooks.trace({ subsystem: "websocket", original: "tx", result: conn.url, resource: "websocket" });
            conn.handle.send(d);
          }
        },
        onmessage: (data) => {
          if (this.conns.get(port) !== conn) return;
          conn.missed = 0; /* any rx proves liveness (#61) */
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
      }, headers ?? []);
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
    if (conn.ka !== undefined) clearInterval(conn.ka);
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
