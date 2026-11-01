import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { ACTION } from "../action";
import type { ActionOp } from "../action";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(manifest: Record<string, unknown>): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
}

async function install(
  name: string,
  manifest: Record<string, unknown>,
): Promise<{ rec: ExtensionRecord; api: { browser: Record<string, unknown>; chrome: Record<string, unknown> } }> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg({ manifest_version: 3, name, version: "1.0", ...manifest }));
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  return {
    rec,
    api: buildApi(
      rec,
      { extensionId: id, id, context: "background", url: null },
      { messenger: new ExtensionMessenger(), storage },
    ),
  };
}

describe("browser.action (#519)", () => {
  it("mounts only for a manifest action key and seeds defaults from the manifest", async () => {
    const { rec, api } = await install("ActExt", {
      action: { default_title: "Default Title", default_popup: "popup.html" },
    });
    const a = api.browser.action as Record<string, unknown>;
    expect(a).toBeDefined();
    expect(await (a.getTitle as (d?: unknown) => Promise<string | null>)()).toBe("Default Title");
    expect(await (a.getPopup as (d?: unknown) => Promise<string | null>)()).toBe("/popup.html");
    expect(rec.action?.kind).toBe("action");
    // browserAction/pageAction stay absent for an MV3 action manifest
    expect(api.browser.browserAction).toBeUndefined();
    expect(api.browser.pageAction).toBeUndefined();
  });

  it("sets and gets badge state per tab, falling back to the default", async () => {
    const { api } = await install("BadgeExt", { action: {} });
    const a = api.browser.action as Record<string, unknown>;
    const ops: ActionOp[] = [];
    ACTION.setDispatch((op) => ops.push(op));
    await (a.setBadgeText as (d: unknown) => Promise<void>)({ text: "42" });
    expect(await (a.getBadgeText as (d?: unknown) => Promise<string | null>)()).toBe("42");
    expect(await (a.getBadgeText as (d?: unknown) => Promise<string | null>)({ tabId: 7 })).toBe("42");
    await (a.setBadgeText as (d: unknown) => Promise<void>)({ text: "t7", tabId: 7 });
    expect(await (a.getBadgeText as (d?: unknown) => Promise<string | null>)({ tabId: 7 })).toBe("t7");
    expect(await (a.getBadgeText as (d?: unknown) => Promise<string | null>)({ tabId: 8 })).toBe("42");
    // ops target the right scope: default first, then tab 7
    expect(ops[0]).toMatchObject({ op: "state", tabId: null, state: { badgeText: "42" } });
    expect(ops[1]).toMatchObject({ op: "state", tabId: 7, state: { badgeText: "t7" } });
    ACTION.setDispatch(null);
  });

  it("normalizes badge colors to [r,g,b,a] and refuses invalid ones", async () => {
    const { api } = await install("ColorExt", { action: {} });
    const a = api.browser.action as Record<string, unknown>;
    await (a.setBadgeBackgroundColor as (d: unknown) => Promise<void>)({ color: "#ff0000" });
    expect(await (a.getBadgeBackgroundColor as (d?: unknown) => Promise<unknown>)()).toEqual([255, 0, 0, 255]);
    await (a.setBadgeBackgroundColor as (d: unknown) => Promise<void>)({ color: [0, 128, 255] });
    expect(await (a.getBadgeBackgroundColor as (d?: unknown) => Promise<unknown>)()).toEqual([0, 128, 255, 255]);
    await expect((a.setBadgeBackgroundColor as (d: unknown) => Promise<void>)({ color: "red" })).rejects.toThrow(/badge color/);
  });

  it("normalizes popup paths and refuses escapes from the package", async () => {
    const { api } = await install("PopupExt", { action: {} });
    const a = api.browser.action as Record<string, unknown>;
    await (a.setPopup as (d: unknown) => Promise<void>)({ popup: "ui/popup.html" });
    expect(await (a.getPopup as (d?: unknown) => Promise<string | null>)()).toBe("/ui/popup.html");
    await expect((a.setPopup as (d: unknown) => Promise<void>)({ popup: "../escape.html" })).rejects.toThrow();
  });

  it("validates icon path maps and refuses ImageData payloads", async () => {
    const { api } = await install("IconExt", { action: {} });
    const a = api.browser.action as Record<string, unknown>;
    await (a.setIcon as (d: unknown) => Promise<void>)({ path: { "16": "i16.png", "32": "i32.png" } });
    await expect((a.setIcon as (d: unknown) => Promise<void>)({ path: { "16": { data: new Uint8Array(4) } } })).rejects.toThrow(/package-relative|ImageData|path/);
    await expect((a.setIcon as (d: unknown) => Promise<void>)({ path: "../x.png" })).rejects.toThrow();
  });

  it("enable/disable is per-tab observable", async () => {
    const { api } = await install("EnabledExt", { action: {} });
    const a = api.browser.action as Record<string, unknown>;
    expect(await (a.isEnabled as (d?: unknown) => Promise<boolean>)()).toBe(true);
    (a.disable as (t?: number) => void)(7);
    expect(await (a.isEnabled as (d?: unknown) => Promise<boolean>)({ tabId: 7 })).toBe(false);
    expect(await (a.isEnabled as (d?: unknown) => Promise<boolean>)()).toBe(true);
  });

  it("delivers host-reported clicks to onClicked as Firefox's (tab, clickInfo) listener", async () => {
    const { rec, api } = await install("ClickExt", { action: {} });
    const a = api.browser.action as Record<string, unknown>;
    const seen: Array<[unknown, unknown]> = [];
    (a.onClicked as { addListener: (l: unknown) => void }).addListener((...args: unknown[]) =>
      seen.push([args[0], args[1]]),
    );
    const tab = { id: 3, url: "https://page.example/" };
    expect(ACTION.click(rec.id, "action", { tabId: 3, button: 0, modifiers: ["Shift"], tab })).toBe(true);
    expect(ACTION.click("other-ext", "action", { tabId: 3 })).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toEqual(tab);
    /* Firefox: two arguments — the Tab, then a clickInfo object. */
    expect(seen[0][1]).toEqual({ button: 0, modifiers: ["Shift"] });
    /* A plain left click carries an (empty) clickInfo, never a merged
       tab+info object. */
    seen.length = 0;
    expect(ACTION.click(rec.id, "action", { tabId: 3, tab })).toBe(true);
    expect(seen[0][0]).toEqual(tab);
    expect(seen[0][1]).toEqual({});
  });

  it("uninstall drops the registry entries", async () => {
    const { rec } = await install("DropExt", { action: {} });
    expect(ACTION.listFor(rec.id)).toHaveLength(1);
    await extensions.uninstall(rec.id);
    expect(ACTION.listFor(rec.id)).toHaveLength(0);
  });
});

