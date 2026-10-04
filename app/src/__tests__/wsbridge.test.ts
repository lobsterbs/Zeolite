import { afterEach, describe, expect, it, vi } from "vitest";
import { WsBridge, type PortLike, type WsFactory, type WsHooks } from "../wsbridge";

interface FakeHandlers {
  url: string;
  protocols: string[];
  h: {
    onopen(protocol: string): void;
    onmessage(data: unknown): void;
    onclose(code: number, reason: string): void;
    onerror(error: string): void;
  };
}

function fakePort(): PortLike & { posted: unknown[]; closed: boolean } {
  const p: PortLike & { posted: unknown[]; closed: boolean } = {
    posted: [],
    closed: false,
    onmessage: null,
    postMessage(d: unknown) {
      p.posted.push(d);
    },
    close() {
      p.closed = true;
    },
  };
  return p;
}

function fakeHooks(): { hooks: WsHooks; rec: Record<string, unknown[]> } {
  const rec: Record<string, unknown[]> = {
    attempts: [],
    readies: [],
    bytes: [],
    closes: [],
    traces: [],
  };
  return {
    rec,
    hooks: {
      attempt: (url, upgraded) => {
        (rec.attempts as Array<{ url: string; upgraded: boolean }>).push({ url, upgraded });
        return { url, bytes: 0 };
      },
      onReady: (_t, protocol, ms) => {
        (rec.readies as Array<{ protocol: string; ms: number }>).push({ protocol, ms });
      },
      onBytes: (_t, rx, tx) => {
        (rec.bytes as Array<{ rx: number; tx: number }>).push({ rx, tx });
      },
      onClose: (_t, code, clean, ms) => {
        (rec.closes as Array<{ code: number; clean: boolean; ms: number }>).push({ code, clean, ms });
      },
      trace: (d) => {
        (rec.traces as Array<{ subsystem: string; rule?: string }>).push(d);
      },
    },
  };
}

function fakeFactory(): {
  factory: WsFactory;
  handlers: FakeHandlers[];
  sent: unknown[];
  closed: number[];
  headerSets: Array<Array<[string, string]>>;
} {
  const handlers: FakeHandlers[] = [];
  const sent: unknown[] = [];
  const closed: number[] = [];
  const headerSets: Array<Array<[string, string]>> = [];
  const factory: WsFactory = {
    open: (url, protocols, h, headers) => {
      handlers.push({ url, protocols, h });
      headerSets.push(headers ?? []);
      return {
        send: (d: unknown) => sent.push(d),
        close: (code: number) => closed.push(code),
      };
    },
  };
  return { factory, handlers, sent, closed, headerSets };
}

