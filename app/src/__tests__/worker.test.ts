import { describe, expect, it } from "vitest";
import { decodePath, encodeDest, isWorkerDestination, setScheme } from "../codec";
import { applyWorkerStorage, fireHandler, installWorkerPrelude, pickRelayPort, routeWorkerUrl } from "../worker-prelude";
import { swShimApply, swShimGet, swShimRegister } from "../swshim";

describe("worker destinations (1.6)", () => {
  it("classifies worker script loads only", () => {
    expect(isWorkerDestination("worker")).toBe(true);
    expect(isWorkerDestination("sharedworker")).toBe(true);
    expect(isWorkerDestination("script")).toBe(false);
    expect(isWorkerDestination("serviceworker")).toBe(false);
    expect(isWorkerDestination("")).toBe(false);
  });
});

describe("routeWorkerUrl (1.6: importScripts and worker fetch)", () => {
  const P = "/j/";
  const W = "https://api.site/worker.js";
  const E = "https://engine.host";

  it("routes a relative argument through the engine codec", () => {
    const out = routeWorkerUrl(P, W, E, "lib.js");
    /* #537: routed inputs come back as absolute engine URLs, so a
       blob worker realm (opaque location) can resolve them too. */
    expect(out.startsWith(E + P)).toBe(true);
    setScheme(P);
    expect(decodePath(out.slice(E.length))).toBe("https://api.site/lib.js");
  });

  it("routes an absolute upstream argument", () => {
    const out = routeWorkerUrl(P, W, E, "https://cdn.other/x.js");
    setScheme(P);
    expect(decodePath(out.slice(E.length))).toBe("https://cdn.other/x.js");
  });

  it("passes engine-local and opaque arguments through untouched", () => {
    expect(routeWorkerUrl(P, W, E, E + "/j/abc")).toBe(E + "/j/abc");
    expect(routeWorkerUrl(P, W, E, "data:text/javascript,hi")).toBe("data:text/javascript,hi");
    expect(routeWorkerUrl(P, W, E, "blob:https://engine.host/uuid")).toBe("blob:https://engine.host/uuid");
  });

  it("routes a root-relative worker fetch input against the worker URL (issue #4)", () => {
    const out = routeWorkerUrl(P, W, E, "/data.json");
    setScheme(P);
    expect(decodePath(out.slice(E.length))).toBe("https://api.site/data.json");
  });

  it("routes a relative worker fetch input against the worker script directory (issue #4)", () => {
    const out = routeWorkerUrl(P, W, E, "api/data.json");
    setScheme(P);
    expect(decodePath(out.slice(E.length))).toBe("https://api.site/api/data.json");
  });

  it("installWorkerPrelude keeps the worker URL in the closure (issue #32)", () => {
    const G = globalThis as unknown as {
      __ZL_PREFIX__?: string;
      __ZL_WORKER_URL__?: string;
      importScripts?: unknown;
      fetch?: unknown;
    };
    const savedIS = G.importScripts;
    const savedFetch = G.fetch;
    const calls: string[][] = [];
    G.importScripts = (...args: string[]) => {
      calls.push(args);
    };
    G.__ZL_PREFIX__ = "/j/";
    try {
      setScheme("/j/");
      installWorkerPrelude(encodeDest("https://api.site/worker.js"));
      (globalThis as { importScripts: (...a: string[]) => void }).importScripts("lib.js");
      expect(calls.length).toBe(1);
      setScheme("/j/");
      expect(decodePath(calls[0][0])).toBe("https://api.site/lib.js");
      expect(calls[0][0].startsWith("/j/")).toBe(true);
      /* No global ever carries the upstream URL (#32). */
      expect("__ZL_WORKER_URL__" in (globalThis as Record<string, unknown>)).toBe(false);
      expect((G as Record<string, unknown>).__ZL_WORKER_URL__).toBeUndefined();
      /* Idempotent: a second init line keeps the first wiring. */
      const wrapped = (globalThis as { importScripts: unknown }).importScripts;
      installWorkerPrelude(encodeDest("https://other.site/w.js"));
      expect((globalThis as { importScripts: unknown }).importScripts).toBe(wrapped);
    } finally {
      delete G.__ZL_PREFIX__;
      if (savedIS === undefined) delete G.importScripts;
      else G.importScripts = savedIS;
      /* the prelude also wraps fetch: restore the process default; the
         module-level `installed` flag keeps later installs inert. */
      if (savedFetch !== undefined) G.fetch = savedFetch;
      setScheme("/j/");
    }
  });
});

