import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendPasswordAuth,
  clearWispAuth,
  clientInfoWithAuth,
  closeAuthOutcome,
  configureWispAuth,
  installWispAuthSocket,
  passwordAuthPayload,
  upgradeConnectFrame,
  wispAuthStatus,
  WISP_GRANT_PACKETS,
} from "../wisp-auth";
import { PAGE_MESSAGES } from "../cpgate";
import { CORE_CONTROL_TYPES } from "../control";

const enc = new TextEncoder();

function infoFrame(exts: Array<[number, Uint8Array]>): Uint8Array {
  const total = 7 + exts.reduce((n, [, m]) => n + 5 + m.length, 0);
  const out = new Uint8Array(total);
  out[0] = 0x05;
  out[5] = 2;
  out[6] = 1;
  const dv = new DataView(out.buffer);
  let w = 7;
  for (const [id, m] of exts) {
    out[w] = id;
    dv.setUint32(w + 1, m.length, true);
    out.set(m, w + 5);
    w += 5 + m.length;
  }
  return out;
}

function continueFrame(stream = 0): Uint8Array {
  const out = new Uint8Array([0x03, 0, 0, 0, 0, 128, 0, 0, 0]);
  const dv = new DataView(out.buffer);
  dv.setUint32(1, stream, true);
  return out;
}

function closeFrame(reason: number): Uint8Array {
  return new Uint8Array([0x04, 0, 0, 0, 0, reason]);
}

function v1Connect(stream = 1): Uint8Array {
  /* [type 1][stream u32 LE][stream_type u8][port u16 BE][host] */
  const host = enc.encode("127.0.0.1");
  const out = new Uint8Array(5 + 1 + 2 + host.length);
  out[0] = 0x01;
  const dv = new DataView(out.buffer);
  dv.setUint32(1, stream, true);
  out[5] = 1;
  dv.setUint16(6, 7101);
  out.set(host, 8);
  return out;
}

