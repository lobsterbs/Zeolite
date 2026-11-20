import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { buildApi } from "../runtime";
import { ExtensionStorageArea } from "../storage";
import { ExtensionMessenger } from "../messaging";
import { extensions } from "../manager";

/* #697 regression: Tampermonkey wedges to a white options page when
   storage.local.get reports a never-set key as a present null entry:
   its storage backend probe unpacks all present entries (reads .value)
   and the resulting TypeError kills the background boot before any
   options-page ping is answered. Chrome and Firefox omit missing keys;
   the engine must too. */
describe("storage get parity for missing keys (Zeolite #697)", () => {
  const enc = new TextEncoder();
  const sender = (id: string) => ({ extensionId: id, context: "background" as const, url: null });
  const method = (api: Record<string, unknown>, path: string): ((...args: unknown[]) => unknown) => {
    const parts = path.split(".");
    let object = api;
    for (const p of parts.slice(0, -1)) object = object[p] as Record<string, unknown>;
    return object[parts[parts.length - 1]] as (...args: unknown[]) => unknown;
  };
  async function api(name: string): Promise<Record<string, unknown>> {
    await extensions.startup();
    const files = new Map([["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1", permissions: ["storage"] }))]]);
    const { id } = await extensions.installFiles(files);
    const storage = {
      local: new ExtensionStorageArea(id, "local", "local"),
      sync: new ExtensionStorageArea(id, "sync", "sync"),
      session: new ExtensionStorageArea(id, "session", "session"),
    };
    const messenger = new ExtensionMessenger();
    return buildApi(extensions.get(id)!, sender(id), { storage, messenger }) as Record<string, unknown>;
  }
  it("omits a missing key in callback mode (Tampermonkey backend probe, #697)", async () => {
    const built = await api("ParityCallbackMissing");
    const chrome = built.chrome as Record<string, unknown>;
    await new Promise<void>((resolve) => {
      method(chrome, "storage.local.set")({ "!extdb.#version": { origin: "normal", value: "5.5.0" } }, resolve);
    });
    await new Promise<void>((resolve, reject) => {
      method(chrome, "storage.local.get")("!extdb.#storage", (items: unknown) => {
        try {
          expect(items).toEqual({});
          resolve();
        } catch (e) { reject(e); }
      });
    });
    await expect(method(chrome, "storage.local.get")("!extdb.#storage")).resolves.toEqual({});
  });
  it("omits missing keys in lists and honors object-form defaults (Chrome parity)", async () => {
    const built = await api("ParityPromiseMissing");
    const browser = built.browser as Record<string, unknown>;
    await (method(browser, "storage.local.set")({ "!extdb.#schema": { origin: "normal", value: "6226" } }) as Promise<void>);
    await expect(method(browser, "storage.local.get")("!extdb.#storage")).resolves.toEqual({});
    await expect(method(browser, "storage.local.get")(["!extdb.#schema", "!extdb.#storage"])).resolves.toEqual({ "!extdb.#schema": { origin: "normal", value: "6226" } });
    await expect(method(browser, "storage.local.get")({ "!extdb.#schema": null, "!extdb.#storage": "defaulted" })).resolves.toEqual({ "!extdb.#schema": { origin: "normal", value: "6226" }, "!extdb.#storage": "defaulted" });
  });
});
