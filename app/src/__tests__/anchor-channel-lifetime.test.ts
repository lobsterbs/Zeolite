import { afterEach, describe, expect, it, vi } from "vitest";

/* #489: real anchor shim, instrumented MessageChannel lifetime.
   The fake controller speaks the existing zl:decodeRoutes protocol. */
const ROUTE = "/j/abcdefghijklmnopqrstuv";
const DEST = "https://real.example/page";

class Port {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closes = 0;
  close(): void { this.closes++; }
  postMessage(_data: unknown): void {}
}
class Channel {
  static all: Channel[] = [];
  port1 = new Port();
  port2 = new Port();
  constructor() {
    this.port2.postMessage = (data: unknown) => {
      this.port1.onmessage?.({ data } as MessageEvent);
    };
    Channel.all.push(this);
  }
}

async function setup(mode: "success" | "malformed" | "timeout" | "throw") {
  vi.resetModules();
  Channel.all = [];
  vi.stubGlobal("MessageChannel", Channel);
  const sends: Array<{ type: string; routes: string[] }> = [];
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage(msg: { type: string; routes: string[] }, ports: Port[]) {
          sends.push(msg);
          if (mode === "throw") throw new Error("channel closed");
          if (mode === "success") ports[0].postMessage({ ok: true, dests: msg.routes.map(() => DEST) });
          if (mode === "malformed") ports[0].postMessage({ ok: true, dests: "wrong" });
        },
      },
    },
  });
  const proto = {
    getAttribute(this: { attrs: Record<string, string> }, name: string) {
      return this.attrs[name] ?? null;
    },
  };
  const anchor = Object.assign(Object.create(proto), {
    tagName: "A", attrs: { href: ROUTE },
  });
  const win = {
    Element: { prototype: proto },
    document: { readyState: "complete", querySelectorAll: () => [anchor] },
    location: { href: "https://engine.example/j/page" },
  };
  const { applyAnchorShim } = await import("../bootstrap/anchorshim");
  applyAnchorShim(win);
  return { sends, anchor };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("anchor decoding channel cleanup (#489)", () => {
  for (const mode of ["success", "malformed", "timeout", "throw"] as const) {
    it(`closes both endpoints exactly once on ${mode}`, async () => {
      vi.useFakeTimers();
      const fixture = await setup(mode);
      await vi.advanceTimersByTimeAsync(250);
      expect(fixture.sends).toHaveLength(1);
      expect(Channel.all).toHaveLength(1);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(5001);
      const ch = Channel.all[0];
      expect(ch.port1.closes).toBe(1);
      expect(ch.port2.closes).toBe(1);
      expect(ch.port1.onmessage).toBeNull();
      /* A late or duplicate reply must not close twice or mutate the memo. */
      ch.port2.postMessage({ ok: true, dests: [DEST, DEST] });
      expect(ch.port1.closes).toBe(1);
    });
  }
});