describe("WsBridge", () => {
  it("upgrades ws:// to wss:// and records the decision", () => {
    const { hooks, rec } = fakeHooks();
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, hooks);
    const p = fakePort();
    b.open(p, "ws://example.com/chat", ["chat"]);
    expect(handlers[0].url).toBe("wss://example.com/chat");
    expect(handlers[0].protocols).toEqual(["chat"]);
    expect(rec.attempts).toEqual([{ url: "ws://example.com/chat", upgraded: true }]);
    expect((rec.traces as Array<{ rule?: string }>).some((t) => t.rule === "upgrade")).toBe(true);
  });

  it("relays open and messages, accounts bytes both ways", () => {
    const { hooks, rec } = fakeHooks();
    const { factory, handlers, sent } = fakeFactory();
    const b = new WsBridge(factory, hooks);
    const p = fakePort();
    b.open(p, "wss://example.com/", []);
    /* send before open buffers (WebSocket CONNECTING semantics, issue #4) */
    p.onmessage?.({ data: { op: "send", data: "early" } });
    expect(sent).toEqual([]);
    handlers[0].h.onopen("chat");
    expect(p.posted).toContainEqual({ ev: "open", protocol: "chat" });
    expect(rec.readies).toHaveLength(1);
    /* the buffered frame flushed after the open event */
    expect(sent).toEqual(["early"]);
    expect(rec.bytes).toContainEqual({ rx: 0, tx: 5 });
    p.onmessage?.({ data: { op: "send", data: "hi" } });
    expect(sent).toEqual(["early", "hi"]);
    expect(rec.bytes).toContainEqual({ rx: 0, tx: 2 });
    handlers[0].h.onmessage("yo");
    expect(p.posted).toContainEqual({ ev: "message", data: "yo" });
    expect(rec.bytes).toContainEqual({ rx: 2, tx: 0 });
  });

  it("ends on server close; double close is a no-op", () => {
    const { hooks, rec } = fakeHooks();
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, hooks);
    const p = fakePort();
    b.open(p, "wss://example.com/", []);
    handlers[0].h.onopen("");
    handlers[0].h.onclose(1000, "");
    handlers[0].h.onclose(1000, "");
    expect(rec.closes).toEqual([{ code: 1000, clean: true, ms: expect.any(Number) }]);
    expect(b.size).toBe(0);
    expect(p.closed).toBe(true);
    expect(p.posted).toContainEqual({ ev: "close", code: 1000, clean: true, reason: "" });
  });

  it("a factory failure posts error + abnormal close", () => {
    const { hooks, rec } = fakeHooks();
    const factory: WsFactory = {
      open: () => {
        throw new Error("transport missing");
      },
    };
    const b = new WsBridge(factory, hooks);
    const p = fakePort();
    b.open(p, "wss://example.com/", []);
    expect(b.size).toBe(0);
    expect(rec.closes).toEqual([{ code: 1006, clean: false, ms: 0 }]);
    expect(p.posted[0]).toMatchObject({ ev: "error" });
    expect(p.posted[1]).toEqual({ ev: "close", code: 1006, clean: false });
  });

  it("an error before the handshake ends the connection abnormally", () => {
    const { hooks, rec } = fakeHooks();
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, hooks);
    const p = fakePort();
    b.open(p, "wss://example.com/", []);
    handlers[0].h.onerror("refused");
    expect(b.size).toBe(0);
    expect((rec.closes as Array<{ code: number }>)[0]).toMatchObject({ code: 1006, clean: false });
    expect(p.posted).toContainEqual({ ev: "close", code: 1006, clean: false, reason: "refused" });
  });

  it("passes the per-origin handshake identity headers through (item 4)", () => {
    const { hooks } = fakeHooks();
    const { factory, handlers, headerSets } = fakeFactory();
    const b = new WsBridge(factory, hooks);
    const p = fakePort();
    const identity: Array<[string, string]> = [
      ["origin", "https://page.example"],
      ["cookie", "sid=1"],
    ];
    b.open(p, "wss://auth.example/ws", ["chat"], identity);
    expect(handlers[0].url).toBe("wss://auth.example/ws");
    expect(headerSets[0]).toEqual(identity);
    /* Absent headers degrade to the empty set: the transport default,
       the pre-item-4 single bridge identity. */
    const p2 = fakePort();
    b.open(p2, "wss://plain.example/", []);
    expect(headerSets[1]).toEqual([]);
  });

  it("closeAll closes and forgets every live connection", () => {
    const { hooks, rec } = fakeHooks();
    const { factory, handlers, closed } = fakeFactory();
    const b = new WsBridge(factory, hooks);
    const p1 = fakePort();
    const p2 = fakePort();
    b.open(p1, "wss://a.example/", []);
    b.open(p2, "wss://b.example/", []);
    handlers[0].h.onopen("");
    handlers[1].h.onopen("");
    b.closeAll();
    expect(b.size).toBe(0);
    expect(closed).toEqual([1000, 1000]);
    expect(rec.closes).toHaveLength(2);
    expect(p1.closed).toBe(true);
    expect(p2.closed).toBe(true);
  });
});

/* #61 keepalive watchdog. Fake timers drive the ticks; the factory
   below owns a controllable ping/lastPongAt seam so the watchdog runs
   against a transport that really answers (or really stays silent). */
