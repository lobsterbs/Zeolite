import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { TABS } from "../tabs";
import type { TabsOp, UiTab } from "../tabs";
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

async function tabsApi(name: string) {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(pkg(name, ["tabs"]));
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const { browser } = buildApi(rec, { extensionId: id, context: "background", url: null }, { messenger: new ExtensionMessenger(), storage });
  return browser as Record<string, Record<string, unknown>>;
}

afterEach(() => {
  TABS.setDispatch(null);
  TABS.syncFromUi([]);
});

describe("tabs typed members (#519)", () => {
  it("exposes Firefox's TAB_ID_NONE", async () => {
    const browser = await tabsApi("TabNone" + Math.random().toString(36).slice(2, 7));
    expect(browser.tabs.TAB_ID_NONE).toBe(-1);
  });

  it("duplicate opens a same-url copy through the real create seam", async () => {
    const browser = await tabsApi("TabDup" + Math.random().toString(36).slice(2, 7));
    TABS.syncFromUi([tab(10, "https://dup.example/", { active: true })]);
    const ops: TabsOp[] = [];
    TABS.setDispatch((op) => ops.push(op));
    const created: number[] = [];
    (browser.tabs.onCreated as { addListener: (l: (t: { id: number }) => void) => void }).addListener((t) => created.push(t.id));

    const dup = (browser.tabs.duplicate as (id: number, props?: unknown) => Promise<{ id: number; url: string }>)(
      10,
      { active: false },
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("create");
    expect(ops[0].props).toMatchObject({ url: "https://dup.example/", active: false });
    /* The UI acknowledges the create with a fresh tab carrying the op
       nonce, exactly like tabs.create. */
    TABS.syncFromUi([
      tab(10, "https://dup.example/", { active: true }),
      tab(11, "https://dup.example/", { nonce: ops[0].nonce }),
    ]);
    const copy = await dup;
    expect(copy).toMatchObject({ id: 11, url: "https://dup.example/" });
    expect(created).toContain(11);

    await expect(
      (browser.tabs.duplicate as (id: number) => Promise<unknown>)(99),
    ).rejects.toThrow(/Invalid tab ID/);
  });

  it("highlight validates the list and activates the last tab", async () => {
    const browser = await tabsApi("TabHigh" + Math.random().toString(36).slice(2, 7));
    TABS.syncFromUi([
      tab(10, "https://a.example/", { active: true }),
      tab(11, "https://b.example/"),
      tab(12, "https://c.example/"),
    ]);
    const ops: TabsOp[] = [];
    TABS.setDispatch((op) => ops.push(op));
    const activated: number[] = [];
    (browser.tabs.onActivated as { addListener: (l: (i: { tabId: number }) => void) => void }).addListener((i) => activated.push(i.tabId));

    const hl = (browser.tabs.highlight as (info: unknown) => Promise<void>)({ tabs: [10, 12] });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "update", tabId: 12, props: { active: true } });
    TABS.syncFromUi([
      tab(10, "https://a.example/"),
      tab(11, "https://b.example/"),
      tab(12, "https://c.example/", { active: true }),
    ]);
    await hl;
    expect(activated).toContain(12);

    await expect((browser.tabs.highlight as (i: unknown) => Promise<void>)({ tabs: [99] })).rejects.toThrow(/Invalid tab ID/);
    await expect((browser.tabs.highlight as (i: unknown) => Promise<void>)({ tabs: [] })).rejects.toThrow(/non-empty tabs array/);
    await expect((browser.tabs.highlight as (i: unknown) => Promise<void>)({})).rejects.toThrow(/non-empty tabs array/);
  });
});
