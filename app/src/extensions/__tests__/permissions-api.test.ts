import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { PERMS } from "../advanced-permissions";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function makeApi(rec: ExtensionRecord) {
  const storage = {
    local: new ExtensionStorageArea(rec.id, "local", "local"),
    sync: new ExtensionStorageArea(rec.id, "sync", "sync"),
    session: new ExtensionStorageArea(rec.id, "session", "session"),
  };
  return buildApi(
    rec,
    { extensionId: rec.id, context: "background", url: null },
    { messenger: new ExtensionMessenger(), storage },
  );
}

/* Unique names give unique manifest bytes, hence unique ids in the
   shared fake IndexedDB. */
async function install(name: string): Promise<ExtensionRecord> {
  await extensions.startup();
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: ["storage"],
    optional_permissions: ["tabs", "downloads", "https://example.com/*"],
  };
  const { id } = await extensions.installFiles(
    new Map([["manifest.json", enc.encode(JSON.stringify(manifest))]]),
  );
  return extensions.get(id)!;
}

function wireBackend() {
  PERMS.setBackend(async (id, op, perms) => {
    const rec =
      op === "grant"
        ? await extensions.grantOptional(id, perms)
        : await extensions.revokeOptional(id, perms);
    return rec ? { permissions: [...rec.permissions], origins: [...rec.hostPermissions] } : null;
  });
}

type PermsNs = {
  contains: (p: { permissions?: string[]; origins?: string[] }) => Promise<boolean>;
  getAll: () => Promise<{ permissions: string[]; origins: string[] }>;
  request: (p: { permissions?: string[]; origins?: string[] }) => Promise<boolean>;
  remove: (p: { permissions?: string[]; origins?: string[] }) => Promise<boolean>;
  onAdded: { addListener: (l: (perms: { permissions?: string[]; origins?: string[] }) => void) => void };
  onRemoved: { addListener: (l: (perms: { permissions?: string[]; origins?: string[] }) => void) => void };
};

describe("browser.permissions", () => {
  it("auto-grants optional named permissions, fires onAdded, persists", async () => {
    wireBackend();
    const rec = await install("PermGrant");
    const api = makeApi(rec);
    const perms = api.browser.permissions as unknown as PermsNs;
    expect(await perms.contains({ permissions: ["tabs"] })).toBe(false);
    const fired: unknown[] = [];
    perms.onAdded.addListener((p) => fired.push(p));
    expect(await perms.request({ permissions: ["tabs"] })).toBe(true);
    expect(await perms.contains({ permissions: ["tabs"] })).toBe(true);
    expect((await perms.getAll()).permissions).toContain("tabs");
    expect(fired).toEqual([{ permissions: ["tabs"], origins: [] }]);
    /* The manager's master record changed too, not just the API view. */
    expect(extensions.get(rec.id)!.permissions).toContain("tabs");
  });

  it("refuses permissions not declared optional", async () => {
    wireBackend();
    const rec = await install("PermRefuse");
    const perms = makeApi(rec).browser.permissions as unknown as PermsNs;
    expect(await perms.request({ permissions: ["cookies"] })).toBe(false);
    expect(await perms.contains({ permissions: ["cookies"] })).toBe(false);
    expect(await perms.request({ permissions: ["tabs", "cookies"] })).toBe(false);
    expect(await perms.contains({ permissions: ["tabs"] })).toBe(false);
  });

  it("grants optional origin patterns and revokes on remove", async () => {
    wireBackend();
    const rec = await install("PermOrigin");
    const perms = makeApi(rec).browser.permissions as unknown as PermsNs;
    expect(await perms.request({ origins: ["https://example.com/*"] })).toBe(true);
    expect(await perms.contains({ origins: ["https://example.com/*"] })).toBe(true);
    const fired: unknown[] = [];
    perms.onRemoved.addListener((p) => fired.push(p));
    expect(await perms.remove({ origins: ["https://example.com/*"] })).toBe(true);
    expect(await perms.contains({ origins: ["https://example.com/*"] })).toBe(false);
    expect(fired).toEqual([{ permissions: [], origins: ["https://example.com/*"] }]);
    expect(extensions.get(rec.id)!.hostPermissions).not.toContain("https://example.com/*");
  });

  it("getAll reflects the manifest grant set", async () => {
    wireBackend();
    const rec = await install("PermGetAll");
    const perms = makeApi(rec).browser.permissions as unknown as PermsNs;
    const all = await perms.getAll();
    expect(all.permissions).toContain("storage");
    expect(all.permissions).not.toContain("tabs");
    expect(all.origins).toEqual([]);
  });

  it("fires onAdded with only the delta on a mixed request (#522)", async () => {
    wireBackend();
    const rec = await install("PermMixed");
    const api = makeApi(rec);
    const perms = api.browser.permissions as unknown as PermsNs;
    expect(await perms.request({ permissions: ["downloads"] })).toBe(true);
    const fired: unknown[] = [];
    perms.onAdded.addListener((p) => fired.push(p));
    // "downloads" is already granted: only the new entry is reported
    expect(await perms.request({ permissions: ["downloads", "tabs"] })).toBe(true);
    expect(fired).toEqual([{ permissions: ["tabs"], origins: [] }]);
    // a full re-request fires nothing at all
    fired.length = 0;
    expect(await perms.request({ permissions: ["downloads", "tabs"] })).toBe(true);
    expect(fired).toEqual([]);
  });

  it("onRemoved reports only entries that really left the set (#522)", async () => {
    wireBackend();
    const rec = await install("PermMixedRemove");
    const api = makeApi(rec);
    const perms = api.browser.permissions as unknown as PermsNs;
    expect(await perms.request({ permissions: ["downloads", "tabs"] })).toBe(true);
    const fired: unknown[] = [];
    perms.onRemoved.addListener((p) => fired.push(p));
    // "downloads" and "tabs" are both granted; the refused "cookies"
    // entry exercises the not-granted half of the delta
    expect(await perms.remove({ permissions: ["cookies", "downloads"] })).toBe(true);
    expect(fired).toEqual([{ permissions: ["downloads"], origins: [] }]);
    // revoking already-revoked entries fires nothing
    fired.length = 0;
    expect(await perms.remove({ permissions: ["cookies", "downloads"] })).toBe(true);
    expect(fired).toEqual([]);
  });
});
