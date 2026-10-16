import { describe, expect, it } from "vitest";
import { applyRelay, tapChannel } from "../bootstrap/relay";

/* The Worker/SharedWorker channel tap (#54 dedicated-Worker hook):
   wrapper shapes ({zl:"ws"} / {zl:"mint"}) must reach the pre-tap
   relay listener but never an app handler, and the tap must keep
   addEventListener/removeEventListener and the onmessage property
   symmetric with the native channel. */

class FakeChannel extends EventTarget {
  started = false;
  start(): void {
    this.started = true;
  }
}

const msg = (data: unknown): MessageEvent =>
  new MessageEvent("message", { data });

describe("tapChannel (#54 dedicated-Worker hook)", () => {
  it("hides wrapper shapes from app listeners, not from the pre-tap relay", () => {
    const ch = new FakeChannel();
    const relaySeen: unknown[] = [];
    ch.addEventListener("message", (e) => relaySeen.push((e as MessageEvent).data));
    tapChannel(ch as unknown as MessagePort);
    const appSeen: unknown[] = [];
    ch.addEventListener("message", (e) => appSeen.push((e as MessageEvent).data));
    ch.dispatchEvent(msg({ zl: "mint", msg: { dest: "https://x.example/" } }));
    ch.dispatchEvent(msg({ hello: 1 }));
    expect(relaySeen).toEqual([
      { zl: "mint", msg: { dest: "https://x.example/" } },
      { hello: 1 },
    ]);
    expect(appSeen).toEqual([{ hello: 1 }]);
  });

  it("onmessage becomes an own property that starts the port and skips wrappers", () => {
    const ch = new FakeChannel();
    tapChannel(ch as unknown as MessagePort);
    const seen: unknown[] = [];
    (ch as unknown as Record<string, unknown>).onmessage = (e: MessageEvent) => seen.push(e.data);
    expect(Object.prototype.hasOwnProperty.call(ch, "onmessage")).toBe(true);
    expect(ch.started).toBe(true); /* assignment starts delivery, like a MessagePort */
    ch.dispatchEvent(msg({ zl: "ws" }));
    ch.dispatchEvent(msg({ ok: 1 }));
    expect(seen).toEqual([{ ok: 1 }]);
    /* clearing the handler stops delivery; the property stays */
    (ch as unknown as Record<string, unknown>).onmessage = null;
    ch.dispatchEvent(msg({ ok: 2 }));
    expect(seen).toEqual([{ ok: 1 }]);
  });

  it("removeEventListener removes the wrapped callback, not the raw one", () => {
    const ch = new FakeChannel();
    tapChannel(ch as unknown as MessagePort);
    const seen: unknown[] = [];
    const cb = (e: Event) => seen.push((e as MessageEvent).data);
    ch.addEventListener("message", cb);
    ch.removeEventListener("message", cb);
    ch.dispatchEvent(msg({ ok: 1 }));
    expect(seen).toEqual([]);
  });

  it("a throwing app handler is contained", () => {
    const ch = new FakeChannel();
    tapChannel(ch as unknown as MessagePort);
    (ch as unknown as Record<string, unknown>).onmessage = () => {
      throw new Error("app boom");
    };
    expect(() => ch.dispatchEvent(msg({ ok: 1 }))).not.toThrow();
  });
});



describe("window relay arm (#169: fails closed)", () => {
  it("relays only same-origin self-posted messages", async () => {
    /* The repo's vitest runs the node environment, so the test feeds
       applyRelay a bare realm record and injects the two globals the
       arm reads (location, and the realm addEventListener it captures
       through a temporary shadow). */
    const O = "http://engine.example";
    const G = globalThis as unknown as Record<string, unknown>;
    let captured: ((e: MessageEvent) => void) | null = null;
    const nativeAdd = G.addEventListener;
    G.addEventListener = (t: string, l: (e: MessageEvent) => void) => {
      if (t === "message") captured = l;
    };
    G.location = { origin: O };
    const w: Record<string, unknown> = {};
    try {
      applyRelay(w, "", "https://engine.example/page");
    } finally {
      G.addEventListener = nativeAdd;
    }
    expect(captured).toBeTypeOf("function");
    const seen: unknown[] = [];
    const fakePort = {
      postMessage: (m: unknown) => seen.push(m),
      close: () => undefined,
    };
    const ev = (origin: string, source: unknown): MessageEvent =>
      ({ origin, source, ports: [fakePort], data: { zl: "ws" } }) as unknown as MessageEvent;
    /* Cross-origin sender: never relayed. */
    captured!(ev("https://evil.example", w));
    /* Same origin but a child frame, not the page realm itself. */
    captured!(ev(O, { child: true }));
    await new Promise((res) => setTimeout(res, 20));
    expect(seen).toHaveLength(0);
    /* Self-posted (source is the realm): relayed; with no controller
       the fail-closed terminal error frame is observable on the port. */
    captured!(ev(O, w));
    await new Promise((res) => setTimeout(res, 20));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ ev: "error", code: 1006, clean: false });
    delete G.location;
  });
});
