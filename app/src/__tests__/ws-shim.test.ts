import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWs } from "../bootstrap/ws";

/* #61: the controller seam is mocked so a bridge-initiated abnormal
   close can be driven through the port without a real SW. */
const ctlState = vi.hoisted(() => ({
  ctl: null as { postMessage(msg: unknown, transfer?: unknown[]): void } | null,
}));
vi.mock("../siteid", () => ({ swc: () => ctlState.ctl }));

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
    port2?.postMessage({ ev: "open", protocol: "chat" });
    port2?.postMessage({ ev: "close", code: 1006, clean: false });
    await new Promise((r) => setTimeout(r, 0)); /* let port delivery flush */
    await new Promise((r) => setTimeout(r, 0)); /* let queued events flush */
    expect(order).toEqual(["open", "close"]);
    expect(es.readyState).toBe(3);
    expect(seen).toEqual({ code: 1006, wasClean: false });
  });
});
