import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

it("serializes profile persistence while the first write stalls (#471)", async () => {
  vi.resetModules();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = [];
  vi.stubGlobal("caches", { open: async () => ({
    match: async () => undefined,
    put: async (_key: string, value: Response) => {
      writes.push(await value.text());
      if (writes.length === 1) await gate;
    },
  }) });
  const c = await import("../cookies");
  c.setJarProfile("first", "host");
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  c.setJarProfile("second", "host");
  await tick();
  expect(writes).toHaveLength(1);
  release();
  await vi.waitFor(() => expect(writes).toHaveLength(2));
  expect(JSON.parse(writes[1]).roots.host).toBe("second");
  c.cookiesResetForTests();
});

it.each(["open", "match", "json", "shape"])("keeps unbound clients cookie-free when restore fails at %s (#471)", async failure => {
  vi.resetModules();
  vi.stubGlobal("caches", { open: async () => {
    if (failure === "open") throw new Error("unavailable");
    return {
      match: async () => {
        if (failure === "match") throw new Error("unreadable");
        return new Response(failure === "json" ? "invalid json" : '{"profile":"default","roots":{"host":null}}');
      },
      put: async () => {},
    };
  } });
  const c = await import("../cookies");
  c.documentCookieWrite("https://a.example/", "durable=1; Path=/");
  await c.jarProfilesReady();
  expect(c.cookieHeaderFor("https://a.example/", { clientId: "old-frame" })).toBeNull();
  c.documentCookieWrite("https://a.example/", "private=2; Path=/", "old-frame");
  c.setJarProfile(null, "host");
  c.inheritJarClient("host", "new-frame");
  expect(c.cookieHeaderFor("https://a.example/", { clientId: "new-frame" })).toBe("durable=1");
  expect(c.cookieHeaderFor("https://a.example/", { clientId: "old-frame" })).toBeNull();
  await tick();
  c.cookiesResetForTests();
});

it("merges a slow restore without overwriting a fresh assignment or erasing another root (#471)", async () => {
  vi.resetModules();
  let release!: (value: Response) => void;
  const stored = new Promise<Response>(resolve => { release = resolve; });
  const writes: string[] = [];
  vi.stubGlobal("caches", { open: async () => ({
    match: async () => stored,
    put: async (_key: string, value: Response) => { writes.push(await value.text()); },
  }) });
  const c = await import("../cookies");
  const ready = c.jarProfilesReady();
  c.setJarProfile(null, "host");
  release(new Response(JSON.stringify({ profile: "default", roots: { host: "old-private", other: "other-private" } })));
  await ready;
  expect(c.jarProfileState("host")).toBe("default");
  expect(c.jarProfileState("other")).toBe("other-private");
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  expect(JSON.parse(writes[0]).roots).toEqual({ host: "default", other: "other-private" });
  c.cookiesResetForTests();
});

it("preserves unknown-profile denial across a subsequent successful save and restart (#471)", async () => {
  vi.resetModules();
  let unreadable = true;
  let stored: string | undefined;
  vi.stubGlobal("caches", { open: async () => ({
    match: async () => {
      if (unreadable) throw new Error("temporary failure");
      return stored ? new Response(stored) : undefined;
    },
    put: async (_key: string, value: Response) => { stored = await value.text(); },
  }) });
  const first = await import("../cookies");
  await first.jarProfilesReady();
  unreadable = false;
  first.setJarProfile(null, "rebound-host");
  await vi.waitFor(() => expect(stored).toBeDefined());
  vi.resetModules();
  const second = await import("../cookies");
  await second.jarProfilesReady();
  expect(second.jarProfileState("unbound-old-frame")).not.toBe("default");
  expect(second.jarProfileState("rebound-host")).toBe("default");
  second.cookiesResetForTests();
});
