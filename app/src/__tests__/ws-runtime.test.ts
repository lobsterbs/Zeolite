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
    const before = DIAG.snapshot(0).events.length;
    const p = fakePort();
    wsBridge.open(p, "wss://example.com/chat", ["chat"]);
    expect(mock.opens.length).toBeGreaterThan(0);
    expect(mock.opens[mock.opens.length - 1]!.url).toBe("wss://example.com/chat");
    expect(mock.opens[mock.opens.length - 1]!.protocols).toEqual(["chat"]);
    mock.handlers[mock.handlers.length - 1]!.onopen("chat");
    expect(p.posted).toContainEqual({ ev: "open", protocol: "chat" });
    const rows = wsRows();
    expect(rows.some((r) => r.status === 101 && r.dest === "wss://example.com/chat")).toBe(true);
    /* A clean close after a successful open is not a failure event. */
    const beforeClose = DIAG.snapshot(0).events.length;
    mock.handlers[mock.handlers.length - 1]!.onclose(1000, "done");
    expect(DIAG.snapshot(0).events.length).toBe(beforeClose);
    expect(DIAG.snapshot(0).events.length).toBe(before); /* no DIAG rows at all */
    const closeRows = wsRows().filter((r) => r.status === 1000);
    expect(closeRows.some((r) => r.verdict === "ws:closed")).toBe(true);
  });

  it("upgrades ws:// before the transport sees it", () => {
    const p = fakePort();
    wsBridge.open(p, "ws://example.com/chat", []);
    expect(mock.opens[mock.opens.length - 1]!.url).toBe("wss://example.com/chat");
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
    const ev = events[events.length - 1];
    expect(ev.category).toBe("WEBSOCKET");
    expect(ev.cause).toBe("failure");
    expect(ev.severity).toBe("error");
    const rows = wsRows().filter((r) => r.status === 1006);
    expect(rows.some((r) => r.verdict === "ws:aborted" && /abnormal close 1006/.test(r.err ?? ""))).toBe(true);
  });
});