describe("pickRelayPort (2.3 Selenide shared bridge)", () => {
  it("relays over the newest connect port", () => {
    const a = { id: 1 } as unknown as MessagePort;
    const b = { id: 2 } as unknown as MessagePort;
    expect(pickRelayPort([a])).toBe(a);
    expect(pickRelayPort([a, b])).toBe(b);
  });

  it("null with no connected port: the shim fails closed, never native", () => {
    expect(pickRelayPort<MessagePort>([])).toBeNull();
  });
});

describe("fireHandler (raw on* property parity, both ws shims)", () => {
  it("invokes the on* property with the target as this", () => {
    const t: Record<string, unknown> = {};
    const seen: unknown[] = [];
    t.onopen = function (this: unknown, e: Event) {
      seen.push(e, this);
    };
    const ev = { type: "open" } as Event;
    fireHandler(t, ev);
    expect(seen[0]).toBe(ev);
    expect(seen[1]).toBe(t);
  });

  it("contains a throwing handler", () => {
    const t: Record<string, unknown> = {};
    t.onerror = () => {
      throw new Error("boom");
    };
    expect(() => fireHandler(t, { type: "error" } as Event)).not.toThrow();
  });

  it("is a no-op without a handler", () => {
    expect(() => fireHandler({}, { type: "close" } as Event)).not.toThrow();
  });
});