describe("WsBridge keepalive watchdog (#61)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function pingFactory(): {
    factory: WsFactory;
    handlers: FakeHandlers[];
    pings: { count: number };
    pong: () => void;
  } {
    const handlers: FakeHandlers[] = [];
    const pings = { count: 0 };
    let pongAt = 0;
    const factory: WsFactory = {
      open: (url, protocols, h) => {
        handlers.push({ url, protocols, h });
        return {
          send: () => undefined,
          close: () => undefined,
          ping: () => {
            pings.count++;
            return true;
          },
          lastPongAt: () => pongAt,
        };
      },
    };
    return { factory, handlers, pings, pong: () => pongAt++ };
  }

  it("closes 1006/unclean after consecutive unanswered pings", () => {
    vi.useFakeTimers();
    const { hooks, rec } = fakeHooks();
    const { factory, handlers, pings } = pingFactory();
    const b = new WsBridge(factory, hooks, { keepaliveIntervalMs: 1000, keepaliveMisses: 2 });
    const p = fakePort();
    b.open(p, "wss://example.com/", []);
    handlers[0].h.onopen("");
    vi.advanceTimersByTime(1000);
    expect(pings.count).toBe(1);
    expect(b.size).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(b.size).toBe(0);
    expect((rec.closes as Array<{ code: number; clean: boolean }>)[0]).toMatchObject({ code: 1006, clean: false });
    expect(
      (rec.traces as Array<{ result?: string }>).some((t) =>
        (t.result ?? "").includes("abnormal close 1006: keepalive timeout"),
      ),
    ).toBe(true);
    expect(p.posted).toContainEqual({ ev: "close", code: 1006, clean: false, reason: "keepalive timeout" });
    /* the watchdog timer died with the connection */
    vi.advanceTimersByTime(5000);
    expect(pings.count).toBe(1);
  });

  it("rx bytes and pongs reset the missed counter", () => {
    vi.useFakeTimers();
    const { hooks } = fakeHooks();
    const { factory, handlers, pings, pong } = pingFactory();
    const b = new WsBridge(factory, hooks, { keepaliveIntervalMs: 1000, keepaliveMisses: 2 });
    const p = fakePort();
    b.open(p, "wss://example.com/", []);
    handlers[0].h.onopen("");
    vi.advanceTimersByTime(1000); /* tick 1: missed = 1 */
    handlers[0].h.onmessage("x"); /* rx resets */
    pong(); /* the ping was answered */
    vi.advanceTimersByTime(1000); /* tick 2: answered -> 0 */
    vi.advanceTimersByTime(1000); /* tick 3: missed = 1 */
    pong();
    vi.advanceTimersByTime(1000); /* tick 4: answered -> 0 */
    expect(b.size).toBe(1);
    expect(pings.count).toBe(4);
  });

  it("never starts a watchdog without the ping/pong seam", () => {
    vi.useFakeTimers();
    const { hooks } = fakeHooks();
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, hooks, { keepaliveIntervalMs: 1000 });
    const p = fakePort();
    b.open(p, "wss://example.com/", []);
    handlers[0].h.onopen("");
    vi.advanceTimersByTime(10000);
    expect(b.size).toBe(1); /* no timer, no kills: quiet sockets stay open */
  });

  it("clears watchdog timers on closeAll", () => {
    vi.useFakeTimers();
    const { hooks } = fakeHooks();
    const { factory, handlers, pings } = pingFactory();
    const b = new WsBridge(factory, hooks, { keepaliveIntervalMs: 1000 });
    const p1 = fakePort();
    const p2 = fakePort();
    b.open(p1, "wss://a.example/", []);
    b.open(p2, "wss://b.example/", []);
    handlers[0].h.onopen("");
    handlers[1].h.onopen("");
    vi.advanceTimersByTime(1000);
    b.closeAll();
    expect(b.size).toBe(0);
    expect(pings.count).toBe(2);
    vi.advanceTimersByTime(10000);
    expect(pings.count).toBe(2); /* no dangling intervals */
  });
});
