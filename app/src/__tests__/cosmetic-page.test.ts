import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCosmeticPage, runScriptlets } from "../cosmetic-page";

/* #551 second slice: the page-side cosmetic runtime core, exercised
   in a stand-in realm (the dom-inspect bridge pattern). Fake
   document, fake controller with connected fake MessageChannel
   pairs, fake MutationObserver, fake timers for the debounce, retry
   and budget paths. The core touches the page only through the
   shapes it declares, so no DOM environment is needed. */

interface FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(d: unknown): void;
  close(): void;
}

interface Reply {
  ok?: boolean;
  styles?: string;
  off?: boolean;
  pending?: boolean;
}

interface Realm {
  w: Record<string, unknown>;
  sent: Record<string, unknown>[];
  styleEls: { attrs: Record<string, string>; textContent: string }[];
  observers: { cb: () => void; disconnect: () => void; disconnected: number; observed: unknown }[];
  domListeners: Record<string, () => void>;
  els: { classList: string[]; getAttribute(name: string): unknown }[];
}

function connectedPair(): [FakePort, FakePort] {
  const a: FakePort = { onmessage: null, postMessage() {}, close() {} };
  const b: FakePort = { onmessage: null, postMessage() {}, close() {} };
  a.postMessage = (d: unknown) => {
    b.onmessage?.({ data: d });
  };
  b.postMessage = (d: unknown) => {
    a.onmessage?.({ data: d });
  };
  return [a, b];
}