describe("wisp password auth (#496)", () => {
  beforeEach(() => clearWispAuth());

  it("builds the canonical PasswordAuth payload [user_len][user][password]", () => {
    expect(Array.from(passwordAuthPayload("ada", "hunter2")!)).toEqual([
      3, ...Array.from(enc.encode("ada")), ...Array.from(enc.encode("hunter2")),
    ]);
    expect(passwordAuthPayload("", "pw")).toBeNull();
    expect(passwordAuthPayload("x".repeat(256), "pw")).toBeNull();
  });

  it("builds a complete client INFO carrying the PasswordAuth extension", () => {
    const frame = clientInfoWithAuth("ada", "pw")!;
    expect(frame.length).toBe(12 + 6);
    expect(Array.from(frame.slice(0, 7))).toEqual([0x05, 0, 0, 0, 0, 2, 1]);
    expect(frame[7]).toBe(0x02);
    expect(Array.from(frame.slice(12))).toEqual([3, ...enc.encode("ada"), ...enc.encode("pw")]);
    expect(clientInfoWithAuth("", "pw")).toBeNull();
  });

  it("appends the PasswordAuth extension to a v2 client INFO byte-exactly", () => {
    const frame = appendPasswordAuth(infoFrame([]), "ada", "pw")!;
    expect(Array.from(frame)).toEqual([
      0x05, 0, 0, 0, 0, 2, 1,
      0x02, 6, 0, 0, 0, 3,
      ...Array.from(enc.encode("ada")),
      ...Array.from(enc.encode("pw")),
    ]);
  });

  it("preserves the vendor's own extensions and appends after them", () => {
    const frame = appendPasswordAuth(infoFrame([[0x04, new Uint8Array([9, 9])]]), "u", "p")!;
    expect(Array.from(frame.slice(7, 14))).toEqual([0x04, 2, 0, 0, 0, 9, 9]);
    expect(frame[14]).toBe(0x02);
  });

  it("fails closed on non-INFO, non-zero-stream and malformed frames", () => {
    expect(appendPasswordAuth(new Uint8Array([0x01, 0, 0, 0, 0, 1, 1]), "u", "p")).toBeNull();
    expect(appendPasswordAuth(new Uint8Array([0x05, 0, 0, 0, 5, 2, 1]), "u", "p")).toBeNull();
    expect(appendPasswordAuth(new Uint8Array([0x05, 0, 0, 0, 0, 2, 1, 0x02, 9, 0, 0, 0]), "u", "p")).toBeNull();
    expect(appendPasswordAuth(new Uint8Array(5), "u", "p")).toBeNull();
  });

  it("maps server close reasons to stable redacted outcomes", () => {
    expect(closeAuthOutcome(closeFrame(0xc0))).toBe("invalid-credential");
    expect(closeAuthOutcome(closeFrame(0xc2))).toBe("auth-required");
    expect(closeAuthOutcome(closeFrame(0xc1))).toBe("auth-unsupported");
    expect(closeAuthOutcome(closeFrame(0x01))).toBeNull();
    expect(closeAuthOutcome(new Uint8Array([0x02, 0, 0, 0, 0, 0xc0]))).toBeNull();
  });

  it("configures memory-only credentials with the ws loopback / wss rule", () => {
    expect(configureWispAuth("wss://wisp.example/wisp/", "ada", "pw").ok).toBe(true);
    expect(wispAuthStatus().mode).toBe("password");
    expect(wispAuthStatus().endpoint).toBe("wss://wisp.example/wisp/");
    expect(wispAuthStatus().secure).toBe(true);
    expect(configureWispAuth("ws://wisp.example/wisp/", "ada", "pw").ok).toBe(false);
    expect(configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw").ok).toBe(true);
    expect(wispAuthStatus().secure).toBe(false);
    expect(configureWispAuth("https://wisp.example/wisp/", "ada", "pw").ok).toBe(false);
    expect(configureWispAuth("wss://wisp.example/wisp/", "", "pw").ok).toBe(false);
    clearWispAuth();
    expect(wispAuthStatus().mode).toBe("none");
    expect(wispAuthStatus().endpoint).toBeNull();
  });

  it("never exposes the secret in the status surface", () => {
    configureWispAuth("wss://wisp.example/wisp/", "ada", "hunter2");
    expect(JSON.stringify(wispAuthStatus())).not.toContain("hunter2");
  });

  it("keeps zl:wispAuth host-only and registered in the core switch", () => {
    expect(PAGE_MESSAGES.has("zl:wispAuth")).toBe(false);
    expect(CORE_CONTROL_TYPES.has("zl:wispAuth")).toBe(true);
  });
});

describe("wisp auth socket wrapper (#496)", () => {
  beforeEach(() => {
    clearWispAuth();
    vi.useRealTimers();
  });

  interface FakeSock {
    url: string;
    protocols?: string | string[];
    listeners: Array<(ev: { data: unknown }) => void>;
    send(d: unknown): void;
    dispatch(data: unknown): void;
    close(): void;
    closed?: boolean;
  }

  function fakeGlobal(): { g: { WebSocket: typeof WebSocket }; sent: unknown[] } {
    const sent: unknown[] = [];
    class FakeWs {
      url: string;
      protocols?: string | string[];
      listeners: Array<(ev: { data: unknown }) => void> = [];
      constructor(url: string | URL, protocols?: string | string[]) {
        this.url = String(url);
        this.protocols = protocols;
      }
      addEventListener(_t: string, fn: (ev: { data: unknown }) => void) {
        this.listeners.push(fn);
      }
      /* Dispatch in registration order so stopImmediatePropagation
         semantics (first listener blocks the rest) are observable. */
      dispatch(data: unknown) {
        for (const fn of this.listeners) {
          const ev = {
            data,
            stopped: false,
            stopImmediatePropagation() {
              ev.stopped = true;
            },
          };
          fn(ev);
          if (ev.stopped) break;
        }
      }
      send(d: unknown) {
        sent.push(d);
      }
      close() {
        (this as unknown as { closed?: boolean }).closed = true;
      }
    }
    const g = { WebSocket: FakeWs as unknown as typeof WebSocket };
    installWispAuthSocket(g);
    return { g, sent };
  }

  it("translates a v1 CONNECT frame into the v2 hostname layout", () => {
    const v1 = v1Connect();
    const v2 = upgradeConnectFrame(v1)!;
    expect(v2.length).toBe(v1.length + 1);
    expect(v2[0]).toBe(0x01);
    /* stream 1 stays little-endian in place */
    expect(Array.from(v2.slice(1, 5))).toEqual([1, 0, 0, 0]);
    /* kind + port unchanged, then the inserted host length */
    expect(v2[5]).toBe(1);
    expect(v2[8]).toBe(v1.length - 8);
    expect(Array.from(v2.slice(9))).toEqual(Array.from(v1.slice(8)));
    expect(upgradeConnectFrame(new Uint8Array([0x01, 0, 0, 0, 0, 1, 0xdc]))).toBeNull();
    expect(upgradeConnectFrame(new Uint8Array([0x02, 0, 0, 0, 0, 1, 0, 0]))).toBeNull();
  });

  it("v2 native: rewrites only the first outgoing INFO and passes the rest", () => {
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/?zlgen=3", ["wisp"]) as unknown as FakeSock;
    expect(sock.protocols).toEqual(["wisp"]);
    sock.send(infoFrame([]));
    sock.send(infoFrame([]));
    /* first frame: PasswordAuth appended (7 + 5 + payload 6) */
    expect((sent[0] as Uint8Array).length).toBe(18);
    expect((sent[0] as Uint8Array)[7]).toBe(0x02);
    /* second frame: untouched vendor bytes */
    expect((sent[1] as Uint8Array).length).toBe(7);
  });

  it("v2 native: an undecodable first frame fails closed, nothing goes out", () => {
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/", ["wisp"]) as unknown as FakeSock;
    sock.send(new Uint8Array([0x05, 0, 0, 0, 0, 2, 1, 0x02, 9, 0, 0, 0]));
    expect(sent.length).toBe(0);
    expect(sock.closed).toBe(true);
    expect(wispAuthStatus().lastOutcome).toBe("auth-unsupported");
  });

  it("v1 upgrade: appends the wisp subprotocol and drives the handshake", () => {
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/") as unknown as FakeSock;
    /* the vendor passed no protocols; the wrapper upgraded to v2 */
    expect(sock.protocols).toEqual(["wisp"]);
    /* the vendor's listener is registered after construction; it
       SEES the handshake frames (their v1 state machine tolerates
       them and flips connected on the first message, which is what
       unblocks its stream creation) */
    let vendorSaw = 0;
    sock.listeners.push(() => {
      vendorSaw += 1;
    });
    /* the vendor sends its v1 CONNECT; it is held, not sent */
    const connect = v1Connect();
    sock.send(connect);
    expect(sent.length).toBe(0);
    /* the server's opening INFO is answered with the credentialed
       client INFO; the vendor also sees it and flips connected */
    sock.dispatch(infoFrame([]));
    expect(vendorSaw).toBe(1);
    expect(sent.length).toBe(1);
    const info = sent[0] as Uint8Array;
    expect(info[0]).toBe(0x05);
    expect(info[7]).toBe(0x02);
    expect(info.length).toBe(12 + 6);
    /* the server's handshake CONTINUE releases the held CONNECT,
       translated into the v2 hostname layout */
    sock.dispatch(continueFrame());
    expect(sent.length).toBe(2);
    const released = sent[1] as Uint8Array;
    expect(released.length).toBe(connect.length + 1);
    expect(released[8]).toBe(connect.length - 8);
    expect(Array.from(released.slice(9))).toEqual(Array.from(connect.slice(8)));
    /* the vendor also saw the handshake CONTINUE (its stream-0
       buffer grant) */
    expect(vendorSaw).toBe(2);
    /* post-handshake: a later v1 CONNECT is translated on the fly,
       and server DATA passes through to the vendor untouched */
    const later = v1Connect(2);
    sock.send(later);
    const laterOut = sent[2] as Uint8Array;
    expect(laterOut.length).toBe(later.length + 1);
    expect(laterOut[8]).toBe(later.length - 8);
    expect(Array.from(laterOut.slice(9))).toEqual(Array.from(later.slice(8)));
    sock.dispatch(new Uint8Array([0x02, 2, 0, 0, 0, 1, 2]));
    /* INFO + handshake CONTINUE + this DATA frame */
    expect(vendorSaw).toBe(3);
  });

  it("v1 upgrade: a server auth close during the handshake maps the outcome", () => {
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/") as unknown as FakeSock;
    sock.send(v1Connect());
    sock.dispatch(closeFrame(0xc0));
    expect(wispAuthStatus().lastOutcome).toBe("invalid-credential");
    expect(sock.closed).toBe(true);
    /* the held CONNECT never went out unauthenticated */
    expect(sent.length).toBe(0);
  });

  it("v1 upgrade: a server that never speaks v2 fails closed on the deadline", () => {
    vi.useFakeTimers();
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/") as unknown as FakeSock;
    sock.send(v1Connect());
    vi.advanceTimersByTime(10001);
    expect(sock.closed).toBe(true);
    expect(sent.length).toBe(0);
    expect(wispAuthStatus().lastOutcome).toBe("auth-unsupported");
    vi.useRealTimers();
  });

  it("leaves non-credentialed-endpoint sockets untouched", () => {
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:9999/other/") as unknown as FakeSock;
    expect(sock.protocols).toBeUndefined();
    sock.send(infoFrame([]));
    expect((sent[0] as Uint8Array).length).toBe(7);
  });

  it("observes the server close reason into a redacted outcome", () => {
    const { g } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/") as unknown as FakeSock;
    sock.dispatch(closeFrame(0xc0).buffer);
    expect(wispAuthStatus().lastOutcome).toBe("invalid-credential");
  });

  it("v1 upgrade: grants the v2 server send credits on the vendor's behalf", () => {
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/") as unknown as FakeSock;
    let vendorSaw = 0;
    sock.listeners.push(() => {
      vendorSaw += 1;
    });
    sock.send(v1Connect());
    sock.dispatch(infoFrame([]));
    sock.dispatch(continueFrame());
    const grants = (): Uint8Array[] =>
      sent.filter(
        (f): f is Uint8Array =>
          f instanceof Uint8Array && f.length === 9 && f[0] === 0x03 && f[1] === 1,
      );
    /* the server's CONNECTED for stream 1 earns exactly one grant */
    sock.dispatch(continueFrame(1));
    expect(grants()).toHaveLength(1);
    expect(new DataView(grants()[0].buffer).getUint32(5, true)).toBe(WISP_GRANT_PACKETS);
    /* the vendor saw the two handshake frames and the CONNECTED */
    expect(vendorSaw).toBe(3);
    /* a stream-0 window update never earns a grant */
    sock.dispatch(continueFrame(0));
    expect(grants()).toHaveLength(1);
    /* relayed DATA counts up to the top-up at half the window */
    const data = new Uint8Array([0x02, 1, 0, 0, 0, 0x41]);
    for (let i = 0; i < WISP_GRANT_PACKETS / 2; i++) sock.dispatch(data);
    expect(grants()).toHaveLength(2);
    expect(vendorSaw).toBe(4 + WISP_GRANT_PACKETS / 2); /* INFO + handshake CONTINUE + CONNECTED + stream-0 update + every DATA */
    /* a stream CLOSE forgets the stream: the next frame earns a fresh grant */
    sock.dispatch(new Uint8Array([0x04, 1, 0, 0, 0, 0x01]));
    sock.dispatch(data);
    expect(grants()).toHaveLength(3);
  });

  it("v2 native: never grants credits, the vendor speaks full v2", () => {
    const { g, sent } = fakeGlobal();
    configureWispAuth("ws://127.0.0.1:6002/wisp/", "ada", "pw");
    const sock = new g.WebSocket("ws://127.0.0.1:6002/wisp/", ["wisp"]) as unknown as FakeSock;
    sock.send(infoFrame([]));
    sock.dispatch(continueFrame(1));
    expect(
      sent.filter((f) => f instanceof Uint8Array && (f as Uint8Array)[0] === 0x03),
    ).toHaveLength(0);
  });

  it("is idempotent per global", () => {
    const { g } = fakeGlobal();
    const first = g.WebSocket;
    installWispAuthSocket(g);
    expect(g.WebSocket).toBe(first);
  });
});
