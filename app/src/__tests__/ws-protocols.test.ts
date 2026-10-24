import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWs } from "../bootstrap/ws";

/* #419: the second constructor argument follows the native Web
   Socket contract (a string or a sequence of valid tokens,
   SyntaxError otherwise) instead of silently concatenating
   whatever the page passed onto the bridge protocols array. The
   observed breakage: Colyseus passes its options object, the old
   shim sent it as a subprotocol entry, and the server rejected
   the handshake. */

const ctlState = vi.hoisted(() => ({
  ctl: null as { postMessage(msg: unknown, transfer?: unknown[]): void } | null,
}));
vi.mock("../bootstrap/siteid", () => ({ swc: () => ctlState.ctl }));

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

function setup() {
  const Real = globalThis.WebSocket;
  if (!Real) throw new Error("no WebSocket global in this realm");
  vi.stubGlobal("CloseEvent", FakeCloseEvent);
  const posted: Array<{ url: string; protocols: string[] }> = [];
  ctlState.ctl = {
    postMessage(msg: unknown) {
      posted.push(msg as { url: string; protocols: string[] });
    },
  };
  const w: Record<string, unknown> = {
    WebSocket: Real,
    location: { href: "https://engine.example/page.html" },
  };
  applyWs(w);
  const WS = w.WebSocket as new (u: string, p?: unknown) => WebSocket;
  return { WS, posted };
}

describe("page WebSocket shim subprotocol contract (#419)", () => {
  it("rejects the Colyseus options object like native and lets the caller fall back", () => {
    const { WS, posted } = setup();
    /* the observed Colyseus pattern: an options object in the
       protocols slot. Native throws SyntaxError; the old shim
       concatenated the object into the bridge array and the
       server saw a garbage subprotocol header ("Game not
       found"). */
    expect(() =>
      new WS("wss://engine.example/ws", { headers: {}, protocols: ["chat"] } as unknown as string),
    ).toThrow(/subprotocol/);
    expect(posted).toHaveLength(0); /* nothing reached the bridge */
    new WS("wss://engine.example/ws", "chat");
    expect(posted).toHaveLength(1);
    expect(posted[0].protocols).toEqual(["chat"]);
  });

  it("accepts a sequence and rejects duplicate, empty and invalid tokens like native", () => {
    const { WS, posted } = setup();
    new WS("wss://engine.example/ws", ["a", "b"]);
    expect(posted[0].protocols).toEqual(["a", "b"]);
    expect(() => new WS("wss://engine.example/ws", ["a", "a"])).toThrow(/subprotocol/);
    expect(() => new WS("wss://engine.example/ws", [""])).toThrow(/subprotocol/);
    expect(() => new WS("wss://engine.example/ws", ["a b"])).toThrow(/subprotocol/);
    expect(posted).toHaveLength(1);
  });

  it("sends an empty list when the argument is absent", () => {
    const { WS, posted } = setup();
    new WS("wss://engine.example/ws");
    expect(posted[0].protocols).toEqual([]);
  });
});
