import { describe, expect, it, vi } from "vitest";

/* #394: the jar profile map is worker memory that an idle restart
   wipes. persistJarProfiles writes the profile state into the Cache
   API and jarProfilesReady restores it in a fresh worker instance
   before the first proxied request. Two dynamic imports over a
   resetModules boundary simulate the restart; the stubbed caches
   carry the state across. The mock stores body text and serves a
   FRESH Response per read: a real Cache does the same, and a
   Response body is one-shot. */

const store = new Map<string, string>();
vi.stubGlobal("caches", {
  open: async () => ({
    match: async (k: Request | string) => {
      const t = store.get(typeof k === "string" ? k : k.url);
      return t === undefined ? null : new Response(t);
    },
    put: async (k: Request | string, v: Response) => {
      store.set(typeof k === "string" ? k : k.url, await v.text());
    },
  }),
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("jar profile persistence (#394)", () => {
  it("restores the global profile after an idle restart", async () => {
    vi.resetModules();
    const c1 = await import("../cookies");
    c1.cookiesResetForTests();
    expect(c1.setJarProfile("sess1").profile).toBe("sess1");
    await settle();
    expect(store.get("profiles")).toContain("sess1");
    vi.resetModules();
    const c2 = await import("../cookies");
    await c2.jarProfilesReady();
    expect(c2.jarProfileState()).toBe("sess1");
    expect(c2.anySessionProfileActive()).toBe(true);
    c2.cookiesResetForTests();
    store.clear();
  });

  it("restores root-bound profiles; the client binding stays memory-only", async () => {
    vi.resetModules();
    const c1 = await import("../cookies");
    c1.cookiesResetForTests();
    expect(c1.setJarProfile("sess2", "clientA").profile).toBe("sess2");
    await settle();
    vi.resetModules();
    const c2 = await import("../cookies");
    await c2.jarProfilesReady();
    expect(c2.anySessionProfileActive()).toBe(true);
    c2.cookiesResetForTests();
    store.clear();
  });
});
