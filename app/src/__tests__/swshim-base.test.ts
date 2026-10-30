import { describe, expect, it } from "vitest";
import { swShimApply } from "../swshim";

/* #538: the shim's registration basis is resolved lazily so a page's
   relative register() lands on the page's VIRTUAL URL (the kernel
   canonicalizes against the decoded page origin), not on the opaque
   engine route captured at bootstrap. */

function mkStore(): { get(): string | null; set(v: string): void; clear(): void } {
  let v: string | null = null;
  return { get: () => v, set: (x: string) => { v = x; }, clear: () => { v = null; } };
}

function container(posted: unknown[]): Record<string, unknown> {
  return { controller: { postMessage: (m: unknown) => posted.push(m) } };
}

describe("swshim lazy virtual page base (#538)", () => {
  it("resolves a relative script against the live virtual base", async () => {
    const posted: unknown[] = [];
    const c = container(posted);
    let base = "http://engine.example/j/base";
    swShimApply(c, mkStore(), () => base);
    /* Virtual origin unknown: the raw captured URL (wave-3 shape). */
    await (c.register as (u: string) => Promise<unknown>)("sw.js");
    expect(posted[0]).toEqual({
      type: "zl:guestRegister",
      scriptURL: "http://engine.example/j/sw.js",
      scope: "http://engine.example/j/",
    });
    /* The virtual-origin marker landed between the two calls. */
    base = "http://a.example/dir/page.html";
    await (c.register as (u: string) => Promise<unknown>)("sw.js");
    expect(posted[1]).toEqual({
      type: "zl:guestRegister",
      scriptURL: "http://a.example/dir/sw.js",
      scope: "http://a.example/dir/",
    });
  });

  it("fails closed when the base resolves to nothing", async () => {
    const posted: unknown[] = [];
    const c = container(posted);
    swShimApply(c, mkStore(), () => "");
    await expect(
      (c.register as (u: string) => Promise<unknown>)("sw.js"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(posted).toEqual([]);
    expect(await (c.getRegistration as () => Promise<unknown>)()).toBeUndefined();
    expect(await (c.getRegistrations as () => Promise<unknown>)()).toEqual([]);
    expect(await ((c as { ready: { then?: unknown } }).ready as Promise<unknown>)).toBeUndefined();
  });

  it("getRegistration validates the stored record against the live base", async () => {
    const posted: unknown[] = [];
    const c = container(posted);
    let base = "http://a.example/dir/page.html";
    swShimApply(c, mkStore(), () => base);
    await (c.register as (u: string) => Promise<unknown>)("sw.js");
    const reg = (await (c.getRegistration as () => Promise<unknown>)()) as { scope: string };
    expect(reg.scope).toBe("http://a.example/dir/");
    /* A base that scopes a foreign origin must not expose the record
       (#474 exact-origin defense, evaluated at call time). */
    base = "http://evil.example/dir/page.html";
    expect(await (c.getRegistration as () => Promise<unknown>)()).toBeUndefined();
  });

  it("a string base keeps the wave-3 contract unchanged", async () => {
    const posted: unknown[] = [];
    const c = container(posted);
    swShimApply(c, mkStore(), "https://a.example/");
    await (c.register as (u: string, o?: { scope?: string }) => Promise<unknown>)("/sw.js", { scope: "/" });
    expect(posted).toEqual([
      { type: "zl:guestRegister", scriptURL: "https://a.example/sw.js", scope: "https://a.example/" },
    ]);
  });
});
