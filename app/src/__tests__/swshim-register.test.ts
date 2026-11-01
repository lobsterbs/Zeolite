import { describe, expect, it } from "vitest";
import { swShimApply, type SwShimDeps } from "../swshim";

/* #576: registration is truthful end to end in the page realm.
   Rewriter-minted engine token arguments decode through the bounded
   zl:decodeRoutes oracle, the promise settles on the kernel reply
   only, and a rejected registration leaves the store untouched. */

function mkStore(): { get(): string | null; set(v: string): void; clear(): void } {
  let v: string | null = null;
  return { get: () => v, set: (x: string) => { v = x; }, clear: () => { v = null; } };
}

const ENG = "http://127.0.0.1:6002";
const PAGE = "https://web.example/dir/page.html";

/* Bounded decode oracle stand-in: only the two known tokens decode. */
function decodeStub(): (routes: string[]) => Promise<(string | null)[] | null> {
  return (routes) =>
    Promise.resolve(
      routes.map((r) => {
        if (r === ENG + "/j/tok") return "https://web.example/dir/sw.js";
        if (r === ENG + "/j/sc") return "https://web.example/dir/scope/";
        return null;
      }),
    );
}

describe("swshim truthful registration (#576)", () => {
  it("decodes engine token script and scope, then settles only on kernel ok", async () => {
    const store = mkStore();
    const c: Record<string, unknown> = {};
    const payloads: Record<string, unknown>[] = [];
    const deps: SwShimDeps = {
      engineOrigin: ENG,
      decodeRoutes: decodeStub(),
      forwardRegister: async (p) => {
        payloads.push(p);
        return { ok: true };
      },
    };
    swShimApply(c, store, () => PAGE, deps);
    const reg = (await (c.register as (u: string, o?: { scope?: string }) => Promise<{ scope: string }>)(ENG + "/j/tok", { scope: ENG + "/j/sc" }));
    expect(payloads.length).toBe(1);
    expect(payloads[0]).toEqual({
      type: "zl:guestRegister",
      scriptURL: "https://web.example/dir/sw.js",
      scope: "https://web.example/dir/scope/",
    });
    expect(reg.scope).toBe("https://web.example/dir/scope/");
    expect(store.get()).toContain("https://web.example/dir/sw.js");
  });

  it("rejects with TypeError when a token fails to decode, and stores nothing", async () => {
    const store = mkStore();
    const c: Record<string, unknown> = {};
    let forwards = 0;
    const deps: SwShimDeps = {
      engineOrigin: ENG,
      decodeRoutes: decodeStub(),
      forwardRegister: async () => {
        forwards += 1;
        return { ok: true };
      },
    };
    swShimApply(c, store, () => PAGE, deps);
    await expect(
      (c.register as (u: string) => Promise<unknown>)(ENG + "/j/unknown"),
    ).rejects.toThrowError(TypeError);
    expect(forwards).toBe(0);
    expect(store.get()).toBeNull();
  });

  it("queues an early registration behind the virtual base", async () => {
    const store = mkStore();
    const c: Record<string, unknown> = {};
    const payloads: Record<string, unknown>[] = [];
    let reads = 0;
    const deps: SwShimDeps = {
      engineOrigin: ENG,
      baseWaitMs: 500,
      decodeRoutes: decodeStub(),
      forwardRegister: async (p) => {
        payloads.push(p);
        return { ok: true };
      },
    };
    /* The base is still the raw engine route at the first read; the
       virtual-origin marker lands one read later. */
    swShimApply(c, store, () => {
      reads += 1;
      return reads < 2 ? ENG + "/dir/page.html" : PAGE;
    }, deps);
    await (c.register as (u: string) => Promise<unknown>)("sw.js");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(payloads[0]).toEqual({
      type: "zl:guestRegister",
      scriptURL: "https://web.example/dir/sw.js",
      scope: "https://web.example/dir/",
    });
  });

  it("fails closed when the base never leaves the engine origin", async () => {
    const store = mkStore();
    const c: Record<string, unknown> = {};
    let forwards = 0;
    const deps: SwShimDeps = {
      engineOrigin: ENG,
      baseWaitMs: 60,
      decodeRoutes: decodeStub(),
      forwardRegister: async () => {
        forwards += 1;
        return { ok: true };
      },
    };
    swShimApply(c, store, () => ENG + "/dir/page.html", deps);
    await expect(
      (c.register as (u: string) => Promise<unknown>)("sw.js"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(forwards).toBe(0);
    expect(store.get()).toBeNull();
    expect(await (c.getRegistration as () => Promise<unknown>)()).toBeUndefined();
  });

  it("preserves the prior record when the kernel rejects", async () => {
    const store = mkStore();
    const c: Record<string, unknown> = {};
    let ok = true;
    const deps: SwShimDeps = {
      engineOrigin: ENG,
      decodeRoutes: decodeStub(),
      forwardRegister: async () => (ok ? { ok: true } : { ok: false, error: "no guest host page connected" }),
    };
    swShimApply(c, store, () => PAGE, deps);
    await (c.register as (u: string) => Promise<unknown>)("sw.js");
    const before = store.get();
    ok = false;
    await expect(
      (c.register as (u: string) => Promise<unknown>)("sw2.js"),
    ).rejects.toThrowError("no guest host page connected");
    expect(store.get()).toBe(before);
    /* The prior registration is still readable. */
    const reg = (await (c.getRegistration as () => Promise<{ scope: string }>)()) as { scope: string };
    expect(reg.scope).toBe("https://web.example/dir/");
  });

  it("getRegistration decodes an engine token scope argument", async () => {
    const store = mkStore();
    const c: Record<string, unknown> = {};
    const deps: SwShimDeps = {
      engineOrigin: ENG,
      decodeRoutes: decodeStub(),
      forwardRegister: async () => ({ ok: true }),
    };
    swShimApply(c, store, () => PAGE, deps);
    await (c.register as (u: string, o?: { scope?: string }) => Promise<unknown>)("sw.js", { scope: ENG + "/j/sc" });
    const reg = (await (c.getRegistration as (s?: string) => Promise<{ scope: string } | undefined>)(ENG + "/j/sc")) as { scope: string } | undefined;
    expect(reg && reg.scope).toBe("https://web.example/dir/scope/");
    /* A scope that does not match the record resolves undefined. */
    expect(await (c.getRegistration as (s?: string) => Promise<unknown>)("/")).toBeUndefined();
  });
});
