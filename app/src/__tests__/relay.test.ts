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

  it("hides wrapper shapes from object listeners too, and removes them (#284)", () => {
    const ch = new FakeChannel();
    const relaySeen: unknown[] = [];
    ch.addEventListener("message", (e) => relaySeen.push((e as MessageEvent).data));
    tapChannel(ch as unknown as MessagePort);
    const appSeen: unknown[] = [];
    const obj = { handleEvent: (e: MessageEvent) => appSeen.push(e.data) };
    ch.addEventListener("message", obj);
    ch.dispatchEvent(msg({ zl: "ws" }));
    ch.dispatchEvent(msg({ ok: 1 }));
    expect(appSeen).toEqual([{ ok: 1 }]); // wrapper shapes stay hidden
    expect(relaySeen).toEqual([{ zl: "ws" }, { ok: 1 }]);
    ch.removeEventListener("message", obj);
    ch.dispatchEvent(msg({ ok: 2 }));
    expect(appSeen).toEqual([{ ok: 1 }]);
  });
});

describe("worker ctor wrappers (#275 native semantics)", () => {
  class FakeWorker extends EventTarget {
    constructor(public u: string, public o?: unknown) {
      super();
    }
  }
  class FakeSharedWorker {
    port: FakeChannel;
    constructor(public u: string, public o?: unknown) {
      this.port = new FakeChannel();
    }
  }
  const inst = (x: unknown, ctor: unknown) =>
    x instanceof (ctor as unknown as abstract new (...a: unknown[]) => unknown);
  it("instances pass instanceof, bare calls throw, relay hooks still run", () => {
    const G = globalThis as unknown as Record<string, unknown>;
    const nativeAdd = G.addEventListener;
    G.addEventListener = () => {};
    G.location = { origin: "http://engine.example" };
    const w: Record<string, unknown> = {
      Worker: FakeWorker,
      SharedWorker: FakeSharedWorker,
    };
    try {
      applyRelay(w, "s", "https://engine.example/page");
    } finally {
      G.addEventListener = nativeAdd;
      delete G.location;
    }
    const W = w.Worker as unknown as (u: string, o?: unknown) => unknown;
    const wk = new (W as unknown as new (u: string, o?: unknown) => unknown)("u.js");
    expect(inst(wk, w.Worker)).toBe(true);
    expect(inst(wk, FakeWorker)).toBe(true);
    expect(() => W("u.js")).toThrow(); // new-only, like the native ctor
    const S = w.SharedWorker as unknown as (
      u: string,
      o?: string | { name?: string },
    ) => unknown;
    const sw = new (S as unknown as new (
      u: string,
      o?: string | { name?: string },
    ) => unknown)("u.js", { name: "n" }); // options object form
    expect(inst(sw, w.SharedWorker)).toBe(true);
    expect(() => S("u.js")).toThrow();
    /* the relay hooks still ran: both channels are tapped */
    expect(
      Object.prototype.hasOwnProperty.call(wk, "onmessage"),
    ).toBe(true);
    const port = (sw as unknown as { port: unknown }).port as unknown;
    expect(Object.prototype.hasOwnProperty.call(port, "onmessage")).toBe(true);
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

describe("SharedWorker identity scoping (#260)", () => {
  const setup = (site: string) => {
    class FakeSharedWorker {
      port: FakeChannel;
      constructor(public u: string, public o?: unknown) {
        this.port = new FakeChannel();
      }
    }
    const G = globalThis as unknown as Record<string, unknown>;
    const nativeAdd = G.addEventListener;
    G.addEventListener = () => {};
    const w: Record<string, unknown> = { SharedWorker: FakeSharedWorker };
    try {
      applyRelay(w, site, "https://engine.example/page");
    } finally {
      G.addEventListener = nativeAdd;
    }
    const seen: Array<{ u: string; o?: unknown }> = [];
    const S = w.SharedWorker as unknown as new (u: string, o?: unknown) => {
      u: string;
      o?: unknown;
    };
    const mk = (u: string, o?: unknown) => {
      const x = new S(u, o);
      seen.push({ u: x.u, o: x.o });
      return x;
    };
    return { seen, mk };
  };

  it("scopes the worker name per virtual site, both arg forms, URL untouched", () => {
    const a = setup("siteA");
    a.mk("/shared.js", "myname");
    a.mk("/shared.js", { name: "myname", type: "classic" });
    a.mk("/shared.js"); /* unnamed */
    const b = setup("siteB");
    b.mk("/shared.js", "myname");
    expect(a.seen.map((x) => x.o)).toEqual([
      "myname\u0000zl:siteA",
      { name: "myname\u0000zl:siteA", type: "classic" },
      { name: "\u0000zl:siteA" },
    ]);
    expect(b.seen[0].o).toBe("myname\u0000zl:siteB");
    expect(b.seen[0].u).toBe("/shared.js"); /* the script URL is never touched */
  });

  it("same site, same URL and name share one scoped identity", () => {
    const a = setup("siteA");
    a.mk("/s.js", "n");
    a.mk("/s.js", "n");
    expect(a.seen[0].o).toBe(a.seen[1].o);
  });
});
