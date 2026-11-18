import { describe, expect, it, vi } from "vitest";

import { DIAG } from "../diag";

import { relayRegister } from "../relayfetch";

import { relayWsFactory } from "../ws-relay";

import { WsBridge, type PortLike, type WsFactory, type WsHooks } from "../wsbridge";

/* #664: the ws bridge and the relay factory used to emit no DIAG events
   of their own, so a black-screen capture had no ws lifecycle rows to
   triage. These tests pin the bounded stage events: WS_OPEN (info),
   WS_CLOSE (info when clean, error when abnormal - a normal close is
   never a failure) and WS_ERROR (error), at most one per stage per
   connection, on top of the 512-event ring bound. */

function fakePort(): PortLike & { posted: unknown[]; closed: boolean; deliver(m: unknown): void } {
  const p: PortLike & { posted: unknown[]; closed: boolean; deliver(m: unknown): void } = {
    posted: [],
    closed: false,
    onmessage: null,
    postMessage(d: unknown) {
      p.posted.push(d);
    },
    close() {
      p.closed = true;
    },
    deliver(m: unknown) {
      p.onmessage?.({ data: m });
    },
  };
  return p;
}

function fakeHooks(): WsHooks {
  return {
    attempt: () => ({}),
    onReady: () => {},
    onBytes: () => {},
    onClose: () => {},
    trace: () => {},
  };
}

interface FakeHandlers {
  h: {
    onopen(protocol: string): void;
    onmessage(data: unknown): void;
    onclose(code: number, reason: string, clean?: boolean): void;
    onerror(error: string): void;
  };
}

function fakeFactory(): { factory: WsFactory; handlers: FakeHandlers[] } {
  const handlers: FakeHandlers[] = [];
  const factory: WsFactory = {
    open: (_url, _protocols, h) => {
      handlers.push({ h });
      return { send: () => {}, close: () => {} };
    },
  };
  return { factory, handlers };
}

/** DIAG events added after the cursor. */
function since(cursor: number) {
  return DIAG.snapshot(cursor).events;
}

function wsEvents(cursor: number) {
  return since(cursor).filter((e) => e.category === "WEBSOCKET");
}

describe("ws bridge DIAG stage events (#664)", () => {
  it("a successful open emits one info WS_OPEN event with url and trace", () => {
    const start = DIAG.snapshot(0).lastSeq;
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, fakeHooks(), { openTimeoutMs: 0 });
    b.open(fakePort(), "wss://game.example/socket", ["colyseus"]);
    handlers[0]!.h.onopen("colyseus");
    const evs = wsEvents(start);
    const opens = evs.filter((e) => e.stage === "WS_OPEN");
    expect(opens.length).toBe(1);
    expect(opens[0]!.severity).toBe("info");
    expect(opens[0]!.url).toBe("wss://game.example/socket");
    expect(opens[0]!.traceId).toBeTruthy();
    /* a second open event never fires for the same connection */
    expect(evs.filter((e) => e.stage === "WS_OPEN").length).toBe(1);
  });

  it("an error before open emits WS_ERROR (error) plus an abnormal WS_CLOSE", () => {
    const start = DIAG.snapshot(0).lastSeq;
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, fakeHooks(), { openTimeoutMs: 0 });
    const p = fakePort();
    b.open(p, "wss://hang.example/", []);
    handlers[0]!.h.onerror("tls verify failed");
    const evs = wsEvents(start);
    const errs = evs.filter((e) => e.stage === "WS_ERROR");
    expect(errs.length).toBe(1);
    expect(errs[0]!.severity).toBe("error");
    expect(errs[0]!.cause).toBe("failure");
    expect(errs[0]!.technicalReason).toContain("tls verify failed");
    const closes = evs.filter((e) => e.stage === "WS_CLOSE");
    expect(closes.length).toBe(1);
    expect(closes[0]!.severity).toBe("error");
    expect(closes[0]!.technicalReason).toContain("1006");
    expect(p.posted).toContainEqual({ ev: "error", error: "tls verify failed" });
    expect(p.posted).toContainEqual({ ev: "close", code: 1006, clean: false, reason: "tls verify failed" });
  });

  it("repeated errors on one connection emit a single bounded WS_ERROR", () => {
    const start = DIAG.snapshot(0).lastSeq;
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, fakeHooks(), { openTimeoutMs: 0 });
    b.open(fakePort(), "wss://flaky.example/", []);
    handlers[0]!.h.onopen("");
    handlers[0]!.h.onerror("first");
    handlers[0]!.h.onerror("second");
    expect(wsEvents(start).filter((e) => e.stage === "WS_ERROR").length).toBe(1);
  });

  it("a clean close after open emits an info WS_CLOSE, never a failure", () => {
    const start = DIAG.snapshot(0).lastSeq;
    const { factory, handlers } = fakeFactory();
    const b = new WsBridge(factory, fakeHooks(), { openTimeoutMs: 0 });
    b.open(fakePort(), "wss://ok.example/", []);
    handlers[0]!.h.onopen("");
    handlers[0]!.h.onclose(1000, "done", true);
    const evs = wsEvents(start);
    const closes = evs.filter((e) => e.stage === "WS_CLOSE");
    expect(closes.length).toBe(1);
    expect(closes[0]!.severity).toBe("info");
    expect(evs.filter((e) => e.severity === "error").length).toBe(0);
  });

  it("a synchronous factory throw emits an abnormal WS_CLOSE with the reason", () => {
    const start = DIAG.snapshot(0).lastSeq;
    const factory: WsFactory = {
      open: () => {
        throw new Error("relay channel unavailable");
      },
    };
    const b = new WsBridge(factory, fakeHooks(), { openTimeoutMs: 0 });
    const p = fakePort();
    b.open(p, "wss://dead.example/", []);
    const evs = wsEvents(start);
    const closes = evs.filter((e) => e.stage === "WS_CLOSE");
    expect(closes.length).toBe(1);
    expect(closes[0]!.severity).toBe("error");
    expect(closes[0]!.technicalReason).toContain("relay channel unavailable");
    expect(p.posted).toContainEqual({ ev: "close", code: 1006, clean: false });
  });
});

