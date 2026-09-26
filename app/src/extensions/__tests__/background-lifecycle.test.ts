import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions, ExtensionManager } from "../manager";
import { MESSENGER } from "../context";
import {
  bootEnabled,
  bootExtension,
  wakeExtension,
  idleTerminate,
  backgroundIsServiceWorker,
} from "../background";

const enc = new TextEncoder();

function swPkg(name: string): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 3,
    name,
    version: "1.0",
    permissions: [],
    background: { service_worker: "sw.js" },
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["sw.js", enc.encode(
      "browser.runtime.onMessage.addListener(function (m, s, send) { send({ pong: m }); });",
    )],
  ]);
}

function scriptPkg(name: string): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: [],
    background: { scripts: ["bg.js"] },
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["bg.js", enc.encode("browser.runtime.onMessage.addListener(function (m, s, send) { send({ bg: m }); });")],
  ]);
}

const bgSender = (id: string) => ({ extensionId: id, context: "background" as const, url: null });

describe("backgroundIsServiceWorker", () => {
  it("classifies MV3 service-worker backgrounds only", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const sw = await m.installFiles(swPkg("SwClass"));
    const sc = await m.installFiles(scriptPkg("ScriptClass"));
    expect(backgroundIsServiceWorker(m.get(sw.id)!)).toBe(true);
    expect(backgroundIsServiceWorker(m.get(sc.id)!)).toBe(false);
  });
});

describe("MV3 service-worker lifecycle", () => {
  it("bootEnabled leaves service-worker backgrounds stopped", async () => {
    await extensions.startup();
    const { id } = await extensions.installFiles(swPkg("SwIdle"));
    await bootEnabled();
    expect(extensions.get(id)?.state).not.toBe("running");
    await expect(MESSENGER.sendMessage(id, bgSender(id), "ping")).rejects.toThrow(
      /Receiving end does not exist/,
    );
  });

  it("wakeExtension boots on demand and delivers messages", async () => {
    const { id } = await extensions.installFiles(swPkg("SwWake"));
    await wakeExtension(id);
    expect(extensions.get(id)?.state).toBe("running");
    await expect(MESSENGER.sendMessage(id, bgSender(id), "ping")).resolves.toEqual({ pong: "ping" });
  });

  it("idleTerminate drops listeners and the next wake re-executes", async () => {
    const { id } = await extensions.installFiles(swPkg("SwTerm"));
    await wakeExtension(id);
    idleTerminate(id);
    expect(extensions.get(id)?.state).toBe("installed");
    await expect(MESSENGER.sendMessage(id, bgSender(id), "ping")).rejects.toThrow(
      /Receiving end does not exist/,
    );
    await wakeExtension(id);
    expect(extensions.get(id)?.state).toBe("running");
    await expect(MESSENGER.sendMessage(id, bgSender(id), "ping")).resolves.toEqual({ pong: "ping" });
    idleTerminate(id);
  });

  it("wakeExtension is a no-op for script backgrounds", async () => {
    const { id } = await extensions.installFiles(scriptPkg("ScriptWake"));
    await bootEnabled();
    expect(extensions.get(id)?.state).toBe("running");
    await wakeExtension(id);
    expect(extensions.get(id)?.state).toBe("running");
    await expect(MESSENGER.sendMessage(id, bgSender(id), "ping")).resolves.toEqual({ bg: "ping" });
  });

  it("an errored service worker is not auto-restarted", async () => {
    const bad = swPkg("SwBad");
    bad.set("sw.js", enc.encode("throw new Error('broken worker');"));
    const { id } = await extensions.installFiles(bad);
    await bootExtension(extensions.get(id)!);
    expect(extensions.get(id)?.state).toBe("error");
    await wakeExtension(id);
    expect(extensions.get(id)?.state).toBe("error");
  });
});
