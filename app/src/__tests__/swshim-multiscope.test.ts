import { describe, expect, it } from "vitest";
import { swShimApply, type SwShimDeps } from "../swshim";

function mkStore(): { get(): string | null; set(v: string): void; clear(): void } {
  let value: string | null = null;
  return { get: () => value, set: (v) => { value = v; }, clear: () => { value = null; } };
}

describe("virtual Service Worker registration matching", () => {
  it("stores multiple scopes, returns the most specific registration and unregisters only that scope", async () => {
    const store = mkStore();
    const c: Record<string, unknown> = {};
    const registerCalls: Record<string, unknown>[] = [];
    const unregisterCalls: Record<string, unknown>[] = [];
    const deps: SwShimDeps = {
      forwardRegister: async (payload) => { registerCalls.push(payload); return { ok: true }; },
      forwardUnregister: async (payload) => { unregisterCalls.push(payload); return { ok: true }; },
    };
    swShimApply(c, store, "https://web.example/dir/page.html", deps);
    const register = c.register as (url: string, options?: { scope?: string }) => Promise<any>;
    const getRegistration = c.getRegistration as (url?: string) => Promise<any>;
    const getRegistrations = c.getRegistrations as () => Promise<any[]>;

    const root = await register("/root-sw.js", { scope: "/" });
    const nested = await register("/app/sw.js", { scope: "/app/" });
    expect(registerCalls).toHaveLength(2);
    expect(await getRegistrations()).toHaveLength(2);
    expect((await getRegistration("https://web.example/app/page.html"))?.scope).toBe("https://web.example/app/");
    expect((await getRegistration("https://web.example/other/page.html"))?.scope).toBe("https://web.example/");

    expect(await nested.unregister()).toBe(true);
    expect(unregisterCalls).toEqual([{
      type: "zl:guestUnregister",
      scriptURL: "https://web.example/app/sw.js",
      scope: "https://web.example/app/",
    }]);
    expect(await getRegistrations()).toHaveLength(1);
    expect((await getRegistration("https://web.example/app/page.html"))?.scope).toBe("https://web.example/");
    expect(await root.unregister()).toBe(true);
    expect(await getRegistrations()).toHaveLength(0);
  });
});
