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
  setBrowsingDataDownloadClear,
  setBrowsingDataGuestTerminator,
} from "../browsingdata";
import { DOWNLOADS } from "../downloads";
import type { ExtensionRecord } from "../types";
import { siteToken } from "../../pageload";
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

/* #593: virtual-site IndexedDB fixture helpers over fake-indexeddb. */
async function makeDb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => undefined;
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? "").filter(Boolean);
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
    setBrowsingDataDownloadClear(null);
    setBrowsingDataGuestTerminator(null);
    DOWNLOADS.resetForTests();
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
    /* #593: the worker-reachable stores answer true; the indexedDB
       boolean is the honest runtime capability check and
       fake-indexeddb provides databases(). */
    expect(s.dataTypes.downloads).toBe(true);
    expect(s.dataTypes.history).toBe(false);
    expect(s.dataTypes.localStorage).toBe(false);
    expect(s.dataTypes.indexedDB).toBe(true);
    expect(s.dataTypes.serviceWorkers).toBe(true);
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

  it("the host-browser-owned types mount and reject with the reason, clearing nothing", async () => {
    seed();
    const { api } = await apiFor(m, ["browsingData"]);
    const ns = (api.browser as Record<string, any>).browsingData;
    for (const k of [
      "removeFormData", "removeHistory",
      "removeLocalStorage", "removePasswords", "removePluginData",
    ]) {
      await expect(ns[k]()).rejects.toThrow(/worker cannot reach/);
    }
    /* #593: the engine-side stores reject honestly when the host never
       wired their clears, naming the missing wiring. */
    await expect(ns.removeDownloads()).rejects.toThrow(/no download registry attached/);
    await expect(ns.removeServiceWorkers()).rejects.toThrow(/no guest kernel attached/);
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

  it("removeDownloads clears the ring through the wired hook and drops terminal handoffs (#593)", async () => {
    const calls: Array<{ origins?: string[]; since?: number }> = [];
    setBrowsingDataDownloadClear((filter) => {
      calls.push(filter);
      return 2;
    });
    DOWNLOADS.setDispatch(() => undefined);
    const rec = { id: "ext-bd", permissions: ["downloads"] } as unknown as ExtensionRecord;
    const done = await DOWNLOADS.download(rec, { url: "https://x.test/a" });
    const live = await DOWNLOADS.download(rec, { url: "https://x.test/b" });
    DOWNLOADS.applyState(done, "done");
    const { api } = await apiFor(m, ["browsingData"]);
    const ns = (api.browser as Record<string, any>).browsingData;
    await ns.removeDownloads();
    expect(calls).toEqual([{}]);
    /* the handoff registry kept the active handoff and dropped the done one */
    const left = DOWNLOADS.search(rec);
    expect(left.map((s) => s.id)).toEqual([live]);
    expect(left[0].status).toBe("active");
    /* the origins/since filters pass through to the wired ring clear */
    await ns.removeDownloads({ origins: ["https://a.example/"], since: 5 });
    expect(calls[1]).toEqual({ origins: ["https://a.example/"], since: 5 });
  });

  it("removeServiceWorkers terminates guests through the wired hook (#593)", async () => {
    const term = vi.fn(() => 3);
    setBrowsingDataGuestTerminator(term);
    const { api } = await apiFor(m, ["browsingData"]);
    await (api.browser as Record<string, any>).browsingData.removeServiceWorkers();
    expect(term).toHaveBeenCalledTimes(1);
  });

  it("removeIndexedDB clears the zl: partition and never engine-own databases (#593)", async () => {
    const tokA = "zl:" + siteToken("https://a.example") + ":";
    const tokB = "zl:" + siteToken("https://b.example") + ":";
    await makeDb(tokA + "db1");
    await makeDb(tokB + "db2");
    await makeDb("plain-db");
    const { api } = await apiFor(m, ["browsingData"]); /* startup opened zl-extensions */
    await (api.browser as Record<string, any>).browsingData.removeIndexedDB();
    const names = await dbNames();
    expect(names).not.toContain(tokA + "db1");
    expect(names).not.toContain(tokB + "db2");
    /* the colon in the prefix is the safety line: the engine's own
       zl-extensions database (and any non-partition name) survives */
    expect(names).toContain("zl-extensions");
    expect(names).toContain("plain-db");
  });

  it("removeIndexedDB honors the origins filter through the site token (#593)", async () => {
    const tokA = "zl:" + siteToken("https://a.example") + ":";
    const tokB = "zl:" + siteToken("https://b.example") + ":";
    await makeDb(tokA + "db1");
    await makeDb(tokB + "db2");
    const { api } = await apiFor(m, ["browsingData"]);
    await (api.browser as Record<string, any>).browsingData.removeIndexedDB({ origins: ["https://a.example/"] });
    const names = await dbNames();
    expect(names).not.toContain(tokA + "db1");
    expect(names).toContain(tokB + "db2");
  });

  it("removeIndexedDB rejects honestly where databases() is absent, clearing nothing (#593)", async () => {
    const tokA = "zl:" + siteToken("https://a.example") + ":";
    await makeDb(tokA + "db1");
    const real = indexedDB;
    vi.stubGlobal("indexedDB", { deleteDatabase: real.deleteDatabase.bind(real) });
    const { api } = await apiFor(m, ["browsingData"]);
    await expect((api.browser as Record<string, any>).browsingData.removeIndexedDB()).rejects.toThrow(/databases\(\) is not available/);
    vi.unstubAllGlobals();
    expect(await dbNames()).toContain(tokA + "db1");
  });
});
