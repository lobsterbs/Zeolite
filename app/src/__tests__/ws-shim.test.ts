import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWs } from "../bootstrap/ws";

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
