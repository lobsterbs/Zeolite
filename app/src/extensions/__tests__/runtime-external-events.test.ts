import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { wakeExtension } from "../background";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { MESSENGER } from "../context";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions: [] };
  return new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
}

/* Install ids derive from manifest bytes, so every install needs a
   unique manifest name. */
let seq = 0;

async function install(name: string): Promise<ExtensionRecord> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name + " #" + seq++));
  return extensions.get(id)!;
}

/* #573 reproduction shape: an MV3 service-worker background that
   registers the external listener surfaces first, exactly the
   TM-class startup sequence. Before the fix the onMessageExternal
   line threw inside the boot, the record landed in ERROR state and
   the messenger never gained the onMessage listener: options pages
   pinged forever. */
function swPkg(name: string): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 3,
    name,
    version: "1.0",
    permissions: [],
    background: { service_worker: "sw.js" },
  };
  const sw = [
    "browser.runtime.onMessageExternal.addListener(function () {});",
    "browser.runtime.onConnectExternal.addListener(function () {});",
    "browser.runtime.onMessage.addListener(function (m, s, send) { send({ pong: m }); });",
  ].join(" ");
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["sw.js", enc.encode(sw)],
  ]);
}

async function api() {
  const rec = await install("ExtEv");
  const storage = {
    local: new ExtensionStorageArea(rec.id, "local", "local"),
    sync: new ExtensionStorageArea(rec.id, "sync", "sync"),
    session: new ExtensionStorageArea(rec.id, "session", "session"),
  };
  return buildApi(rec, { extensionId: rec.id, id: rec.id, context: "background", url: null }, {
    messenger: new ExtensionMessenger(),
    storage,
  });
}

/* #573: TM-class background init registers every runtime listener
   surface during startup (onMessage, onConnect, onConnectExternal).
   An undefined external namespace aborted the whole bootstrap with
   a TypeError (an unhandled rejection in the init chain), leaving
   the extension deaf: options pages pinged forever and never
   rendered. The surfaces must exist and accept listeners; there
   is no external sender in this model (the messenger refuses
   cross-extension sends), so the events register but never fire. */
describe("runtime external event surfaces (#573)", () => {
  it("exposes onMessageExternal and onConnectExternal on the browser surface", async () => {
    const { browser } = await api();
    const rt = browser.runtime as Record<string, any>;
    expect(typeof rt.onMessageExternal.addListener).toBe("function");
    expect(typeof rt.onMessageExternal.removeListener).toBe("function");
    expect(typeof rt.onMessageExternal.hasListener).toBe("function");
    expect(typeof rt.onConnectExternal.addListener).toBe("function");
    expect(typeof rt.onConnectExternal.removeListener).toBe("function");
    expect(typeof rt.onConnectExternal.hasListener).toBe("function");
  });

  it("registers and reports listeners without firing (no external sender exists)", async () => {
    const { browser } = await api();
    const rt = browser.runtime as Record<string, any>;
    let fired = 0;
    const l = () => {
      fired++;
    };
    rt.onMessageExternal.addListener(l);
    rt.onConnectExternal.addListener(l);
    expect(rt.onMessageExternal.hasListener(l)).toBe(true);
    expect(rt.onConnectExternal.hasListener(l)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(0);
    rt.onMessageExternal.removeListener(l);
    rt.onConnectExternal.removeListener(l);
    expect(rt.onMessageExternal.hasListener(l)).toBe(false);
    expect(rt.onConnectExternal.hasListener(l)).toBe(false);
  });

  it("carries both surfaces onto the chrome-parity object", async () => {
    const { chrome } = await api();
    const rt = chrome.runtime as Record<string, any>;
    expect(typeof rt.onMessageExternal.addListener).toBe("function");
    expect(typeof rt.onConnectExternal.addListener).toBe("function");
  });

  it("survives a TM-style startup registration sequence", async () => {
    const { browser } = await api();
    const rt = browser.runtime as Record<string, any>;
    const steps = [
      () => rt.onMessage.addListener(() => undefined),
      () => rt.onConnect.addListener(() => undefined),
      () => rt.onConnectExternal.addListener(() => undefined),
      () => rt.onMessageExternal.addListener(() => undefined),
    ];
    for (const step of steps) expect(step).not.toThrow();
  });

  it("a TM-style MV3 boot that registers the external surfaces first stays live and reachable", async () => {
    await extensions.startup();
    const { id } = await extensions.installFiles(swPkg("ExtEvSw #" + seq++));
    await wakeExtension(id);
    expect(extensions.get(id)?.state).toBe("running");
    await expect(
      MESSENGER.sendMessage(id, { extensionId: id, context: "background", url: null }, "ping"),
    ).resolves.toEqual({ pong: "ping" });
  });
});