function makeRealm(
  els: { classes: string[]; id?: string }[],
  reply: (m: Record<string, unknown>) => Reply | null,
): Realm {
  const sent: Record<string, unknown>[] = [];
  const styleEls: { attrs: Record<string, string>; textContent: string }[] = [];
  const observers: Realm["observers"] = [];
  const domListeners: Record<string, () => void> = {};
  const fakeEls = els.map((e) => ({
    classList: e.classes,
    getAttribute(name: string): unknown {
      return name === "id" ? e.id ?? null : null;
    },
  }));
  const w: Record<string, unknown> = {
    MessageChannel: class {
      port1: FakePort;
      port2: FakePort;
      constructor() {
        const [a, b] = connectedPair();
        this.port1 = a;
        this.port2 = b;
      }
    },
    MutationObserver: class {
      cb: () => void;
      disconnected = 0;
      observed: unknown = null;
      constructor(cb: () => void) {
        this.cb = cb;
        observers.push(this as unknown as Realm["observers"][number]);
      }
      observe(t: unknown): void {
        this.observed = t;
      }
      disconnect(): void {
        this.disconnected += 1;
      }
    },
    navigator: {
      serviceWorker: {
        controller: {
          postMessage(m: Record<string, unknown>, transfer: unknown[]): void {
            sent.push(m);
            const r = reply(m);
            if (r) (transfer[0] as FakePort).postMessage(r);
          },
        },
      },
    },
    document: {
      readyState: "complete",
      querySelectorAll: () => fakeEls,
      createElement: () => {
        const el = {
          attrs: {} as Record<string, string>,
          textContent: "",
          setAttribute(k: string, v: string): void {
            el.attrs[k] = v;
          },
        };
        return el;
      },
      head: {
        appendChild(el: unknown): void {
          styleEls.push(el as Realm["styleEls"][number]);
        },
      },
      documentElement: { appendChild(): void {} },
      addEventListener(name: string, fn: () => void): void {
        domListeners[name] = fn;
      },
    },
    addEventListener(name: string, fn: () => void): void {
      domListeners["w:" + name] = fn;
    },
  };
  return { w, sent, styleEls, observers, domListeners, els: fakeEls };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("runScriptlets (#551 allowlist)", () => {
  it("set-constant sets a JSON value and creates intermediate objects", () => {
    const g: Record<string, unknown> = {};
    runScriptlets(g, [{ name: "set-constant", args: ["zlA", "42"] }, { name: "set-constant", args: ["zlObj.deep.val", "1"] }]);
    expect(g.zlA).toBe(42);
    expect((g.zlObj as Record<string, Record<string, unknown>>).deep.val).toBe(1);
  });

  it("abort-on-property-read throws on read and abort-on-property-write on write", () => {
    const g: Record<string, unknown> = {};
    runScriptlets(g, [
      { name: "abort-on-property-read", args: ["zlR"] },
      { name: "abort-on-property-write", args: ["zlW"] },
    ]);
    expect(() => (g as { zlR: unknown }).zlR).toThrow("abort-on-property-read");
    expect(() => {
      (g as { zlW: unknown }).zlW = 1;
    }).toThrow("abort-on-property-write");
  });

  it("noop runs, unknown names are ignored, hostile payloads never throw", () => {
    const g: Record<string, unknown> = {};
    expect(() =>
      runScriptlets(g, [
        { name: "noop", args: [] },
        { name: "alert", args: ["1"] },
        "not-an-object",
        { name: "set-constant", args: "not-an-array" },
        { name: 42 as unknown as string, args: [] },
      ]),
    ).not.toThrow();
    expect(g.noop).toBeUndefined();
    expect(Object.keys(g).length).toBe(0);
  });

  it("bounds: at most 16 invocations, 4 args, 256 chars, 4-part chains", () => {
    const g: Record<string, unknown> = {};
    const list = [];
    for (let i = 0; i < 17; i++) list.push({ name: "set-constant", args: ["k" + i, String(i)] });
    list.push({ name: "set-constant", args: ["a.b.c.d.e", "1"] });
    list.push({ name: "set-constant", args: ["bad-key!", "1"] });
    runScriptlets(g, list);
    expect(g.k15).toBe(15);
    expect(g.k16).toBeUndefined();
    expect(g.a).toBeUndefined();
    const long = "x".repeat(300);
    runScriptlets(g, [{ name: "set-constant", args: ["zlLong", long] }]);
    expect((g.zlLong as string).length).toBe(256);
  });
});

describe("applyCosmeticPage (#551 token loop)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks with collected tokens and injects the replied styles", async () => {
    const realm = makeRealm(
      [
        { classes: ["ad-box", "side"], id: "hero" },
        { classes: ["x".repeat(200)], id: "i2" },
      ],
      () => ({ ok: true, styles: ".ad-box{display:none!important}" }),
    );
    applyCosmeticPage(realm.w, { s: [] });
    await flush();
    expect(realm.sent.length).toBe(1);
    expect(realm.sent[0]!.classes).toEqual(["ad-box", "side"]);
    expect(realm.sent[0]!.ids).toEqual(["hero", "i2"]);
    expect(realm.styleEls.length).toBe(1);
    expect(realm.styleEls[0]!.textContent).toBe(".ad-box{display:none!important}");
    expect(realm.styleEls[0]!.attrs["data-zl-cosmetic-dyn"]).toBe("");
  });

  it("runs allowlisted scriptlets against the page realm before anything else", async () => {
    const realm = makeRealm([], () => ({ ok: true, styles: "" }));
    applyCosmeticPage(realm.w, { s: [{ name: "set-constant", args: ["zlP", "7"] }] });
    await flush();
    expect(realm.w.zlP).toBe(7);
  });

  it("an off reply tears down: observer disconnected, no style, no further asks", async () => {
    const realm = makeRealm([{ classes: ["a"], id: "b" }], () => ({ ok: true, off: true }));
    applyCosmeticPage(realm.w, { s: [] });
    await flush();
    expect(realm.observers.length).toBe(1);
    expect(realm.observers[0]!.disconnected).toBe(1);
    expect(realm.styleEls.length).toBe(0);
    realm.observers[0]!.cb();
    await vi.advanceTimersByTimeAsync(5000);
    expect(realm.sent.length).toBe(1);
  });

  it("a pending reply retries exactly once", async () => {
    const realm = makeRealm([{ classes: ["a"], id: "b" }], () => ({ ok: true, pending: true }));
    applyCosmeticPage(realm.w, { s: [] });
    await flush();
    expect(realm.sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(realm.sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(realm.sent.length).toBe(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(realm.sent.length).toBe(2);
  });

  it("mutation callbacks debounce to one ask per 750 ms window", async () => {
    const realm = makeRealm([{ classes: ["a"], id: "b" }], () => ({ ok: true, styles: ".a{display:none!important}" }));
    applyCosmeticPage(realm.w, { s: [] });
    await flush();
    expect(realm.sent.length).toBe(1);
    realm.observers[0]!.cb();
    realm.observers[0]!.cb();
    realm.observers[0]!.cb();
    await vi.advanceTimersByTimeAsync(749);
    expect(realm.sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(realm.sent.length).toBe(2);
  });

  it("the query budget ends the session with a done report", async () => {
    let n = 0;
    const realm = makeRealm([{ classes: ["a"], id: "b" }], () => {
      n += 1;
      return { ok: true, styles: ".s" + n + "{display:none!important}" };
    });
    applyCosmeticPage(realm.w, { s: [] });
    await flush();
    for (let i = 0; i < 40; i++) {
      realm.observers[0]!.cb();
      await vi.advanceTimersByTimeAsync(751);
    }
    const done = realm.sent.filter((m) => m.done === true);
    expect(done.length).toBe(1);
    expect(realm.sent.length).toBeLessThanOrEqual(26);
    expect(realm.observers[0]!.disconnected).toBeGreaterThanOrEqual(1);
  });

  it("pagehide sends the final done report", async () => {
    const realm = makeRealm([{ classes: ["a"], id: "b" }], () => ({ ok: true, styles: "" }));
    applyCosmeticPage(realm.w, { s: [] });
    await flush();
    realm.domListeners["w:pagehide"]!();
    await flush();
    const done = realm.sent.filter((m) => m.done === true);
    expect(done.length).toBe(1);
    expect(done[0]!.applied).toBe(0);
  });

  it("collect bounds: 4000 elements, 512 classes, 128 ids, 128-char tokens", async () => {
    const els = [];
    for (let i = 0; i < 5000; i++) els.push({ classes: ["c" + i], id: "id" + i });
    let captured: Record<string, unknown> | null = null;
    const realm = makeRealm(els, (m) => {
      captured = m;
      return { ok: true, styles: "" };
    });
    applyCosmeticPage(realm.w, { s: [] });
    await flush();
    expect((captured!.classes as string[]).length).toBe(512);
    expect((captured!.ids as string[]).length).toBe(128);
  });

  it("a loading document defers the first query to DOMContentLoaded", async () => {
    const realm = makeRealm([{ classes: ["a"], id: "b" }], () => ({ ok: true, styles: "" }));
    (realm.w.document as { readyState: unknown }).readyState = "loading";
    applyCosmeticPage(realm.w, { s: [] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(realm.sent.length).toBe(0);
    realm.domListeners["DOMContentLoaded"]!();
    await flush();
    expect(realm.sent.length).toBe(1);
  });

  it("no controller (guest or uncontrolled document) means no token loop, no crash", async () => {
    const realm = makeRealm([{ classes: ["a"], id: "b" }], () => ({ ok: true, styles: "" }));
    ((realm.w.navigator as { serviceWorker: { controller: unknown } }).serviceWorker).controller = undefined;
    applyCosmeticPage(realm.w, { s: [{ name: "set-constant", args: ["zlQ", "3"] }] });
    await flush();
    expect(realm.w.zlQ).toBe(3);
    expect(realm.sent.length).toBe(0);
  });
});