describe("relay ws factory DIAG events (#664, #511)", () => {
  function relayHandlers() {
    return {
      onopen: vi.fn<(p: string) => void>(),
      onmessage: vi.fn<(d: unknown) => void>(),
      onclose: vi.fn<(c: number, r: string, clean?: boolean) => void>(),
      onerror: vi.fn<(e: string) => void>(),
    };
  }

  it("a zl:wsError frame emits a relay failure event carrying the relay reason", () => {
    const port = fakePort();
    relayRegister(port as unknown as MessagePort);
    const start = DIAG.snapshot(0).lastSeq;
    const h = relayHandlers();
    relayWsFactory.open("wss://game.example/socket", [], h);
    const rid = (port.posted[0] as { rid: number }).rid;
    port.deliver({ type: "zl:wsError", rid, error: "upstream refused" });
    expect(h.onerror).toHaveBeenCalledWith("upstream refused");
    const evs = wsEvents(start).filter((e) => e.stage === "WS_ERROR");
    expect(evs.length).toBe(1);
    expect(evs[0]!.severity).toBe("error");
    expect(evs[0]!.cause).toBe("failure");
    expect(evs[0]!.technicalReason).toContain("upstream refused");
    expect(evs[0]!.url).toBe("wss://game.example/socket");
  });

  it("an unavailable relay channel at open emits a failure event and still throws", () => {
    const port = fakePort();
    port.postMessage = () => {
      throw new Error("dead channel");
    };
    relayRegister(port as unknown as MessagePort);
    const start = DIAG.snapshot(0).lastSeq;
    expect(() => relayWsFactory.open("wss://x.example/", [], relayHandlers())).toThrow(
      "relay channel unavailable",
    );
    const evs = wsEvents(start);
    expect(evs.length).toBe(1);
    expect(evs[0]!.stage).toBe("WS_ERROR");
    expect(evs[0]!.severity).toBe("error");
    expect(evs[0]!.message).toContain("relay");
    expect(evs[0]!.url).toBe("wss://x.example/");
  });

  it("the re-registration sweep emits one failure event per torn-down socket", () => {
    const portA = fakePort();
    relayRegister(portA as unknown as MessagePort);
    const h = relayHandlers();
    relayWsFactory.open("wss://old-era.example/", [], h);
    const start = DIAG.snapshot(0).lastSeq;
    relayRegister(fakePort() as unknown as MessagePort);
    expect(h.onerror).toHaveBeenCalledWith("relay re-registered");
    const evs = wsEvents(start);
    expect(evs.length).toBe(1);
    expect(evs[0]!.severity).toBe("error");
    expect(evs[0]!.url).toBe("wss://old-era.example/");
  });
});
