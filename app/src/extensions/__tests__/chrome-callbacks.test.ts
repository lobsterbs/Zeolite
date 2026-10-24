import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../runtime";
import { ExtensionStorageArea } from "../storage";
import { ExtensionMessenger } from "../messaging";
import { extensions } from "../manager";
import { bootInstalled } from "../background";
import { MESSENGER } from "../context";
import { TABS } from "../tabs";
import { chromeApi } from "../chrome";

type Api = Record<string, unknown>;
const enc = new TextEncoder();
const sender = (id: string) => ({ extensionId: id, context: "background" as const, url: null });
const method = (api: Api, path: string): ((...args: unknown[]) => unknown) => {
  const parts = path.split(".");
  let object = api;
  for (const p of parts.slice(0, -1)) object = object[p] as Api;
  return object[parts[parts.length - 1]] as (...args: unknown[]) => unknown;
};
async function api(name: string, permissions: string[] = ["storage"]) {
  await extensions.startup();
  const files = new Map([["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1", permissions }))]]);
  const { id } = await extensions.installFiles(files);
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const messenger = new ExtensionMessenger();
  return { id, messenger, ...buildApi(extensions.get(id)!, sender(id), { storage, messenger }) };
}

describe("Chrome callback compatibility", () => {
  it("uses actual storage callbacks while browser and callback-less chrome retain Promises", async () => {
    const { browser, chrome } = await api("ChromeStorage");
    await new Promise<void>((resolve) => {
      expect(method(chrome, "storage.session.set")({ hello: "world" }, resolve)).toBeUndefined();
    });
    await new Promise<void>((resolve) => {
      method(chrome, "storage.session.get")(null, (items: unknown) => {
        expect(items).toEqual({ hello: "world" });
        expect((chrome.runtime as Api).lastError).toBeUndefined();
        resolve();
      });
    });
    await expect(method(browser, "storage.session.get")(null)).resolves.toEqual({ hello: "world" });
    await expect(method(chrome, "storage.session.get")(null)).resolves.toEqual({ hello: "world" });
  });
  it("scopes lastError to the failing callback without crossing extensions", async () => {
    const a = await api("ChromeErrorA");
    const b = await api("ChromeErrorB");
    TABS.syncFromUi([]);
    let count = 0;
    await new Promise<void>((resolve) => {
      method(a.chrome, "tabs.get")(-999, (...values: unknown[]) => {
        count++;
        expect(values).toEqual([]);
        expect((a.chrome.runtime as Api).lastError).toEqual({ message: "Invalid tab ID: -999" });
        expect((b.chrome.runtime as Api).lastError).toBeUndefined();
        expect((a.browser.runtime as Api).lastError).toBeNull();
        resolve();
      });
    });
    expect(count).toBe(1);
    expect((a.chrome.runtime as Api).lastError).toBeUndefined();
    await expect(method(a.chrome, "tabs.get")(-999)).rejects.toThrow("Invalid tab ID");
  });
  it("delivers runtime replies and keeps listener add/remove and synchronous methods unchanged", async () => {
    const { id, chrome } = await api("ChromeMessages");
    const listen = vi.fn((msg: unknown) => ({ reply: msg }));
    method(chrome, "runtime.onMessage.addListener")(listen);
    expect(method(chrome, "runtime.onMessage.hasListener")(listen)).toBe(true);
    await new Promise<void>((resolve) => {
      method(chrome, "runtime.sendMessage")("ping", (response: unknown) => {
        expect(response).toEqual({ reply: "ping" }); resolve();
      });
    });
    expect(listen).toHaveBeenCalledOnce();
    method(chrome, "runtime.onMessage.removeListener")(listen);
    expect(method(chrome, "runtime.onMessage.hasListener")(listen)).toBe(false);
    expect((chrome.runtime as Api).id).toBe(id);
    expect(method(chrome, "runtime.getManifest")()).toMatchObject({ name: "ChromeMessages" });
    await new Promise<void>((resolve) => {
      method(chrome, "runtime.sendMessage")("ping", () => {
        expect((chrome.runtime as { lastError: { message: string } }).lastError.message).toMatch(/Receiving end does not exist/);
        resolve();
      });
    });
  });
  it("keeps permission-gated and unsupported APIs absent", async () => {
    const { chrome } = await api("ChromeNoPermission", []);
    expect(chrome.storage).toBeUndefined();
    expect(chrome.webRequest).toBeUndefined();
    expect(chrome.debugger).toBeUndefined();
  });
  it("settles synchronous backend failure asynchronously with lastError", async () => {
    const chrome = chromeApi({ runtime: { sendMessage: () => { throw new Error("backend unavailable"); } } });
    let synchronous = true;
    const done = new Promise<void>((resolve) => {
      method(chrome, "runtime.sendMessage")("ping", () => {
        expect(synchronous).toBe(false);
        expect((chrome.runtime as Api).lastError).toEqual({ message: "backend unavailable" });
        resolve();
      });
    });
    synchronous = false;
    await done;
    expect((chrome.runtime as Api).lastError).toBeUndefined();
  });
  it("boots a callback background through storage initialization and message reply", async () => {
    await extensions.startup();
    const files = new Map([
      ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name: "ChromeBackground", version: "1", permissions: ["storage"], background: { scripts: ["bg.js"] } }))],
      ["bg.js", enc.encode(`chrome.storage.session.get(null, function () {
        chrome.runtime.onMessage.addListener(function (message, sender, respond) {
          respond({ initialized: true, message: message });
        });
      });`)],
    ]);
    const { id } = await extensions.installFiles(files);
    await bootInstalled(id);
    expect(extensions.get(id)?.state).toBe("running");
    await expect(MESSENGER.sendMessage(id, sender(id), "ready")).resolves.toEqual({ initialized: true, message: "ready" });
  });
});
