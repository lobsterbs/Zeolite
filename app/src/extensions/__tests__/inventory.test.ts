import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { buildInventory, isEventObject, NAMESPACE_COMPAT } from "../inventory";
import { COMPAT } from "../compat";

const enc = new TextEncoder();

const ALL_NS_PERMISSIONS = [
  "storage", "tabs", "notifications", "contextMenus", "downloads", "cookies",
  "webRequest", "webRequestBlocking", "webNavigation", "alarms", "management",
  "browsingData",
];

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", permissions }))],
  ]);
}

async function apiFor(m: ExtensionManager, permissions: string[]) {
  const { id } = await m.installFiles(pkg("Inv" + Math.random().toString(36).slice(2, 7), permissions));
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

describe("mounted-surface conformance (#516 seed)", () => {
  let m: ExtensionManager;

  const mountAll = async () => {
    m = new ExtensionManager();
    await m.startup();
    return apiFor(m, ALL_NS_PERMISSIONS);
  };

  it("every mounted namespace is documented in the compat matrix", async () => {
    const { api } = await mountAll();
    const mounted = Object.keys(api.browser as Record<string, unknown>).sort();
    const documented = Object.keys(NAMESPACE_COMPAT).sort();
    const undocumented = mounted.filter((n) => !documented.includes(n));
    expect(undocumented).toEqual([]);
  });

  it("every compat key the inventory claims really exists in COMPAT", () => {
    for (const [ns, keys] of Object.entries(NAMESPACE_COMPAT)) {
      for (const k of keys) {
        expect(COMPAT[k], `${ns} claims missing COMPAT key ${k}`).toBeTruthy();
      }
    }
  });

  it("every namespace mounts non-empty and every event object really is one", async () => {
    const { api } = await mountAll();
    const inv = buildInventory(api.browser as Record<string, unknown>);
    expect(inv.length).toBeGreaterThan(10);
    for (const ns of inv) {
      expect(ns.members.length, `namespace ${ns.name} is empty`).toBeGreaterThan(0);
      for (const mem of ns.members) {
        if (mem.kind === "event") {
          const obj = (api.browser as Record<string, any>)[ns.name][mem.name];
          expect(typeof obj.addListener, `${ns.name}.${mem.name}`).toBe("function");
          expect(typeof obj.removeListener, `${ns.name}.${mem.name}`).toBe("function");
          expect(typeof obj.hasListener, `${ns.name}.${mem.name}`).toBe("function");
        }
      }
    }
  });

  it("the inventory shape classifies a known surface correctly", () => {
    const inv = buildInventory({
      runtime: { id: "x", getURL: () => "u", onMessage: { addListener: () => {}, removeListener: () => {}, hasListener: () => false } },
      empty: {},
    });
    const runtime = inv.find((n) => n.name === "runtime")!;
    expect(runtime.members.find((mem) => mem.name === "id")!.kind).toBe("constant");
    expect(runtime.members.find((mem) => mem.name === "getURL")!.kind).toBe("method");
    expect(runtime.members.find((mem) => mem.name === "onMessage")!.kind).toBe("event");
    expect(inv.find((n) => n.name === "empty")!.members).toEqual([]);
  });

  it("isEventObject requires all three listener methods", () => {
    expect(isEventObject({ addListener: 1, removeListener: () => {}, hasListener: () => false })).toBe(false);
    expect(isEventObject(null)).toBe(false);
    expect(isEventObject("x")).toBe(false);
  });

  it("permission-gated namespaces stay absent without the permission", async () => {
    m = new ExtensionManager();
    await m.startup();
    const { api } = await apiFor(m, []);
    const b = api.browser as Record<string, unknown>;
    for (const ns of ["cookies", "webRequest", "notifications", "browsingData"]) {
      expect(b[ns], `${ns} mounted without its permission`).toBeUndefined();
    }
    /* The always-on namespaces still mount. */
    for (const ns of ["runtime", "tabs", "windows", "i18n", "permissions", "scripting"]) {
      expect(b[ns], `${ns} missing`).toBeTruthy();
    }
  });

  it("webRequest without webRequestBlocking still mounts, canBlock reflects the gap", async () => {
    const { api } = await mountAll();
    const wr = (api.browser as Record<string, any>).webRequest;
    expect(wr).toBeTruthy();
    expect(wr.onBeforeRequest).toBeTruthy();
  });
});
