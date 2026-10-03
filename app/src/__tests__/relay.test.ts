import { describe, expect, it } from "vitest";
import { tapChannel } from "../bootstrap/relay";

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
    tapChannel(ch);
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
    tapChannel(ch);
    const seen: unknown[] = [];
    (ch as Record<string, unknown>).onmessage = (e: MessageEvent) => seen.push(e.data);
    expect(Object.prototype.hasOwnProperty.call(ch, "onmessage")).toBe(true);
    expect(ch.started).toBe(true); /* assignment starts delivery, like a MessagePort */
    ch.dispatchEvent(msg({ zl: "ws" }));
    ch.dispatchEvent(msg({ ok: 1 }));
    expect(seen).toEqual([{ ok: 1 }]);
    /* clearing the handler stops delivery; the property stays */
    (ch as Record<string, unknown>).onmessage = null;
    ch.dispatchEvent(msg({ ok: 2 }));
    expect(seen).toEqual([{ ok: 1 }]);
  });

  it("removeEventListener removes the wrapped callback, not the raw one", () => {
    const ch = new FakeChannel();
    tapChannel(ch);
    const seen: unknown[] = [];
    const cb = (e: Event) => seen.push((e as MessageEvent).data);
    ch.addEventListener("message", cb);
    ch.removeEventListener("message", cb);
    ch.dispatchEvent(msg({ ok: 1 }));
    expect(seen).toEqual([]);
  });

  it("a throwing app handler is contained", () => {
    const ch = new FakeChannel();
    tapChannel(ch);
    (ch as Record<string, unknown>).onmessage = () => {
      throw new Error("app boom");
    };
    expect(() => ch.dispatchEvent(msg({ ok: 1 }))).not.toThrow();
  });
});
