import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWs } from "../bootstrap/ws";

/* #61: the controller seam is mocked so a bridge-initiated abnormal
   close can be driven through the port without a real SW. */
const ctlState = vi.hoisted(() => ({
  ctl: null as { postMessage(msg: unknown, transfer?: unknown[]): void } | null,
}));
vi.mock("../bootstrap/siteid", () => ({ swc: () => ctlState.ctl }));

/* The page WebSocket shim (#54 parity): a shim instance must be
   instanceof the real constructor (prototype parity), raw on-handler
   assignment must stay a plain own property, and with no controller
   the shim must fail closed the way a dead endpoint would. The
   queued close event needs a CloseEvent global, stubbed here so the
   row does not depend on the Node vintage. */

class FakeCloseEvent extends Event {
  code: number;
  wasClean: boolean;
  constructor(type: string, init?: { code?: number; wasClean?: boolean }) {
    super(type);
    this.code = init?.code ?? 0;
    this.wasClean = init?.wasClean ?? false;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  ctlState.ctl = null;
});

describe("page WebSocket shim (#54 parity)", () => {
  it("adopts the real prototype and keeps on-handlers plain own props", async () => {
    const Real = globalThis.WebSocket;
    if (!Real) return; /* no WebSocket global in this realm: nothing to wrap */
    vi.stubGlobal("CloseEvent", FakeCloseEvent);
    const w: Record<string, unknown> = { WebSocket: Real };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    expect(WS).not.toBe(Real);
    const es = new WS("wss://relay.example/ws") as unknown as Record<string, unknown>;
    expect(es instanceof Real).toBe(true);
    expect(es instanceof WS).toBe(true);
    const h = () => undefined;
    es.onopen = h;
    expect(es.onopen).toBe(h); /* plain data, not a brand-checked accessor */
    await new Promise((r) => setTimeout(r, 0)); /* let the no-controller fail-closed fire contained */
  });
});

describe("page WebSocket shim abnormal close (#61)", () => {
  it("delivers a bridge-initiated 1006 close in native order", async () => {
    const Real = globalThis.WebSocket;
    if (!Real) return; /* no WebSocket global in this realm */
    vi.stubGlobal("CloseEvent", FakeCloseEvent);
    let port2: MessagePort | null = null;
    ctlState.ctl = {
      postMessage(_msg: unknown, transfer?: unknown[]) {
        port2 = (transfer?.[0] as MessagePort) ?? null;
      },
    };
    const w: Record<string, unknown> = { WebSocket: Real };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    const es = new WS("wss://relay.example/ws");
    const order: string[] = [];
    let seen: { code: number; wasClean: boolean } | null = null;
    es.onopen = () => order.push("open");
    es.onclose = (ev: CloseEvent) => {
      order.push("close");
      seen = { code: ev.code, wasClean: ev.wasClean };
    };
    /* the closure assignment is invisible to control-flow analysis */
    const port = port2 as MessagePort | null;
    port?.postMessage({ ev: "open", protocol: "chat" });
    port?.postMessage({ ev: "close", code: 1006, clean: false });
    await new Promise((r) => setTimeout(r, 0)); /* let port delivery flush */
    await new Promise((r) => setTimeout(r, 0)); /* let queued events flush */
    expect(order).toEqual(["open", "close"]);
    expect(es.readyState).toBe(3);
    expect(seen).toEqual({ code: 1006, wasClean: false });
  });
});

