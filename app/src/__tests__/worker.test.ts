import { describe, expect, it } from "vitest";
import { decodePath, isWorkerDestination, setScheme } from "../codec";
import { routeWorkerImport } from "../worker-prelude";
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

describe("routeWorkerImport (1.6)", () => {
  const P = "/j/";
  const W = "https://api.site/worker.js";
  const E = "https://engine.host";

  it("routes a relative argument through the engine codec", () => {
    const out = routeWorkerImport(P, W, E, "lib.js");
    expect(out.startsWith(P)).toBe(true);
    setScheme(P);
    expect(decodePath(out)).toBe("https://api.site/lib.js");
  });

  it("routes an absolute upstream argument", () => {
    const out = routeWorkerImport(P, W, E, "https://cdn.other/x.js");
    setScheme(P);
    expect(decodePath(out)).toBe("https://cdn.other/x.js");
  });

  it("passes engine-local and opaque arguments through untouched", () => {
    expect(routeWorkerImport(P, W, E, E + "/j/abc")).toBe(E + "/j/abc");
    expect(routeWorkerImport(P, W, E, "data:text/javascript,hi")).toBe("data:text/javascript,hi");
    expect(routeWorkerImport(P, W, E, "::not a url")).toBe("::not a url");
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
    expect(swShimGet(s, "https://a.example/", "/other")).toBeUndefined();
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
    const ready = await (c.ready as Promise<{ active: unknown }>)();
    expect(ready.active).toBeTruthy();
  });
});
