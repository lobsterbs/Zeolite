import { afterEach, describe, expect, it, vi } from "vitest";
import { applyReemit, mintRoute } from "../bootstrap/mint";
import { mintUrlViaRelay } from "../worker-prelude";

/* #54 residuals 2-3: the page-realm mint client and the re-emission
   patch. fakeWindow carries the four seams (fetch, sendBeacon, XHR,
   EventSource); a stubbed controller answers zl:mint. Destinations
   are unique per test: the module-level memo must not leak routes
   across tests. */

const LOC = "https://engine.host/j/abc";
const ORIGIN = "https://engine.host";

function stubMint(route: string, log?: string[]) {
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage(m: unknown, ports?: MessagePort[]) {
          log?.push("post");
          queueMicrotask(() => ports?.[0]?.postMessage({ ok: true, route }));
        },
      },
    },
  });
}

function stubRefusal() {
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage(m: unknown, ports?: MessagePort[]) {
          queueMicrotask(() => ports?.[0]?.postMessage({ ok: false, error: "no" }));
        },
      },
    },
  });
}

function fakeWindow() {
  const calls: Array<{ input: unknown; init?: unknown }> = [];
  const beacons: Array<{ url: unknown; data?: unknown }> = [];
  const xhrLog: string[] = [];
  const esMade: Array<Record<string, any>> = [];
  const w: Record<string, any> = {
    location: { href: LOC, origin: ORIGIN },
    fetch(input: unknown, init?: unknown) {
      calls.push({ input, init });
      return Promise.resolve({ ok: true });
    },
    navigator: {},
    XMLHttpRequest: class FakeXHR {
      open(...a: unknown[]) {
        xhrLog.push(
          "open:" +
            String(a[0]) +
            "|" +
            String(a[1]) +
            "|" +
            String(a[2] ?? null) +
            "|" +
            String(a[3] ?? null) +
            "|" +
            String(a[4] ?? null),
        );
      }
      setRequestHeader(k: unknown, v: unknown) {
        xhrLog.push("hdr:" + String(k) + ":" + String(v));
      }
      send() {
        xhrLog.push("send");
      }
    },
    EventSource: class FakeES {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      url: string;
      constructor(url: string, o?: unknown) {
        this.url = url;
        esMade.push(this as unknown as Record<string, any>);
      }
    },
  };
  w.navigator.sendBeacon = (url: unknown, data?: unknown) => {
    beacons.push({ url, data });
    return true;
  };
  return { w, calls, beacons, xhrLog, esMade };
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mintRoute client (#54 seam consumer)", () => {
  it("resolves the route and memoizes per destination", async () => {
    const posts: string[] = [];
    stubMint("/j/r1", posts);
    const d = "https://memo.example/x?t=1";
    expect(await mintRoute(d)).toBe("/j/r1");
    expect(await mintRoute(d)).toBe("/j/r1");
    expect(posts.length).toBe(1); /* the second call hit the memo */
  });

  it("resolves null without a controller, and a retry after one lands succeeds", async () => {
    const d = "https://retry.example/x?t=2";
    expect(await mintRoute(d)).toBeNull(); /* no serviceWorker in the test realm */
    stubMint("/j/r2");
    expect(await mintRoute(d)).toBe("/j/r2"); /* null was deleted from the memo */
  });

  it("resolves null when the engine refuses", async () => {
    stubRefusal();
    expect(await mintRoute("https://refused.example/x?t=3")).toBeNull();
  });
});