describe("page WebSocket shim send and close states (#460/#461)", () => {
  it("throws when connecting, sends when open, and discards sends after close", async () => {
    const Real = globalThis.WebSocket;
    if (!Real) return; /* no WebSocket global in this realm */
    vi.stubGlobal("CloseEvent", FakeCloseEvent);
    let port2: MessagePort | null = null;
    ctlState.ctl = {
      postMessage(_msg: unknown, transfer?: unknown[]) {
        port2 = (transfer?.[0] as MessagePort) ?? null;
      },
    };
    const w: Record<string, unknown> = { WebSocket: Real };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    const es = new WS("wss://relay.example/ws");
    expect(es.readyState).toBe(0);
    expect(es.bufferedAmount).toBe(0);
    expect(() => es.send("a")).toThrowError(expect.objectContaining({ name: "InvalidStateError" }));
    const port = port2 as MessagePort | null;
    port?.postMessage({ ev: "open", protocol: "chat" });
    await new Promise((r) => setTimeout(r, 0)); /* port delivery */
    await new Promise((r) => setTimeout(r, 0)); /* queued events */
    expect(es.readyState).toBe(1);
    es.send("open");
    es.close();
    expect(es.readyState).toBe(2);
    expect(() => es.send("discarded")).not.toThrow();
    port?.postMessage({ ev: "close", code: 1000, clean: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(es.readyState).toBe(3);
    expect(() => es.send("discarded")).not.toThrow();
  });

  it("posts converted close arguments to the bridge", async () => {
    const Real = globalThis.WebSocket;
    if (!Real) return;
    let port!: MessagePort;
    ctlState.ctl = { postMessage(_m: unknown, transfers?: unknown[]) { port = transfers![0] as MessagePort; } };
    const w: Record<string, unknown> = { WebSocket: Real };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    const ws = new WS("wss://relay.example/ws");
    const received = new Promise<unknown>(resolve => { port.onmessage = e => resolve(e.data); });
    ws.close("1000" as unknown as number, { toString: () => "bye" } as unknown as string);
    expect(await received).toEqual({ op: "close", code: 1000, reason: "bye" });
  });

  it("rejects invalid close codes and overlong UTF-8 reasons before changing state", () => {
    const Real = globalThis.WebSocket;
    if (!Real) return;
    ctlState.ctl = { postMessage() {} };
    const w: Record<string, unknown> = { WebSocket: Real };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    const es = new WS("wss://relay.example/ws");
    for (const code of [1001, 2999, 5000]) {
      expect(() => es.close(code)).toThrowError(expect.objectContaining({ name: "InvalidAccessError" }));
      expect(es.readyState).toBe(0);
    }
    expect(() => es.close(1000, "é".repeat(62))).toThrowError(expect.objectContaining({ name: "SyntaxError" }));
    expect(es.readyState).toBe(0);
    expect(() => es.close(3000, "a".repeat(123))).not.toThrow();
    expect(es.readyState).toBe(2);
    expect(() => es.close(1001)).toThrowError(expect.objectContaining({ name: "InvalidAccessError" }));
  });
});

describe("page WebSocket shim relative URLs (#279)", () => {
  it("resolves relative references against the page base (#279)", () => {
    const Real = globalThis.WebSocket;
    if (!Real) return;
    vi.stubGlobal("CloseEvent", FakeCloseEvent);
    const posted: unknown[] = [];
    ctlState.ctl = { postMessage(msg: unknown) { posted.push(msg); } };
    const w: Record<string, unknown> = {
      WebSocket: Real,
      document: { baseURI: "https://engine.example/app/dir/page.html" },
      location: { href: "https://engine.example/app/dir/page.html" },
    };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    const urlOf = (i: number) => (posted[i] as { url: string }).url;
    /* root-relative: the engine origin, the path the page named */
    const root = new WS("/socket");
    expect(urlOf(0)).toBe("wss://engine.example/socket");
    expect(root.url).toBe("wss://engine.example/socket");
    /* path-relative: resolved against the base directory */
    new WS("api/ws");
    expect(urlOf(1)).toBe("wss://engine.example/app/dir/api/ws");
    /* query-bearing */
    new WS("/socket?rooms=2");
    expect(urlOf(2)).toBe("wss://engine.example/socket?rooms=2");
    /* absolute ws/wss keep current behavior */
    new WS("wss://relay.example/ws");
    expect(urlOf(3)).toBe("wss://relay.example/ws");
  });

  it("throws SyntaxError for explicit http(s) schemes like the native constructor (#364)", () => {
    const Real = globalThis.WebSocket;
    if (!Real) return;
    vi.stubGlobal("CloseEvent", FakeCloseEvent);
    ctlState.ctl = { postMessage() { /* unused */ } };
    const w: Record<string, unknown> = {
      WebSocket: Real,
      document: { baseURI: "https://engine.example/page.html" },
    };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    for (const bad of ["http://engine.example/socket", "https://engine.example/socket", "HTTP://engine.example/socket"]) {
      let err: unknown = null;
      try {
        new WS(bad);
      } catch (e) {
        err = e;
      }
      expect((err as DOMException).name).toBe("SyntaxError");
    }
  });

  it("rejects fragments and non-web schemes like the native constructor", () => {
    const Real = globalThis.WebSocket;
    if (!Real) return;
    vi.stubGlobal("CloseEvent", FakeCloseEvent);
    ctlState.ctl = { postMessage() { /* unused */ } };
    const w: Record<string, unknown> = {
      WebSocket: Real,
      document: { baseURI: "https://engine.example/page.html" },
    };
    applyWs(w);
    const WS = w.WebSocket as new (u: string) => WebSocket;
    for (const bad of ["/socket#frag", "wss://relay.example/ws#f"]) {
      let err: unknown = null;
      try {
        new WS(bad);
      } catch (e) {
        err = e;
      }
      expect((err as DOMException).name).toBe("SyntaxError");
    }
    /* non-web schemes are refused with the same SyntaxError (#364) */
    let nativeErr: unknown = null;
    try {
      new WS("ftp://example.com/x");
    } catch (e) {
      nativeErr = e;
    }
    expect(nativeErr).not.toBeNull();
  });
});
