/* Wisp v2.1 client for the service worker and the runtime bootstrap.
   Framing is done by zeolite-wisp (wasm over wisp-core), never
   hand-rolled here. One WebSocket connection multiplexes all streams.

   Wire layout (wisp-core): frame = [type u8][stream_id u32 LE][payload].
   The wasm-bindgen ES module (src/wisp_wasm/wisp_wasm.js) exposes:
   handshake_info, connectTcp, dataPacket, continuePacket, closePacket,
   parseFrame.

   Phase 2: keepalive heartbeat + automatic reconnect. Bug-scout note:
   stream-0 CONTINUE is NOT a legal heartbeat against our wisp-core
   server: after the v2 handshake completes, ServerHandshake::handle()
   re-matches it and silently flips the negotiated version to V1. The
   heartbeat therefore uses a short-lived dummy stream: a CONNECT to a
   loopback port followed by an immediate CLOSE. The traffic itself
   keeps intermediaries from reclaiming the socket. */

interface WispWasm {
  handshake_info(): Uint8Array;
  connectTcp(id: number, port: number, host: string): Uint8Array;
  dataPacket(id: number, bytes: Uint8Array): Uint8Array;
  continuePacket(id: number, remaining: number): Uint8Array;
  closePacket(id: number, reason: number): Uint8Array;
  parseFrame(msg: Uint8Array): JsFrame | undefined;
}
interface JsFrame {
  packetType: number;
  streamId: number;
  payload: Uint8Array;
  isData(): boolean;
  isContinue(): boolean;
  isClose(): boolean;
  closeReason: number;
  bufferRemaining: number;
}

let mod: WispWasm | null = null;
/** Load the wisp-wasm module (lazy: SW startup stays cheap). */
export async function wispApi(): Promise<WispWasm> {
  if (!mod) {
    const imported = await import("./wisp_wasm/wisp_wasm.js");
    mod = imported as unknown as WispWasm;
  }
  return mod;
}

interface Stream {
  onData: (chunk: Uint8Array) => void;
  onClose?: (reason: number) => void;
}

/** Heartbeat interval. */
const KEEPALIVE_MS = 15_000;
/** Dummy heartbeat destination: loopback, almost certainly refused, so
    the server answers with a CLOSE immediately after the CONNECT. */
const HB_HOST = "127.0.0.1";
const HB_PORT = 9;

export class WispClient {
  private ws: WebSocket | null = null;
  private streams = new Map<number, Stream>();
  private nextId = 1;
  private connecting: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private wispUrl: string) {}

  /** Open (or reuse) the multiplexed WebSocket, run the v2 handshake. */
  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wispUrl, "wisp");
      ws.binaryType = "arraybuffer";
      ws.onerror = () => {
        this.ws = null;
        reject(new Error("wisp websocket failed"));
      };
      ws.onclose = () => {
        this.ws = null;
        this.stopHeartbeat();
        const streams = [...this.streams.values()];
        this.streams.clear();
        for (const s of streams) s.onClose?.(1);
        this.connecting = null;
        // Bug-scout fix: a server-side close during the handshake used
        // to leave the pending connect() promise unsettled forever
        // (onerror does not always fire before onclose). Rejecting here
        // is a no-op once the promise already resolved.
        reject(new Error("wisp websocket closed"));
        // Reconnect happens lazily on the next openStream/write.
      };
      ws.onmessage = (ev) => void this.onMessage(ev);
      this.ws = ws;
      ws.onopen = async () => {
        try {
          const m = await wispApi();
          ws.send(m.handshake_info());
          this.startHeartbeat();
          resolve();
        } catch (e) {
          reject(e);
        }
      };
    });
    return this.connecting;
  }

  /** Keepalive: open-and-close a dummy stream at a fixed cadence. The
      CONNECT/CLOSE exchange is ordinary wisp traffic on a nonzero
      stream id, so it never re-enters the handshake state machine. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      void (async () => {
        if (!this.ws || this.ws.readyState > WebSocket.OPEN) return;
        try {
          await this.connect();
          const m = await wispApi();
          const id = this.nextId++;
          // No handlers registered: the server's CLOSE is ignored.
          this.ws!.send(m.connectTcp(id, HB_PORT, HB_HOST));
          this.ws!.send(m.closePacket(id, 0x01));
        } catch {
          this.stopHeartbeat();
        }
      })();
    }, KEEPALIVE_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private async onMessage(ev: MessageEvent) {
    const m = await wispApi();
    const frame = m.parseFrame(new Uint8Array(ev.data as ArrayBuffer));
    if (!frame) return;
    if (frame.streamId === 0) return; // connection-level: already settled
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    if (frame.isData()) {
      stream.onData(frame.payload);
      // Grant more receive window so the server keeps flowing.
      this.ws?.send(m.continuePacket(frame.streamId, 128));
    } else if (frame.isClose()) {
      this.streams.delete(frame.streamId);
      stream.onClose?.(frame.closeReason);
    }
    // CONTINUE from the server concerns its send window; we always
    // write opportunistically and the wisp server never overruns us.
  }

  /** Open a TCP stream; resolves to its stream id. */
  async openStream(
    port: number,
    hostname: string,
    handlers: Stream,
  ): Promise<number> {
    await this.connect();
    const id = this.nextId++;
    this.streams.set(id, handlers);
    const m = await wispApi();
    this.ws!.send(m.connectTcp(id, port, hostname));
    return id;
  }

  async write(id: number, bytes: Uint8Array): Promise<void> {
    await this.connect();
    const m = await wispApi();
    this.ws!.send(m.dataPacket(id, bytes));
  }

  async close(id: number, reason = 0x02): Promise<void> {
    const m = await wispApi();
    this.ws?.send(m.closePacket(id, reason));
    this.streams.delete(id);
  }

  /** End the whole connection (teardown). */
  dispose(): void {
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.streams.clear();
  }
}
