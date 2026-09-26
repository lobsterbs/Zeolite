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
