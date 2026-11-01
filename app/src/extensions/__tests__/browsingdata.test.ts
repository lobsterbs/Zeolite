import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import {
  browsingDataSettings,
  browsingDataUnreachable,
  purgeAllCaches,
  setBrowsingDataCacheDropper,
} from "../browsingdata";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
} from "../../cookies";

/* The jar is the REAL module instance (no mocks): the clears run
   against seeded state and the assertions read real jar lookups. */

const enc = new TextEncoder();

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", permissions }))],
  ]);
}

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

async function apiFor(m: ExtensionManager, permissions: string[]) {
  const { id } = await m.installFiles(pkg("Bd" + Math.random().toString(36).slice(2, 7), permissions));
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(
    rec,
    { extensionId: id, context: "background", url: null },
    { messenger: new ExtensionMessenger(), storage, manager: m },
  );
  return { id, api };
}

function seed(): void {
  applySetCookie("https://a.example/x", resp(["sa=1"]));
  applySetCookie("https://b.example/x", resp(["sb=1"]));
  applySetCookie("https://c.example/x", resp(["sc=1"]));
}

describe("browser.browsingData (#520 slice)", () => {
  let m: ExtensionManager;
  beforeEach(async () => {
    cookiesResetForTests();
    m = new ExtensionManager();
    await m.startup();
  });
  afterEach(() => {
    cookiesResetForTests();
    setBrowsingDataCacheDropper(null as unknown as () => Promise<void>);
    vi.unstubAllGlobals();
  });

  it("does not mount without the browsingData permission", async () => {
    const { api } = await apiFor(m, []);
    expect((api.browser as Record<string, unknown>).browsingData).toBeUndefined();
  });

  it("mounts with the permission and settings() reports the real capability booleans", async () => {
    const { api } = await apiFor(m, ["browsingData"]);
    const ns = (api.browser as Record<string, any>).browsingData;
    expect(ns).toBeTruthy();
    const s = browsingDataSettings();
    expect(s.options).toEqual({});
    expect(s.dataTypes.cache).toBe(true);
    expect(s.dataTypes.cookies).toBe(true);
    expect(s.dataTypes.history).toBe(false);
    expect(s.dataTypes.localStorage).toBe(false);
    expect(s.dataTypes.indexedDB).toBe(false);
    expect(s.dataTypes.serviceWorkers).toBe(false);
    /* Every documented remover is mounted - no TypeErrors on the
       documented surface. */
    for (const k of [
      "removeCache", "removeCookies", "removeDownloads", "removeFormData", "removeHistory",
      "removeIndexedDB", "removeLocalStorage", "removePasswords", "removePluginData", "removeServiceWorkers",
    ]) {
      expect(typeof ns[k], k).toBe("function");
    }
  });

  it("removeCache purges every CacheStorage bucket", async () => {
    const deleted: string[] = [];
    (globalThis as unknown as { caches: unknown }).caches = {
      keys: async () => ["zl-pages", "zl-profile", "other-bucket"],
      delete: async (n: string) => {
        deleted.push(n);
        return true;
      },
    };
    const { api } = await apiFor(m, ["browsingData"]);
    await (api.browser as Record<string, any>).browsingData.removeCache();
    expect(deleted.sort()).toEqual(["other-bucket", "zl-pages", "zl-profile"]);
  });

  it("removeCache rejects when CacheStorage fails instead of pretending", async () => {
    (globalThis as unknown as { caches: unknown }).caches = {
      keys: async () => {
        throw new Error("storage unavailable");
      },
      delete: async () => true,
    };
    const { api } = await apiFor(m, ["browsingData"]);
    await expect((api.browser as Record<string, any>).browsingData.removeCache()).rejects.toThrow(/storage unavailable/);
  });

  it("removeCookies with no origins clears the whole jar and drops the page cache", async () => {
    seed();
    const dropped = vi.fn(async () => undefined);
    setBrowsingDataCacheDropper(dropped);
    const { api } = await apiFor(m, ["browsingData"]);
    await (api.browser as Record<string, any>).browsingData.removeCookies({ since: 123 });
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    expect(cookieHeaderFor("https://b.example/")).toBeNull();
    expect(cookieHeaderFor("https://c.example/")).toBeNull();
    /* #179 safety: the wired page-cache dropper ran exactly once. */
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("removeCookies with an origins filter clears only the kept origins", async () => {
    seed();
    const dropped = vi.fn(async () => undefined);
    setBrowsingDataCacheDropper(dropped);
    const { api } = await apiFor(m, ["browsingData"]);
    await (api.browser as Record<string, any>).browsingData.removeCookies({
      origins: ["https://a.example/", "https://b.example/"],
      excludeOrigins: ["https://b.example/"],
    });
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    expect(cookieHeaderFor("https://b.example/")).toBe("sb=1");
    expect(cookieHeaderFor("https://c.example/")).toBe("sc=1");
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("removeCookies refuses malformed origins and excludeOrigins without origins", async () => {
    seed();
    const { api } = await apiFor(m, ["browsingData"]);
    const ns = (api.browser as Record<string, any>).browsingData;
    await expect(ns.removeCookies({ origins: ["not a url"] })).rejects.toThrow(/origins entries must be/);
    await expect(ns.removeCookies({ excludeOrigins: ["https://a.example/"] })).rejects.toThrow(/excludeOrigins requires origins/);
    /* Nothing was cleared by the refused calls. */
    expect(cookieHeaderFor("https://a.example/")).toBe("sa=1");
    expect(cookieHeaderFor("https://b.example/")).toBe("sb=1");
    expect(cookieHeaderFor("https://c.example/")).toBe("sc=1");
  });

  it("the unreachable types mount and reject with the reason, clearing nothing", async () => {
    seed();
    const { api } = await apiFor(m, ["browsingData"]);
    const ns = (api.browser as Record<string, any>).browsingData;
    for (const k of [
      "removeDownloads", "removeFormData", "removeHistory", "removeIndexedDB",
      "removeLocalStorage", "removePasswords", "removePluginData", "removeServiceWorkers",
    ]) {
      await expect(ns[k]()).rejects.toThrow(/worker cannot reach/);
    }
    expect(cookieHeaderFor("https://a.example/")).toBe("sa=1");
    expect(cookieHeaderFor("https://b.example/")).toBe("sb=1");
    expect(cookieHeaderFor("https://c.example/")).toBe("sc=1");
  });

  it("purgeAllCaches throws without any CacheStorage", async () => {
    delete (globalThis as unknown as { caches?: unknown }).caches;
    await expect(purgeAllCaches()).rejects.toThrow(/no CacheStorage/);
  });

  it("browsingDataUnreachable's message names the kind", async () => {
    await expect(browsingDataUnreachable("removeHistory")()).rejects.toThrow(/\(removeHistory\)$/);
  });
});
