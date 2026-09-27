import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { TABS, TabRegistry } from "../tabs";
import type { TabMessage, UiTab } from "../tabs";
import type { ExtensionRecord } from "../types";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

function tab(id: number, url: string, extra: Partial<UiTab> = {}): UiTab {
  return { id, index: id, url, title: "t" + id, active: false, ...extra };
}

/** Only the fields tabs.sendMessage consults; the registry never
    touches the rest of the record. */
function fakeExt(hostPermissions: string[]): ExtensionRecord {
  return { hostPermissions } as unknown as ExtensionRecord;
}

describe("TabRegistry.sendMessage", () => {
  it("delivers through the dispatch host and resolves on the first reply", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(1, "https://a.example/")]);
    const delivered: Array<[number, string, string, TabMessage]> = [];
    r.setMessageDispatch((tabId, tabUrl, extId, payload) =>
      delivered.push([tabId, tabUrl, extId, payload]),
    );
    const p = r.sendMessage(fakeExt(["<all_urls>"]), 1, { hello: 1 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0][0]).toBe(1);
    expect(delivered[0][1]).toBe("https://a.example/");
    expect(delivered[0][3].msg).toEqual({ hello: 1 });
    r.resolveTabMessage(delivered[0][3].nonce, { ok: true });
    r.resolveTabMessage(delivered[0][3].nonce, { ignored: true });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects on a listener error report", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(2, "https://b.example/")]);
    let nonce = "";
    r.setMessageDispatch((_tabId, _url, _ext, payload) => { nonce = payload.nonce; });
    const p = r.sendMessage(fakeExt(["<all_urls>"]), 2, "x");
    r.rejectTabMessage(nonce, "listener failed");
    await expect(p).rejects.toThrow(/listener failed/);
  });

  it("rejects for missing tabs and missing host permissions", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(3, "https://c.example/")]);
    r.setMessageDispatch(() => undefined);
    await expect(r.sendMessage(fakeExt(["<all_urls>"]), 99, "x")).rejects.toThrow(/Invalid tab ID/);
    await expect(r.sendMessage(fakeExt(["https://other.example/*"]), 3, "x")).rejects.toThrow(
      /host permission/,
    );
  });

  it("rejects without a dispatch host", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(4, "https://d.example/")]);
    await expect(r.sendMessage(fakeExt(["<all_urls>"]), 4, "x")).rejects.toThrow(
      /no tab host attached/,
    );
  });

  it("rejects a frameId option honestly instead of ignoring it", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(5, "https://e.example/")]);
    const nonces: string[] = [];
    r.setMessageDispatch((_t, _u, _e, payload) => { nonces.push(payload.nonce); });
    await expect(
      r.sendMessage(fakeExt(["<all_urls>"]), 5, "x", { frameId: 0 }),
    ).rejects.toThrow(/frame targeting is not supported/);
    // An options object without frameId is accepted and delivered.
    const p1 = r.sendMessage(fakeExt(["<all_urls>"]), 5, "x", {});
    const p2 = r.sendMessage(fakeExt(["<all_urls>"]), 5, "x");
    expect(nonces).toHaveLength(2);
    r.resolveTabMessage(nonces[0], 1);
    r.resolveTabMessage(nonces[1], 2);
    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);
  });

  it("rejects pending messages immediately when the tab is removed", async () => {
    const r = new TabRegistry();
    r.syncFromUi([tab(6, "https://f.example/"), tab(7, "https://g.example/")]);
    const nonces: string[] = [];
    r.setMessageDispatch((_t, _u, _e, payload) => { nonces.push(payload.nonce); });
    const p = r.sendMessage(fakeExt(["<all_urls>"]), 6, "x");
    const pOther = r.sendMessage(fakeExt(["<all_urls>"]), 7, "y");
    expect(nonces).toHaveLength(2);
    // UI sync drops tab 6: its pending reply must fail now, not at the
    // 30s timeout; tab 7's pending message must be untouched.
    r.syncFromUi([tab(7, "https://g.example/")]);
    await expect(p).rejects.toThrow(/tab closed before a content script replied/);
    r.resolveTabMessage(nonces[1], { ok: true });
    await expect(pOther).resolves.toEqual({ ok: true });
    // The removed tab's stale nonce and unknown nonces stay no-ops.
    r.resolveTabMessage(nonces[0], { ignored: true });
    r.rejectTabMessage("nope", "never registered");
  });

  it("ignores replies for unknown nonces", () => {
    const r = new TabRegistry();
    r.resolveTabMessage("nope", 1);
    r.rejectTabMessage("nope", "x");
  });
});

describe("browser.tabs.sendMessage (buildApi)", () => {
  it("routes through the TABS singleton with permission checks", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const manifest = {
      manifest_version: 2,
      name: "TabMsg",
      version: "1.0",
      permissions: [],
      host_permissions: ["<all_urls>"],
    };
    const { id } = await m.installFiles(
      new Map<string, Uint8Array>([
        ["manifest.json", enc.encode(JSON.stringify(manifest))],
      ]),
    );
    const rec = m.get(id)!;
    const storage = {
      local: new ExtensionStorageArea(id, "local", "local"),
      sync: new ExtensionStorageArea(id, "sync", "sync"),
      session: new ExtensionStorageArea(id, "session", "session"),
    };
    const api = buildApi(rec, { extensionId: id, context: "background", url: null }, {
      messenger: new ExtensionMessenger(),
      storage,
    });
    const tabsNs = api.browser.tabs as Record<string, unknown>;
    const send = tabsNs["sendMessage"] as (tabId: number, msg: unknown) => Promise<unknown>;
    TABS.setDispatch(() => undefined);
    TABS.syncFromUi([tab(7, "https://tabmsg.example/", { active: true })]);
    let nonce = "";
    TABS.setMessageDispatch((_tabId, _url, _ext, payload) => { nonce = payload.nonce; });
    const p = send(7, "ping");
    TABS.resolveTabMessage(nonce, "pong");
    await expect(p).resolves.toBe("pong");
    await expect(send(999, "x")).rejects.toThrow(/Invalid tab ID/);
    TABS.setMessageDispatch(null);
  });
});
