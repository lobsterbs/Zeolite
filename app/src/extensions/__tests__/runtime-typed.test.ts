import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { TABS } from "../tabs";
import type { TabsOp } from "../tabs";
import { uninstallUrlOf } from "../uninstall-url";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

function pkg(name: string): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 3, name, version: "1.0" }))],
  ]);
}

async function apiFor(name: string) {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(pkg(name + Math.random().toString(36).slice(2, 7)));
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const { browser } = buildApi(rec, { extensionId: id, context: "background", url: null }, { messenger: new ExtensionMessenger(), storage });
  return { m, id, browser: browser as Record<string, Record<string, unknown>> };
}

afterEach(() => {
  TABS.setDispatch(null);
  TABS.syncFromUi([]);
});

describe("runtime requestUpdateCheck / setUninstallURL (#518)", () => {
  it("answers no_update honestly", async () => {
    const { browser } = await apiFor("UpdCheck");
    await expect(
      (browser.runtime.requestUpdateCheck as () => Promise<{ status: string }>)(),
    ).resolves.toEqual({ status: "no_update" });
  });

  it("stores, validates and clears the uninstall URL", async () => {
    const { id, browser } = await apiFor("ByeUrl");
    const set = browser.runtime.setUninstallURL as (u?: unknown) => Promise<void>;
    await set("https://bye.example/goodbye");
    expect(uninstallUrlOf(id)).toBe("https://bye.example/goodbye");
    /* The wrapper throws synchronously before any promise exists. */
    expect(() => set("chrome://nope/")).toThrow(/http\(s\)/);
    expect(uninstallUrlOf(id)).toBe("https://bye.example/goodbye");
    expect(() => set("notaurl")).toThrow(/absolute URL/);
    /* The argument schema rejects a non-string before the registry runs. */
    expect(() => set(7)).toThrow(/must be string/);
    /* Firefox's no-argument form clears the stored URL. */
    await set();
    expect(uninstallUrlOf(id)).toBeNull();
  });

  it("delivers the stored URL through the real tabs bridge at uninstall", async () => {
    const { m, id, browser } = await apiFor("ByeOp");
    TABS.setDispatch(() => undefined); /* a live host so create dispatches */
    const ops: TabsOp[] = [];
    TABS.setDispatch((op) => ops.push(op));
    await (browser.runtime.setUninstallURL as (u?: unknown) => Promise<void>)("https://bye.example/uninstalled");
    await m.uninstall(id);
    const create = ops.find((o) => o.op === "create");
    expect(create?.props).toMatchObject({ url: "https://bye.example/uninstalled" });
    /* The record is gone and the stored URL with it. */
    expect(m.get(id)).toBeNull();
    expect(uninstallUrlOf(id)).toBeNull();
  });

  it("uninstalls silently when no URL was set", async () => {
    const { m, id } = await apiFor("ByeQuiet");
    TABS.setDispatch(() => undefined);
    const ops: TabsOp[] = [];
    TABS.setDispatch((op) => ops.push(op));
    await m.uninstall(id);
    expect(ops.find((o) => o.op === "create")).toBeUndefined();
  });
});
