import { describe, expect, it, vi } from "vitest";

/* #471: the persisted profile record is versioned; a corrupt or
   future-version record fails the restore CLOSED (session clients
   never ride the global jar afterwards), and profile persistence is a
   serialized chain so two quick switches cannot persist a stale
   snapshot. Mirrors the jar-profile-persist.test.ts stubbing idiom. */

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

describe("jar profile restore fail-closed (#471)", () => {
  it("keeps the last of two quick profile switches (serialized persist)", async () => {
    vi.resetModules();
    const c1 = await import("../cookies");
    c1.cookiesResetForTests();
    expect(c1.setJarProfile("first").profile).toBe("first");
    expect(c1.setJarProfile("second").profile).toBe("second");
    await c1.jarProfilePersistDrain();
    const rec = store.get("profiles") ?? "";
    expect(rec).toContain("second");
    expect(rec).not.toContain("first");
    expect((JSON.parse(rec) as { v?: number }).v).toBe(1);
    c1.cookiesResetForTests();
    store.clear();
  });

  it("fails closed for unbound clients when the stored record is corrupt", async () => {
    store.set("profiles", "{broken");
    vi.resetModules();
    const c = await import("../cookies");
    await c.jarProfilesReady();
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    expect(c.applySetCookie("https://s.example/", h, "clientB")).toEqual([]);
    expect(c.cookieHeaderFor("https://s.example/", { clientId: "clientB" })).toBeNull();
    /* a profile push re-binds the client and restores normal service */
    expect(c.setJarProfile("sess", "clientB").profile).toBe("sess");
    expect(c.applySetCookie("https://s.example/", h, "clientB").length).toBeGreaterThan(0);
    expect(c.cookieHeaderFor("https://s.example/", { clientId: "clientB" })).toContain("a=1");
    c.cookiesResetForTests();
    store.clear();
  });

  it("fails closed on a future-version record", async () => {
    store.set("profiles", JSON.stringify({ v: 99, profile: "evil", roots: {} }));
    vi.resetModules();
    const c = await import("../cookies");
    await c.jarProfilesReady();
    expect(c.jarProfileState()).toBe("default");
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    expect(c.applySetCookie("https://s.example/", h, "clientB")).toEqual([]);
    expect(c.cookieHeaderFor("https://s.example/", { clientId: "clientB" })).toBeNull();
    c.cookiesResetForTests();
    store.clear();
  });
});