describe("re-emission seams (#54 residual 2)", () => {
  it("stays inert without a window location", () => {
    expect(() => applyReemit({})).not.toThrow();
  });

  it("re-emits a cross-origin fetch through the minted route", async () => {
    stubMint("/j/f1");
    const e = fakeWindow();
    applyReemit(e.w);
    await e.w.fetch("https://api.example/data?t=4");
    expect(e.calls.length).toBe(1);
    expect(e.calls[0].input).toBe("/j/f1");
  });

  it("falls back to the plaintext URL when the mint is refused", async () => {
    stubRefusal();
    const e = fakeWindow();
    applyReemit(e.w);
    const url = "https://api.example/data?t=5";
    await e.w.fetch(url);
    expect(e.calls[0].input).toBe(url); /* the engine still intercepts it */
  });

  it("leaves relative, engine-origin, opaque and Request inputs native", async () => {
    stubMint("/j/f2");
    const e = fakeWindow();
    applyReemit(e.w);
    await e.w.fetch("/local");
    await e.w.fetch("https://engine.host/j/x");
    await e.w.fetch("data:text/plain,hi");
    const req = new Request("https://cross.example/one-shot");
    await e.w.fetch(req);
    expect(e.calls.map((c) => c.input)).toEqual([
      "/local",
      "https://engine.host/j/x",
      "data:text/plain,hi",
      req,
    ]);
  });

  it("sendBeacon returns true optimistically and posts on the minted route", async () => {
    stubMint("/j/b1");
    const e = fakeWindow();
    applyReemit(e.w);
    expect(e.w.navigator.sendBeacon("https://beacon.example/b?t=6", "hi")).toBe(true);
    expect(e.beacons.length).toBe(0); /* nothing went native */
    await settle();
    expect(e.calls.length).toBe(1);
    expect(e.calls[0].input).toBe("/j/b1");
    expect(e.calls[0].init).toEqual({ method: "POST", body: "hi", keepalive: true });
  });

  it("sendBeacon falls back to the native beacon when the mint is refused", async () => {
    stubRefusal();
    const e = fakeWindow();
    applyReemit(e.w);
    const url = "https://beacon.example/b?t=7";
    expect(e.w.navigator.sendBeacon(url, "hi")).toBe(true);
    await settle();
    expect(e.beacons).toEqual([{ url, data: "hi" }]);
  });

  it("sendBeacon stays native for engine-local URLs", () => {
    stubMint("/j/b2");
    const e = fakeWindow();
    applyReemit(e.w);
    e.w.navigator.sendBeacon("/local", "x");
    expect(e.beacons).toEqual([{ url: "/local", data: "x" }]);
  });

  it("defers an async cross-origin XHR onto the minted route", async () => {
    stubMint("/j/x1");
    const e = fakeWindow();
    applyReemit(e.w);
    const x = new e.w.XMLHttpRequest();
    x.open("GET", "https://xhr.example/api?t=8", true);
    x.setRequestHeader("X-A", "1");
    expect(x.readyState).toBe(1); /* OPENED: native open() parity while the mint is pending */
    expect(e.xhrLog).toEqual([]); /* nothing native yet */
    x.send();
    await settle();
    expect(e.xhrLog).toEqual(["open:GET|/j/x1|true|null|null", "hdr:X-A:1", "send"]);
  });

  it("abort() cancels a pending re-emit: nothing native ever opens", async () => {
    stubMint("/j/x2");
    const e = fakeWindow();
    applyReemit(e.w);
    const x = new e.w.XMLHttpRequest();
    x.open("GET", "https://xhr.example/api?t=15", true);
    expect(x.readyState).toBe(1);
    x.abort();
    expect(Object.prototype.hasOwnProperty.call(x, "readyState")).toBe(false); /* the own OPENED patch is gone */
    await settle();
    expect(e.xhrLog).toEqual([]); /* the mint resolved into a canceled re-emit */
  });

  it("keeps sync and engine-local XHRs on the native path", () => {
    const e = fakeWindow();
    applyReemit(e.w);
    const a = new e.w.XMLHttpRequest();
    a.open("GET", "https://xhr.example/api?t=9", false); /* sync: documented residual */
    a.send();
    const b = new e.w.XMLHttpRequest();
    b.open("GET", "/local", true);
    b.send();
    expect(e.xhrLog).toEqual([
      "open:GET|https://xhr.example/api?t=9|false|null|null",
      "send",
      "open:GET|/local|true|null|null",
      "send",
    ]);
  });

  it("constructs an EventSource on the minted route and forwards handlers", async () => {
    stubMint("/j/e1");
    const e = fakeWindow();
    applyReemit(e.w);
    const es = new e.w.EventSource("https://sse.example/stream?t=10");
    expect(es instanceof e.w.EventSource).toBe(true); /* SHIM.prototype is the real prototype */
    expect(e.esMade.length).toBe(0); /* deferred: no request yet */
    await settle();
    expect(e.esMade.length).toBe(1);
    expect(e.esMade[0].url).toBe("/j/e1");
    const seen: unknown[] = [];
    es.onmessage = (ev: unknown) => seen.push(ev);
    e.esMade[0].onmessage?.({ type: "message", data: "hi" });
    expect(seen).toEqual([{ type: "message", data: "hi" }]);
  });

  it("constructs nothing when close() beats the mint", async () => {
    stubMint("/j/e2");
    const e = fakeWindow();
    applyReemit(e.w);
    const es = new e.w.EventSource("https://sse.example/stream?t=11");
    es.close();
    expect(es.readyState).toBe(2); /* CLOSED: no request was ever made */
    await settle();
    expect(e.esMade.length).toBe(0);
  });

  it("constructs same-origin sources immediately", () => {
    stubMint("/j/e3");
    const e = fakeWindow();
    applyReemit(e.w);
    const es = new e.w.EventSource(LOC);
    expect(e.esMade.length).toBe(1);
    expect(e.esMade[0].url).toBe(LOC);
  });
});

describe("worker mint relay (#54 residual 5)", () => {
  it("resolves the route over a relay post", async () => {
    const post = (m: unknown, tr?: Transferable[]) => {
      (tr?.[0] as MessagePort).postMessage({ ok: true, route: "/j/w1" });
      return true;
    };
    expect(await mintUrlViaRelay(post, "https://worker.example/x?t=12")).toBe("/j/w1");
  });

  it("resolves null with no relay post", async () => {
    expect(await mintUrlViaRelay(null, "https://worker.example/x?t=13")).toBeNull();
  });

  it("times out a silent relay", async () => {
    const post = () => true;
    expect(await mintUrlViaRelay(post, "https://worker.example/x?t=14", 20)).toBeNull();
  });
});
