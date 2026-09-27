import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { WEBNAV } from "../webnavigation";
import type { NavigationCommitted } from "../webnavigation";
import { TABS } from "../tabs";
import type { UiTab } from "../tabs";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
}

function tab(id: number, url: string, extra: Partial<UiTab> = {}): UiTab {
  return { id, index: id, url, title: "t" + id, active: false, ...extra };
}

async function apiFor(name: string, permissions: string[]) {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(pkg(name, permissions));
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(rec, { extensionId: id, context: "background", url: null }, { messenger: new ExtensionMessenger(), storage });
  return { id, api };
}

describe("NavigationRegistry", () => {
  it("reports committed navigations for known tabs only", () => {
    TABS.setDispatch(() => undefined);
    TABS.syncFromUi([tab(1, "https://example.com/", { active: true })]);
    const seen: NavigationCommitted[] = [];
    const off = WEBNAV.subscribe((info) => seen.push(info));
    WEBNAV.committed("https://example.com/");
    expect(seen[0]).toMatchObject({ tabId: 1, url: "https://example.com/", frameId: 0 });
    WEBNAV.committed("https://unknown.example/");
    expect(seen).toHaveLength(1);
    off();
    WEBNAV.committed("https://example.com/");
    expect(seen).toHaveLength(1);
  });

  it("isolates listener errors", () => {
    TABS.syncFromUi([tab(2, "https://a.example/", { active: true })]);
    const good: NavigationCommitted[] = [];
    WEBNAV.subscribe(() => {
      throw new Error("boom");
    });
    WEBNAV.subscribe((info) => good.push(info));
    WEBNAV.committed("https://a.example/");
    expect(good).toHaveLength(1);
  });
});

describe("browser.webNavigation (buildApi)", () => {
  it("onCommitted is permission-gated", async () => {
    TABS.setDispatch(() => undefined);
    TABS.syncFromUi([tab(10, "https://example.com/", { active: true })]);
    const withPerm = await apiFor("NavPerm", ["webNavigation"]);
    const bare = await apiFor("NavBare", []);
    const nav = withPerm.api.browser.webNavigation as Record<string, unknown>;
    const navBare = bare.api.browser.webNavigation as Record<string, unknown>;
    const seenPerm: NavigationCommitted[] = [];
    const seenBare: NavigationCommitted[] = [];
    const add = (ns: Record<string, unknown>, out: NavigationCommitted[]) =>
      ((ns.onCommitted as { addListener: (l: (i: NavigationCommitted) => void) => void }).addListener)((i) => out.push(i));
    const ns = nav.onCommitted as {
      addListener: (l: (i: NavigationCommitted) => void) => void;
      removeListener: (l: (i: NavigationCommitted) => void) => void;
      hasListener: (l: (i: NavigationCommitted) => void) => boolean;
    };
    const listener = (i: NavigationCommitted) => seenPerm.push(i);
    ns.addListener(listener);
    add(navBare, seenBare);
    WEBNAV.committed("https://example.com/");
    expect(seenPerm[0]).toMatchObject({ tabId: 10 });
    expect(seenBare).toHaveLength(0);
    WEBNAV.committed("https://example.com/");
    expect(seenPerm).toHaveLength(2);
    ns.removeListener(listener);
    expect(ns.hasListener(listener)).toBe(false);
    WEBNAV.committed("https://example.com/");
    expect(seenPerm).toHaveLength(2);
  });
});

describe("webNavigation url filters + DOMContentLoaded", () => {
  it("applies listener url filters at delivery", () => {
    TABS.setDispatch(() => undefined);
    TABS.syncFromUi([tab(20, "https://match.example/", { active: true })]);
    const seen: NavigationCommitted[] = [];
    const off = WEBNAV.subscribeKind("committed", (i) => seen.push(i), ["*://match.example/*"]);
    const offNo = WEBNAV.subscribeKind("committed", (i) => seen.push(i), ["*://other.example/*"]);
    WEBNAV.committed("https://match.example/");
    expect(seen).toHaveLength(1);
    off();
    offNo();
  });

  it("domContentLoaded fires for known tabs only", () => {
    TABS.syncFromUi([tab(21, "https://dom.example/", { active: true })]);
    const seen: NavigationCommitted[] = [];
    const off = WEBNAV.subscribeKind("domcontentloaded", (i) => seen.push(i));
    WEBNAV.domContentLoaded("https://dom.example/");
    expect(seen[0]).toMatchObject({ tabId: 21, url: "https://dom.example/" });
    WEBNAV.domContentLoaded("https://unknown.example/");
    expect(seen).toHaveLength(1);
    off();
  });

  it("onDOMContentLoaded is exposed and filter-capable at the API layer", async () => {
    const withPerm = await apiFor("NavDom", ["webNavigation"]);
    const nav = (withPerm.api.browser as Record<string, any>).webNavigation;
    expect(typeof nav.onDOMContentLoaded.addListener).toBe("function");
    TABS.syncFromUi([tab(22, "https://api.example/", { active: true })]);
    const seen: NavigationCommitted[] = [];
    nav.onDOMContentLoaded.addListener((i: NavigationCommitted) => seen.push(i), { urls: ["*://api.example/*"] });
    WEBNAV.domContentLoaded("https://api.example/");
    WEBNAV.domContentLoaded("https://nomatch.example/");
    expect(seen).toHaveLength(1);
  });
});
