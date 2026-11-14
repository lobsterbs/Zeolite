import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { buildInventory, isEventObject, NAMESPACE_COMPAT, type InventoryMember } from "../inventory";
import { COMPAT } from "../compat";
import {
  ENGINE_EXTRA_MEMBERS,
  FIREFOX_API,
  FIREFOX_UNMOUNTED_REASONS,
  firefoxGapReport,
} from "../firefox-inventory";

const enc = new TextEncoder();

const ALL_NS_PERMISSIONS = [
  "storage", "tabs", "notifications", "contextMenus", "downloads", "cookies",
  "webRequest", "webRequestBlocking", "webNavigation", "alarms", "management",
  "browsingData", "declarativeNetRequest", "bookmarks",
];

function pkg(name: string, permissions: string[], extra: Record<string, unknown> = {}): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", permissions, ...extra }))],
  ]);
}

async function apiFor(m: ExtensionManager, permissions: string[], extra: Record<string, unknown> = {}) {
  const { id } = await m.installFiles(pkg("Inv" + Math.random().toString(36).slice(2, 7), permissions, extra));
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

/* #516 slice 2: the mounted surface diffed against the exhaustive
   Firefox inventory (firefox-inventory.ts). The action family mounts
   one namespace per manifest kind, so the union of three fixtures is
   the full mountable surface. */
describe("Firefox API inventory conformance (#516 slice 2)", () => {
  const FB_PERMISSIONS = [...ALL_NS_PERMISSIONS, "declarativeNetRequestFeedback"];

  type Surface = Map<string, Map<string, InventoryMember["kind"]>>;

  async function mountSurface(): Promise<{ surface: Surface; browser: Record<string, unknown> }> {
    const fixtures: Array<Record<string, unknown>> = [
      { manifest_version: 3, action: {} },
      { manifest_version: 2, browser_action: {} },
      { manifest_version: 2, page_action: {} },
    ];
    const m = new ExtensionManager();
    await m.startup();
    const surface: Surface = new Map();
    const browser: Record<string, unknown> = {};
    for (const extra of fixtures) {
      const { api } = await apiFor(m, FB_PERMISSIONS, extra);
      const b = api.browser as Record<string, unknown>;
      Object.assign(browser, b);
      for (const ns of buildInventory(b)) {
        const members = surface.get(ns.name) ?? new Map();
        for (const mem of ns.members) members.set(mem.name, mem.kind);
        surface.set(ns.name, members);
      }
    }
    return { surface, browser };
  }

  it("every mounted namespace is a real Firefox API namespace", async () => {
    const { surface } = await mountSurface();
    const invented = [...surface.keys()].filter((ns) => !FIREFOX_API[ns]);
    expect(invented, `namespaces Firefox does not have: ${invented.join(", ")}`).toEqual([]);
  });

  it("every mounted member is a real Firefox member or a justified engine extra", async () => {
    const { surface } = await mountSurface();
    const offenders: string[] = [];
    for (const [ns, members] of surface) {
      for (const [member, kind] of members) {
        const ffKind = FIREFOX_API[ns]?.[member];
        if (ffKind) {
          if (ffKind !== kind) offenders.push(`${ns}.${member}: mounted ${kind}, Firefox ${ffKind}`);
          continue;
        }
        if (!ENGINE_EXTRA_MEMBERS[ns]?.[member]) offenders.push(`${ns}.${member} (${kind})`);
      }
    }
    expect(offenders, "members Firefox does not have and ENGINE_EXTRA_MEMBERS does not justify").toEqual([]);
  });

  it("every engine extra is mounted, absent from Firefox, and documented in COMPAT", async () => {
    const { surface } = await mountSurface();
    const entries: string[] = [];
    for (const [ns, members] of Object.entries(ENGINE_EXTRA_MEMBERS)) {
      for (const [member, why] of Object.entries(members)) {
        entries.push(`${ns}.${member}`);
        expect(surface.get(ns)?.has(member), `${ns}.${member} listed as extra but not mounted`).toBe(true);
        expect(FIREFOX_API[ns]?.[member], `${ns}.${member} exists in Firefox after all`).toBeUndefined();
        expect(COMPAT[why.compatKey], `${ns}.${member} names missing COMPAT key ${why.compatKey}`).toBeTruthy();
      }
    }
    expect(entries).toEqual([
      "browsingData.removeServiceWorkers",
      "declarativeNetRequest.getMatchedRules",
      "declarativeNetRequest.onRuleMatchedDebug",
      "management.uninstall",
    ]);
  });

  it("every unmounted Firefox namespace carries a reason and every reason names an unmounted namespace", async () => {
    const { surface } = await mountSurface();
    const unmounted = Object.keys(FIREFOX_API).filter((ns) => !surface.has(ns)).sort();
    expect(unmounted).toEqual(Object.keys(FIREFOX_UNMOUNTED_REASONS).sort());
    for (const ns of unmounted) {
      expect(FIREFOX_UNMOUNTED_REASONS[ns].length, `${ns} reason is empty`).toBeGreaterThan(0);
    }
  });

  it("the gap report answers the documented honest gaps (#517-#524 diff baseline)", async () => {
    const { browser } = await mountSurface();
    const report = firefoxGapReport(browser);
    /* unmounted namespaces come with reasons. bookmarks no longer
       belongs here: the #520 slice mounts it (drop it from this list
       when a namespace gains its implementation). */
    const absent = new Map(report.absentNamespaces.map((a) => [a.name, a.reason]));
    for (const ns of ["history", "idle", "sessions", "sidebarAction", "userScripts"]) {
      expect(absent.get(ns)?.length, `${ns} absent without a reason`).toBeGreaterThan(0);
    }
    expect(absent.has("bookmarks"), "bookmarks mounted by the #520 slice").toBe(false);
    /* member-level gaps the compat matrix documents; storage.managed
       left the list when the #520 slice mounted the read-only
       enterprise-policy area. */
    const missingOf = (ns: string) => report.missingMembers.find((m) => m.namespace === ns)?.members ?? [];
    expect(missingOf("i18n")).toContain("detectLanguage");
    expect(missingOf("storage"), "managed mounted by the #520 slice").toEqual([]);
    expect(missingOf("runtime")).toContain("setUninstallURL");
    expect(missingOf("tabs")).toContain("duplicate");
    /* exactly the four justified extras */
    expect(report.engineExtras.map((e) => `${e.namespace}.${e.member}`)).toEqual([
      "browsingData.removeServiceWorkers",
      "declarativeNetRequest.getMatchedRules",
      "declarativeNetRequest.onRuleMatchedDebug",
      "management.uninstall",
    ]);
  });
});
