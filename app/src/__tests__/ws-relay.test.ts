import { describe, expect, it, vi } from "vitest";
import { relayRegister } from "../relayfetch";
import { relayWsFactory } from "../ws-relay";
import type { PortLike } from "../wsbridge";

/* #511: pins the WebSocket-over-relay frame contract. The factory
   emits typed zl:ws* frames on the registered relay port, maps relay
   frames back to WsFactory handler calls with native payload parity
   (text stays text, binary arrives as a Blob), keeps the conn live
   across a client close until the handshake completes (the echoed
   close or the bounded fallback), and fails honestly when the channel
   is dead. The old code had NO relay path at all: every page
   WebSocket rode the wisp transport, which is auth-refused on relay
   deployments, so these frames did not exist. */

class FakePort implements PortLike {
  posted: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage(data: unknown): void {
    this.posted.push(data);
  }
  close(): void {
    this.closed = true;
  }
  deliver(m: unknown): void {
    this.onmessage?.({ data: m });
  }
}

function handlers() {
  return {
    onopen: vi.fn<(p: string) => void>(),
    onmessage: vi.fn<(d: unknown) => void>(),
    onclose: vi.fn<(c: number, r: string) => void>(),
    onerror: vi.fn<(e: string) => void>(),
  };
}

describe("relay ws factory (#511)", () => {
  it("posts zl:wsRelay and maps open/data/close frames", () => {
    const port = new FakePort();
    relayRegister(port as unknown as MessagePort);
    const h = handlers();
    const handle = relayWsFactory.open(
      "wss://game.example/socket",
      ["colyseus"],
      h,
      [["origin", "https://game.example"]],
    );
    const open = port.posted[0] as {
      type: string;
      rid: number;
      url: string;
      protocols: string[];
      headers: Array<[string, string]>;
    };
    expect(open.type).toBe("zl:wsRelay");
    expect(open.url).toBe("wss://game.example/socket");
    expect(open.protocols).toEqual(["colyseus"]);
    expect(open.headers).toEqual([["origin", "https://game.example"]]);
    port.deliver({ type: "zl:wsOpen", rid: open.rid, protocol: "colyseus" });
    expect(h.onopen).toHaveBeenCalledWith("colyseus");
    port.deliver({ type: "zl:wsData", rid: open.rid, data: "hello" });
    expect(h.onmessage).toHaveBeenCalledWith("hello");
    port.deliver({ type: "zl:wsData", rid: open.rid, data: new Uint8Array([1, 2, 3]), bin: true });
    const rx = h.onmessage.mock.calls[1][0] as Blob;
    expect(rx).toBeInstanceOf(Blob);
    handle.close(1000, "done");
    const closeFrame = port.posted[port.posted.length - 1] as { type: string; rid: number; code: number };
    expect(closeFrame.type).toBe("zl:wsClose");
    expect(closeFrame.rid).toBe(open.rid);
    expect(closeFrame.code).toBe(1000);
    /* native parity: close() itself must not fire the close event */
    expect(h.onclose).not.toHaveBeenCalled();
    port.deliver({ type: "zl:wsClose", rid: open.rid, code: 1000, reason: "" });
    expect(h.onclose).toHaveBeenCalledWith(1000, "");
  });

  it("maps send payloads: text, binary views and Blob", async () => {
    const port = new FakePort();
    relayRegister(port as unknown as MessagePort);
    const h = handlers();
    const handle = relayWsFactory.open("wss://x.example/", [], h);
    const rid = (port.posted[0] as { rid: number }).rid;
    handle.send("text");
    expect(port.posted[port.posted.length - 1]).toEqual({ type: "zl:wsSend", rid, data: "text", bin: false });
    handle.send(new Uint8Array([9, 8]));
    const f = port.posted[port.posted.length - 1] as { type: string; bin: boolean; data: Uint8Array };
    expect(f.type).toBe("zl:wsSend");
    expect(f.bin).toBe(true);
    expect(Array.from(f.data)).toEqual([9, 8]);
    handle.send(new Blob([new Uint8Array([7])]));
    await new Promise((r) => setTimeout(r, 20));
    const g = port.posted[port.posted.length - 1] as { bin: boolean; data: Uint8Array };
    expect(g.bin).toBe(true);
    expect(Array.from(g.data)).toEqual([7]);
  });

  it("reports a pre-open relay failure as an error and stops dispatching", () => {
    const port = new FakePort();
    relayRegister(port as unknown as MessagePort);
    const h = handlers();
    relayWsFactory.open("wss://blocked.example/", [], h);
    const rid = (port.posted[0] as { rid: number }).rid;
    port.deliver({ type: "zl:wsError", rid, error: "upstream refused" });
    expect(h.onerror).toHaveBeenCalledWith("upstream refused");
    /* the dead rid no longer dispatches */
    port.deliver({ type: "zl:wsData", rid, data: "late" });
    expect(h.onmessage).not.toHaveBeenCalled();
  });

  it("throws honestly when the relay port is dead", () => {
    const port = new FakePort() as FakePort & { postMessage(d: unknown): void };
    port.postMessage = () => {
      throw new Error("dead channel");
    };
    relayRegister(port as unknown as MessagePort);
    expect(() => relayWsFactory.open("wss://x.example/", [], handlers())).toThrow("relay channel unavailable");
  });

  it("fires a bounded fallback close when the channel never echoes", () => {
    vi.useFakeTimers();
    try {
      const port = new FakePort();
      relayRegister(port as unknown as MessagePort);
      const h = handlers();
      const handle = relayWsFactory.open("wss://x.example/", [], h);
      const rid = (port.posted[0] as { rid: number }).rid;
      port.deliver({ type: "zl:wsOpen", rid, protocol: "" });
      handle.close(1000, "done");
      /* native parity: the close event does not fire on close() itself */
      expect(h.onclose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(h.onclose).toHaveBeenCalledWith(1000, "done");
      /* a late echo after the fallback does not double-fire */
      port.deliver({ type: "zl:wsClose", rid, code: 1000, reason: "" });
      expect(h.onclose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