describe("browser.browserAction (#519, MV2)", () => {
  it("mounts browserAction for an MV2 browser_action manifest", async () => {
    const { api } = await install("BAExt", {
      manifest_version: 2,
      browser_action: { default_title: "BA", default_icon: { "48": "i.png" } },
    });
    const ba = api.browser.browserAction as Record<string, unknown>;
    expect(ba).toBeDefined();
    expect(api.browser.action).toBeUndefined();
    expect(await (ba.getTitle as (d?: unknown) => Promise<string | null>)()).toBe("BA");
    await (ba.setBadgeText as (d: unknown) => Promise<void>)({ text: "b" });
    expect(await (ba.getBadgeText as (d?: unknown) => Promise<string | null>)()).toBe("b");
  });
});

describe("browser.pageAction (#519, MV2)", () => {
  it("starts hidden, shows per tab, and carries no badge surface", async () => {
    const { rec, api } = await install("PAExt", {
      manifest_version: 2,
      page_action: { default_title: "PA" },
    });
    const pa = api.browser.pageAction as Record<string, unknown>;
    expect(pa).toBeDefined();
    expect(await (pa.isShown as (d?: unknown) => Promise<boolean>)({ tabId: 5 })).toBe(false);
    (pa.show as (t: number) => void)(5);
    expect(await (pa.isShown as (d?: unknown) => Promise<boolean>)({ tabId: 5 })).toBe(true);
    expect(await (pa.isShown as (d?: unknown) => Promise<boolean>)({ tabId: 6 })).toBe(false);
    (pa.hide as (t: number) => void)(5);
    expect(await (pa.isShown as (d?: unknown) => Promise<boolean>)({ tabId: 5 })).toBe(false);
    expect((pa as Record<string, unknown>).setBadgeText).toBeUndefined();
    expect((pa as Record<string, unknown>).enable).toBeUndefined();
    // clicks deliver the Tab, not a clickInfo object
    const seen: unknown[] = [];
    (pa.onClicked as { addListener: (l: unknown) => void }).addListener((c: unknown) => seen.push(c));
    ACTION.click(rec.id, "page_action", { tabId: 5, tab: { id: 5 } });
    expect(seen[0]).toEqual({ id: 5 });
  });

  it("requires a tabId for show", async () => {
    const { api } = await install("PABad", { manifest_version: 2, page_action: {} });
    const pa = api.browser.pageAction as Record<string, unknown>;
    await expect((pa.show as (t?: number) => Promise<void>)(undefined as unknown as number)).rejects.toThrow(/tabId/);
  });
});