describe("navigator.serviceWorker shim (1.6)", () => {
  const mkStore = () => {
    const m = new Map<string, string>();
    return {
      get: () => m.get("r") ?? null,
      set: (v: string) => void m.set("r", v),
      clear: () => void m.delete("r"),
    };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("register settles installing -> activated", async () => {
    const s = mkStore();
    const reg = swShimRegister(s, "https://a.example/page", "sw.js", { scope: "/" });
    expect(reg.scope).toBe("https://a.example/");
    expect(reg.installing?.state).toBe("installing");
    expect(reg.active).toBeNull();
    await tick();
    await tick();
    expect(reg.installing).toBeNull();
    expect(reg.active?.state).toBe("activated");
    expect(reg.active?.scriptURL).toBe("https://a.example/sw.js");
  });

  it("getRegistration returns the settled record", () => {
    const s = mkStore();
    swShimRegister(s, "https://a.example/", "sw.js");
    const reg = swShimGet(s, "https://a.example/");
    expect(reg?.active?.state).toBe("activated");
    /* getRegistration takes a client URL, not a scope: a same-origin
       path inside the registered scope matches (native behavior), a
       foreign origin never does. */
    expect(swShimGet(s, "https://a.example/", "/other")?.scope).toBe("https://a.example/");
    expect(swShimGet(s, "https://b.example/")).toBeUndefined();
  });

  it("records are per-origin isolated", () => {
    const s1 = mkStore();
    const s2 = mkStore();
    swShimRegister(s1, "https://a.example/", "sw.js");
    swShimRegister(s2, "https://b.example/", "sw.js");
    expect(swShimGet(s1, "https://a.example/")?.active?.scriptURL).toBe("https://a.example/sw.js");
    expect(swShimGet(s2, "https://a.example/")).toBeUndefined();
  });

  it("unregister clears the record", async () => {
    const s = mkStore();
    const reg = swShimRegister(s, "https://a.example/", "sw.js");
    expect(await reg.unregister()).toBe(true);
    expect(swShimGet(s, "https://a.example/")).toBeUndefined();
  });

  it("apply patches the container shape-compatibly", async () => {
    const s = mkStore();
    const c: Record<string, unknown> = {};
    swShimApply(c, s, "https://a.example/");
    const reg = await (c.register as (u: string) => Promise<{ active: unknown; installing: unknown }>)("sw.js");
    expect(reg.active ?? reg.installing).toBeTruthy();
    const got = await (c.getRegistration as (s?: string) => Promise<unknown>)();
    expect(got).toBeTruthy();
    const list = await (c.getRegistrations as () => Promise<unknown[]>)();
    expect(list.length).toBe(1);
    const ready = await (c.ready as Promise<{ active: unknown }>);
    expect(ready.active).toBeTruthy();
  });

  it("the default scope is the script directory (#473)", () => {
    const s = mkStore();
    const reg = swShimRegister(s, "https://a.example/app/page.html", "/assets/sw.js");
    expect(reg.scope).toBe("https://a.example/assets/");
    expect(swShimGet(s, "https://a.example/app/page.html", "/assets/")?.scope).toBe(
      "https://a.example/assets/",
    );
  });

  it("an explicit scope resolves against the page (#473)", () => {
    const s = mkStore();
    const reg = swShimRegister(s, "https://a.example/app/page.html", "/assets/sw.js", { scope: "../" });
    expect(reg.scope).toBe("https://a.example/");
  });

  it("a cross-origin script URL is a native-style TypeError (#474)", () => {
    const s = mkStore();
    expect(() => swShimRegister(s, "https://a.example/", "https://evil.example/sw.js")).toThrow(TypeError);
  });

  it("a lookalike scope origin is refused, not prefix-matched (#474)", () => {
    const s = mkStore();
    expect(() =>
      swShimRegister(s, "https://a.example/", "sw.js", { scope: "https://a.example.evil/" }),
    ).toThrow(TypeError);
  });

  it("a stored record scoping a foreign or lookalike origin never reads back (#474)", () => {
    const s = mkStore();
    s.set(JSON.stringify({ scriptURL: "https://a.example.evil/sw.js", scope: "https://a.example.evil/" }));
    expect(swShimGet(s, "https://a.example/")).toBeUndefined();
  });

  it("container register rejects on a cross-origin script (#474)", async () => {
    const s = mkStore();
    const c: Record<string, unknown> = {};
    swShimApply(c, s, "https://a.example/");
    await expect(
      (c.register as (u: string) => Promise<unknown>)("https://evil.example/sw.js"),
    ).rejects.toThrow(TypeError);
  });
});


describe("worker storage scoping (#171)", () => {
  it("prefixes indexedDB, caches and BroadcastChannel to the site scope", async () => {
    const idbSeen: string[] = [];
    const idb = {
      open: (n: string) => (idbSeen.push("open:" + n), { done: true }),
      deleteDatabase: (n: string) => (idbSeen.push("del:" + n), undefined),
      cmp: (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
    };
    const cacheStore: string[] = ["engine-own"];
    const caches = {
      open: (n: string) => (cacheStore.push(n), { ok: true }),
      delete: (n: string) => Promise.resolve(true),
      has: (n: string) => Promise.resolve(cacheStore.includes(n)),
      keys: () => Promise.resolve([...cacheStore]),
      match: async () => undefined,
    };
    const bcNames: string[] = [];
    class FakeBC {
      constructor(public name: string) { bcNames.push(name); }
      postMessage(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean { return true; }
      onmessage: unknown = null;
      onmessageerror: unknown = null;
    }
    const t: Record<string, unknown> = {
      indexedDB: idb,
      caches,
      BroadcastChannel: FakeBC,
    };
    applyWorkerStorage(t, "zl:site1:");
    const I = t.indexedDB as unknown as Record<string, (a: unknown, b?: unknown) => unknown>;
    I.open!("db1");
    I.deleteDatabase!("db1");
    expect(idbSeen).toEqual(["open:zl:site1:db1", "del:zl:site1:db1"]);
    const C = t.caches as unknown as {
      open: (n: string) => unknown;
      keys: () => Promise<string[]>;
    };
    C.open("c1");
    expect(await C.keys()).toEqual(["c1"]);
    const BC = t.BroadcastChannel as unknown as new (name: string) => { name: string };
    const ch = new BC("ch1");
    expect(bcNames).toEqual(["zl:site1:ch1"]);
    expect(ch.name).toBe("ch1");
  });

  it("exposes a prefix-filtered databases() view in worker realms (#555)", async () => {
    const idb = {
      open: () => ({}),
      deleteDatabase: () => undefined,
      databases: async () => [
        { name: "zl:site1:mine", version: 3 },
        { name: "zl:site2:mine", version: 1 },
        { name: "engine", version: 9 },
      ],
    };
    const t: Record<string, unknown> = { indexedDB: idb };
    applyWorkerStorage(t, "zl:site1:");
    const I = t.indexedDB as unknown as {
      databases: () => Promise<Array<{ name?: string; version?: number }>>;
    };
    expect(await I.databases()).toEqual([{ name: "mine", version: 3 }]);
  });
});

describe("swshim guest forwarding (#477 wave 3)", () => {
  const mkStore2 = (): { get(): string | null; set(v: string): void; clear(): void } => {
    let v: string | null = null;
    return { get: () => v, set: (x) => { v = x; }, clear: () => { v = null; } };
  };

  it("register forwards the canonical script/scope to the engine controller", async () => {
    const posted: unknown[] = [];
    const s = mkStore2();
    const c: Record<string, unknown> = {
      controller: { postMessage: (m: unknown) => posted.push(m) },
    };
    swShimApply(c, s, "https://a.example/");
    await (c.register as (u: string, o?: { scope?: string }) => Promise<unknown>)("/sw.js", { scope: "/" });
    expect(posted).toEqual([
      { type: "zl:guestRegister", scriptURL: "https://a.example/sw.js", scope: "https://a.example/" },
    ]);
  });

  it("a cross-origin register still rejects and never forwards (#474)", async () => {
    const posted: unknown[] = [];
    const s = mkStore2();
    const c: Record<string, unknown> = {
      controller: { postMessage: (m: unknown) => posted.push(m) },
    };
    swShimApply(c, s, "https://a.example/");
    await expect(
      (c.register as (u: string) => Promise<unknown>)("https://evil.example/sw.js"),
    ).rejects.toThrow(TypeError);
    expect(posted).toEqual([]);
  });

  it("unregister forwards after the register forward", async () => {
    const posted: unknown[] = [];
    const s = mkStore2();
    const c: Record<string, unknown> = {
      controller: { postMessage: (m: unknown) => posted.push(m) },
    };
    swShimApply(c, s, "https://a.example/");
    const reg = await (
      c.register as (u: string) => Promise<{ unregister(): Promise<boolean> }>
    )("/sw.js");
    expect(await reg.unregister()).toBe(true);
    expect(posted).toEqual([
      { type: "zl:guestRegister", scriptURL: "https://a.example/sw.js", scope: "https://a.example/" },
      { type: "zl:guestUnregister", scriptURL: "https://a.example/sw.js", scope: "https://a.example/" },
    ]);
  });

  it("no controller leaves the virtual semantics unchanged", async () => {
    const s = mkStore2();
    const c: Record<string, unknown> = {};
    swShimApply(c, s, "https://a.example/");
    const reg = await (
      c.register as (u: string) => Promise<{ active: unknown; installing: unknown }>
    )("/sw.js");
    expect(reg.active ?? reg.installing).toBeTruthy();
  });
});
