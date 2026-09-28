import { describe, expect, it } from "vitest";
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
} {
  const handlers: FakeHandlers[] = [];
  const sent: unknown[] = [];
  const closed: number[] = [];
  const factory: WsFactory = {
    open: (url, protocols, h) => {
      handlers.push({ url, protocols, h });
      return {
        send: (d: unknown) => sent.push(d),
        close: (code: number) => closed.push(code),
      };
    },
  };
  return { factory, handlers, sent, closed };
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
