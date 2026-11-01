import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import {
  contentScriptMayUseSession,
  dropSessionAccess,
  setSessionAccessLevel,
  SYNC_MAX_ITEMS,
  SYNC_QUOTA_BYTES,
  SYNC_QUOTA_BYTES_PER_ITEM,
} from "../storage";

const enc = new TextEncoder();

/* #520: storage.onChanged, session.setAccessLevel and the Firefox
   storage.sync quota surface. The harness follows the wave-A pattern:
   real modules against fake-indexeddb, no mocks. */

function pkg(manifest: Record<string, unknown>): Map<string, Uint8Array> {
  return new Map([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
}

async function install(name: string, manifest: Record<string, unknown>) {
  await extensions.startup();
  const { id } = await extensions.installFiles(
    pkg({ manifest_version: 3, name, version: "1.0", ...manifest }),
  );
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(
    rec,
    { extensionId: id, id, context: "background", url: null },
    { messenger: new ExtensionMessenger(), storage },
  );
  return { id, rec, api, storage };
}

describe("storage.onChanged (#520)", () => {
  it("reports (changes, areaName) for local, sync and session writes", async () => {
    const { api, storage } = await install("OnChanged", { permissions: ["storage"] });
    const s = api.browser.storage as Record<string, unknown>;
    const seen: Array<[Record<string, unknown>, string]> = [];
    (s.onChanged as { addListener: (l: never) => void }).addListener(
      ((changes: Record<string, unknown>, area: string) => seen.push([changes, area])) as never,
    );
    await storage.local.set({ a: 1 });
    await storage.session.set({ b: 2 });
    await storage.local.remove("a");
    expect(seen.map(([, area]) => area)).toEqual(["local", "session", "local"]);
    expect(seen[0][0]).toEqual({ a: { oldValue: undefined, newValue: 1 } });
    expect(seen[2][0]).toEqual({ a: { oldValue: 1, newValue: undefined } });
  });

  it("removeListener detaches from every area at once", async () => {
    const { api, storage } = await install("OnChangedOff", { permissions: ["storage"] });
    const s = api.browser.storage as Record<string, unknown>;
    let calls = 0;
    const ev = s.onChanged as {
      addListener: (l: unknown) => void;
      removeListener: (l: unknown) => void;
      hasListener: (l: unknown) => boolean;
    };
    const l = (c: unknown, a: unknown) => {
      void c;
      void a;
      calls++;
    };
    ev.addListener(l);
    ev.removeListener(l);
    expect(ev.hasListener(l)).toBe(false);
    await storage.local.set({ k: 1 });
    await storage.sync.set({ k: 2 });
    expect(calls).toBe(0);
  });

  it("does not mount without the storage permission", async () => {
    const { api } = await install("NoStoragePerm", { permissions: [] });
    expect(api.browser.storage).toBeUndefined();
  });
});

describe("storage.session.setAccessLevel (#520)", () => {
  it("accepts the Firefox string form and Chrome object form", async () => {
    const { id, api } = await install("SessAccess", { permissions: ["storage"] });
    const s = api.browser.storage as Record<string, unknown>;
    const session = s.session as { setAccessLevel: (arg: unknown) => void };
    expect(contentScriptMayUseSession(id)).toBe(false);
    session.setAccessLevel("TRUSTED_AND_UNTRUSTED_CONTEXTS");
    expect(contentScriptMayUseSession(id)).toBe(true);
    session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS_ONLY" });
    expect(contentScriptMayUseSession(id)).toBe(false);
  });

  it("throws on an unknown level, as Firefox throws", async () => {
    const { api } = await install("SessAccessBad", { permissions: ["storage"] });
    const session = (api.browser.storage as Record<string, unknown>).session as {
      setAccessLevel: (arg: unknown) => void;
    };
    expect(() => session.setAccessLevel("SOMETING_ELSE")).toThrow(/access level must be/);
    expect(() => session.setAccessLevel(7)).toThrow(/access level must be/);
  });

  it("uninstall resets the level to the default", async () => {
    const { id } = await install("SessReset", { permissions: ["storage"] });
    setSessionAccessLevel(id, "TRUSTED_AND_UNTRUSTED_CONTEXTS");
    expect(contentScriptMayUseSession(id)).toBe(true);
    await extensions.uninstall(id);
    expect(contentScriptMayUseSession(id)).toBe(false);
    dropSessionAccess(id);
  });
});

describe("storage.sync Firefox quota surface (#520)", () => {
  it("reports the documented constants", async () => {
    const { api } = await install("SyncConsts", { permissions: ["storage"] });
    const sync = (api.browser.storage as Record<string, unknown>).sync as Record<string, unknown>;
    expect(sync.QUOTA_BYTES).toBe(102400);
    expect(sync.QUOTA_BYTES_PER_ITEM).toBe(8192);
    expect(sync.MAX_ITEMS).toBe(SYNC_MAX_ITEMS);
    expect(sync.MAX_WRITE_OPERATIONS_PER_HOUR).toBe(1800);
    expect(sync.MAX_WRITE_OPERATIONS_PER_MINUTE).toBe(120);
    expect(SYNC_QUOTA_BYTES).toBe(102400);
    expect(SYNC_QUOTA_BYTES_PER_ITEM).toBe(8192);
  });

  it("enforces the per-item and total quotas", async () => {
    const { storage } = await install("SyncQuota", { permissions: ["storage"] });
    await expect(storage.sync.set({ big: "x".repeat(8192) })).rejects.toThrow(/QUOTA_BYTES_PER_ITEM/);
    await expect(storage.sync.set({ a: "x".repeat(40000) })).rejects.toThrow(/QUOTA_BYTES_PER_ITEM/);
    await storage.sync.set({ small: "ok" });
    await expect(
      storage.sync.set({ blob: "y".repeat(90000) }),
    ).rejects.toThrow();
  });

  it("enforces MAX_ITEMS (writes paced under the Firefox rate limit)", async () => {
    const { storage } = await install("SyncItems", { permissions: ["storage"] });
    /* Firefox also caps writes at 120/minute, so the preload paces
       itself across fake time - the engine enforces both limits. */
    const batch: Record<string, number> = {};
    let written = 0;
    for (let i = 0; i < SYNC_MAX_ITEMS; i++) {
      batch["k" + i] = i;
      written++;
      if (written === 100) {
        await storage.sync.set(batch);
        for (const k of Object.keys(batch)) delete batch[k];
        written = 0;
        vi.setSystemTime(Date.now() + 61_000);
      }
    }
    if (written > 0) await storage.sync.set(batch);
    vi.setSystemTime(Date.now() + 61_000);
    await expect(storage.sync.set({ oneMore: 1 })).rejects.toThrow(/MAX_ITEMS/);
    vi.useRealTimers();
  });
});

describe("unlimitedStorage (#520)", () => {
  it("lifts the local-area quota when the permission is granted", async () => {
    await extensions.startup();
    const manifest = {
      manifest_version: 3,
      name: "Unlimited",
      version: "1.0",
      permissions: ["storage", "unlimitedStorage"],
    };
    const { id } = await extensions.installFiles(pkg(manifest));
    const rec = extensions.get(id)!;
    const lifted = new ExtensionStorageArea(id, "local", "local", Number.POSITIVE_INFINITY);
    await lifted.set({ huge: "z".repeat(5 * 1024 * 1024 + 1024) });
    expect((await lifted.get("huge")).huge.length).toBe(5 * 1024 * 1024 + 1024);
    void rec;
  });

  it("keeps the 5 MiB default without the permission", async () => {
    const { storage } = await install("Limited", { permissions: ["storage"] });
    await expect(storage.local.set({ huge: "z".repeat(5 * 1024 * 1024 + 1024) })).rejects.toThrow(
      /quota exceeded/,
    );
  });
});
