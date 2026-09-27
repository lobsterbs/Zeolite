import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { ExtensionManager } from "../manager";
import { MGMT } from "../management";
import type { ManagementInfo } from "../management";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", permissions }))],
  ]);
}

async function apiFor(name: string, permissions: string[], m: ExtensionManager) {
  const { id } = await m.installFiles(pkg(name, permissions));
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

describe("browser.management", () => {
  let m: ExtensionManager;
  beforeEach(async () => {
    MGMT.resetForTests();
    m = new ExtensionManager();
    await m.startup();
  });

  it("getSelf works without the management permission", async () => {
    const { id, api } = await apiFor("MgSelf", [], m);
    const mgmt = (api.browser as Record<string, any>).management;
    const self: ManagementInfo = await mgmt.getSelf();
    expect(self.id).toBe(id);
    expect(self.type).toBe("extension");
    expect(self.enabled).toBe(true);
  });

  it("get/getAll/setEnabled/uninstall require the permission", async () => {
    const { id, api } = await apiFor("MgBare", [], m);
    const mgmt = (api.browser as Record<string, any>).management;
    await expect(mgmt.get(id)).rejects.toThrow(/management/);
    await expect(mgmt.getAll()).rejects.toThrow(/management/);
    await expect(mgmt.setEnabled(id, false)).rejects.toThrow(/management/);
    await expect(mgmt.uninstall(id)).rejects.toThrow(/management/);
  });

  it("full surface with the permission, plus lifecycle events", async () => {
    MGMT.wire(m);
    const a = await apiFor("MgAdmin", ["management"], m);
    const b = await apiFor("MgTarget", [], m);
    const mgmt = (a.api.browser as Record<string, any>).management;
    const all: ManagementInfo[] = await mgmt.getAll();
    expect(all.map((i) => i.name).sort()).toEqual(["MgAdmin", "MgTarget"]);
    const got: ManagementInfo = await mgmt.get(b.id);
    expect(got.name).toBe("MgTarget");
    const disabled: ManagementInfo[] = [];
    const uninstalled: ManagementInfo[] = [];
    mgmt.onDisabled.addListener((i: ManagementInfo) => disabled.push(i));
    mgmt.onUninstalled.addListener((i: ManagementInfo) => uninstalled.push(i));
    await mgmt.setEnabled(b.id, false);
    await mgmt.setEnabled(b.id, true);
    await mgmt.uninstall(b.id);
    expect(disabled.map((i) => i.id)).toEqual([b.id]);
    expect(uninstalled.map((i) => i.id)).toEqual([b.id]);
    await expect(mgmt.get(b.id)).rejects.toThrow(/no such extension/);
  });

  it("uninstallSelf needs no permission", async () => {
    const { id, api } = await apiFor("MgBye", [], m);
    const mgmt = (api.browser as Record<string, any>).management;
    await mgmt.uninstallSelf();
    expect(m.get(id)).toBeUndefined();
  });
});
