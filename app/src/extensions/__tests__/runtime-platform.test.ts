import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
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

async function api() {
  const rec = await install("Plat");
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

/* #560: TM-class background init awaits both methods through
   callback-only Promises; a missing method throws inside that await
   and the init never completes, so every later page message queues
   forever. Both surfaces must answer. */
describe("runtime platform identity (#560)", () => {
  it("answers getPlatformInfo and getBrowserInfo on the browser surface", async () => {
    const { browser } = await api();
    const rt = browser.runtime as Record<string, unknown>;
    const plat = await (rt.getPlatformInfo as () => Promise<{ os: string; arch: string }>)();
    expect(typeof plat.os).toBe("string");
    expect(typeof plat.arch).toBe("string");
    const bi = await (rt.getBrowserInfo as () => Promise<{ name: string; version: string }>)();
    expect(typeof bi.name).toBe("string");
    expect(typeof bi.version).toBe("string");
  });

  it("adapts both for callback-style chrome calls", async () => {
    const { chrome } = await api();
    const rt = chrome.runtime as Record<string, unknown>;
    const plat = await new Promise<{ os: string }>((res) => {
      (rt.getPlatformInfo as (cb: (v: { os: string }) => void) => void)((v) => res(v));
    });
    expect(typeof plat.os).toBe("string");
    const bi = await new Promise<{ name: string }>((res) => {
      (rt.getBrowserInfo as (cb: (v: { name: string }) => void) => void)((v) => res(v));
    });
    expect(typeof bi.name).toBe("string");
  });
});
