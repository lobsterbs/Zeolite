import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea, makeManagedArea } from "../storage";

const enc = new TextEncoder();

async function storageApi() {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(
    new Map([
      ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 3, permissions: ["storage"], name: "Managed" + Math.random().toString(36).slice(2, 7), version: "1.0" }))],
    ]),
  );
  const rec = m.get(id)!;
  const { browser } = buildApi(
    rec,
    { extensionId: id, context: "background", url: null } as never,
    {
      messenger: new ExtensionMessenger(),
      storage: {
        local: new ExtensionStorageArea(id, "local", "local"),
        sync: new ExtensionStorageArea(id, "sync", "sync"),
        session: new ExtensionStorageArea(id, "session", "session"),
      },
      manager: m,
    },
  );
  return (browser as Record<string, unknown>).storage as Record<string, Record<string, unknown>>;
}

describe("storage.managed (#520)", () => {
  it("answers honestly empty and honors object-form defaults", async () => {
    const area = makeManagedArea();
    await expect((area.get as (k?: unknown) => Promise<Record<string, unknown>>)()).resolves.toEqual({});
    await expect((area.get as (k: unknown) => Promise<Record<string, unknown>>)("k")).resolves.toEqual({});
    await expect((area.get as (k: unknown) => Promise<Record<string, unknown>>)(["a", "b"])).resolves.toEqual({});
    await expect((area.get as (k: unknown) => Promise<Record<string, unknown>>)({ a: 1, b: "x" })).resolves.toEqual({ a: 1, b: "x" });
    await expect((area.getBytesInUse as () => Promise<number>)()).resolves.toBe(0);
  });

  it("rejects every write as read-only", async () => {
    const area = makeManagedArea();
    await expect((area.set as (i: unknown) => Promise<never>)({ a: 1 })).rejects.toThrow(/read-only/);
    await expect((area.remove as (k: unknown) => Promise<never>)("a")).rejects.toThrow(/read-only/);
    await expect((area.clear as () => Promise<never>)()).rejects.toThrow(/read-only/);
  });

  it("mounts on browser.storage beside the other areas", async () => {
    const storage = await storageApi();
    expect(typeof storage.managed).toBe("object");
    await expect((storage.managed.get as (k?: unknown) => Promise<Record<string, unknown>>)({ zl: 3 })).resolves.toEqual({ zl: 3 });
    await expect((storage.managed.set as (i: unknown) => Promise<never>)({ zl: 3 })).rejects.toThrow(/read-only/);
    /* The other areas are untouched by managed's emptiness. */
    await (storage.local.set as (i: Record<string, unknown>) => Promise<void>)({ real: 1 });
    await expect((storage.local.get as (k: string) => Promise<Record<string, unknown>>)("real")).resolves.toEqual({ real: 1 });
  });
});
