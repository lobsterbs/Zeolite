import { describe, expect, it, vi } from "vitest";

/* #88: the WebSocket bridge wiring moved out of sw.ts to ws-runtime.ts;
   these tests pin the wiring contract: the transport factory is
   openWebSocket, opens land as 101 netlog rows, abnormal closes land
   as DIAG events + close rows. The bridge class semantics (upgrade,
   buffering, byte accounting) stay covered by wsbridge.test.ts. */

const mock = vi.hoisted(() => ({
  opens: [] as Array<{ url: string; protocols: string[]; headers: Array<[string, string]> | undefined }>,
  handlers: [] as Array<{
    onopen(protocol: string): void;
    onmessage(data: unknown): void;
    onclose(code: number, reason: string): void;
    onerror(error: string): void;
  }>,
  sends: [] as unknown[],
  closes: [] as number[],
}));

vi.mock("../transport", () => ({
  openWebSocket: (url: string, protocols: string[], h: unknown, headers?: Array<[string, string]>) => {
    mock.opens.push({ url, protocols, headers });
    mock.handlers.push(h as never);
    return {
      send: (d: unknown) => mock.sends.push(d),
      close: (code: number) => mock.closes.push(code),
    };
  },
}));

import { netLogSince } from "../netlog";
import { DIAG } from "../diag";
import { wsBridge } from "../ws-runtime";
import type { PortLike } from "../wsbridge";

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

function wsRows() {
  return netLogSince(0).filter((e) => e.rtype === "WEBSOCKET");
}

describe("ws-runtime wiring (#88)", () => {
  it("opens through openWebSocket and logs the 101 row", () => {
    const start = DIAG.snapshot(0).lastSeq;
    const p = fakePort();
    wsBridge.open(p, "wss://example.com/chat", ["chat"]);
    /* #664: the attempt row is the one new DIAG event, emitted before
       the transport settles anything. */
    const afterOpen = DIAG.snapshot(start).events;
    expect(afterOpen.length).toBe(1);
    const attempt = afterOpen[afterOpen.length - 1]!;
    expect(attempt.category).toBe("WEBSOCKET");
    expect(attempt.severity).toBe("info");
    expect(attempt.url).toBe("wss://example.com/chat");
    expect(mock.opens.length).toBeGreaterThan(0);
    expect(mock.opens[mock.opens.length - 1]!.url).toBe("wss://example.com/chat");
    expect(mock.opens[mock.opens.length - 1]!.protocols).toEqual(["chat"]);
    mock.handlers[mock.handlers.length - 1]!.onopen("chat");
    expect(p.posted).toContainEqual({ ev: "open", protocol: "chat" });
    const rows = wsRows();
    expect(rows.some((r) => r.status === 101 && r.dest === "wss://example.com/chat")).toBe(true);
    /* A clean open + close adds the bridge's bounded WS_OPEN/WS_CLOSE
       stage rows (#664), all info - a normal close is not a failure. */
    mock.handlers[mock.handlers.length - 1]!.onclose(1000, "done");
    const added = DIAG.snapshot(start).events;
    expect(added.map((e) => e.stage)).toEqual([undefined, "WS_OPEN", "WS_CLOSE"]);
    expect(added.every((e) => e.severity === "info")).toBe(true);
    const closeRows = wsRows().filter((r) => r.status === 1000);
    expect(closeRows.some((r) => r.verdict === "ws:closed")).toBe(true);
  });

  it("the open attempt is visible before the transport settles anything (#664)", () => {
    const before = DIAG.snapshot(0).events.length;
    const p = fakePort();
    wsBridge.open(p, "wss://hang.example/socket", []);
    /* No transport callback fires: a never-settling handshake must
       still be triagable immediately, not only after the open deadline
       turns it into an abnormal close. */
    const events = DIAG.snapshot(0).events;
    expect(events.length).toBe(before + 1);
    const ev = events[events.length - 1]!;
    expect(ev.category).toBe("WEBSOCKET");
    expect(ev.severity).toBe("info");
    expect(ev.message).toBe("page websocket open attempt");
    expect(ev.url).toBe("wss://hang.example/socket");
    expect(ev.traceId).toBeTruthy();
  });

  it("passes ws:// through unchanged before the transport sees it (#525)", () => {
    const p = fakePort();
    wsBridge.open(p, "ws://example.com/chat", []);
    expect(mock.opens[mock.opens.length - 1]!.url).toBe("ws://example.com/chat");
  });

  it("an abnormal close emits a DIAG failure and an aborted netlog row", () => {
    const before = DIAG.snapshot(0).events.length;
    const p = fakePort();
    wsBridge.open(p, "wss://drop.example/", []);
    /* Transport onclose is always a clean end (wsbridge wires
       onclose => end(..., true)); the abnormal path is an onerror
       BEFORE the handshake completes, which the bridge converts into
       a dirty 1006 close. */
    mock.handlers[mock.handlers.length - 1]!.onerror("boom");
    const events = DIAG.snapshot(0).events;
    expect(events.length).toBeGreaterThan(before);
    /* #664: the bridge emits the WS_ERROR stage event, then the
       abnormal WS_CLOSE; the wiring hook adds no row of its own. */
    expect(events.some((e) => e.stage === "WS_ERROR" && e.severity === "error")).toBe(true);
    const ev = events[events.length - 1];
    expect(ev.category).toBe("WEBSOCKET");
    expect(ev.cause).toBe("failure");
    expect(ev.severity).toBe("error");
    expect(ev.stage).toBe("WS_CLOSE");
    const rows = wsRows().filter((r) => r.status === 1006);
    expect(rows.some((r) => r.verdict === "ws:aborted" && /abnormal close 1006/.test(r.err ?? ""))).toBe(true);
  });
});
