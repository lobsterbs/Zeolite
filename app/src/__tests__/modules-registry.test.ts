import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { idbClear, openDb, STORE_MODULES } from "../extensions/idb";
import * as REG from "../modules/registry";

const FIXTURES = new URL("../modules/fixtures/", import.meta.url);

interface ModuleFile {
  manifest: Record<string, unknown>;
  sig: string;
}

function fixture(name: string): ModuleFile {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as ModuleFile;
}

const SAMPLE = "sample-observer.module.json";
const TEST = "test-observer.module.json";
const TEST_V2 = "test-observer-v2.module.json";

async function clearModules(): Promise<void> {
  const db = await openDb();
  await idbClear(db, STORE_MODULES);
}

describe("modules/registry", () => {
  beforeAll(async () => {
    await openDb();
  });

  beforeEach(async () => {
    await clearModules();
  });

  it("installs a signed fixture", async () => {
    const f = fixture(SAMPLE);
    const r = await REG.install({ manifest: f.manifest, sig: f.sig, granted: ["observe:requests"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.id).toBe("im.zeolite.sample-observer");
    expect(r.record.granted).toEqual(["observe:requests"]);
    expect(r.record.state).toBe("installed");
  });

  it("is idempotent for the same signature", async () => {
    const f = fixture(SAMPLE);
    const first = await REG.install({ manifest: f.manifest, sig: f.sig });
    const second = await REG.install({ manifest: f.manifest, sig: f.sig });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.updated).toBe(false);
    expect(second.record.sigHex).toBe(f.sig);
  });

  it("rejects a grant the manifest never declared", async () => {
    const f = fixture(TEST);
    const r = await REG.install({ manifest: f.manifest, sig: f.sig, granted: ["modify:streams"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("not declared");
  });

  it("rejects a tampered signature", async () => {
    const f = fixture(SAMPLE);
    const r = await REG.install({ manifest: f.manifest, sig: fixture(TEST).sig });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("trusted signer key");
  });

  it("rejects an out-of-range engine before any crypto runs", async () => {
    const f = fixture(SAMPLE);
    const hostile = { ...f.manifest, engine: ">=9.9.9" };
    /* A garbage signature proves the range gate runs first. */
    const r = await REG.install({ manifest: hostile, sig: "0".repeat(128) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("range");
  });

  it("revokes one module and keeps the record", async () => {
    const f = fixture(SAMPLE);
    await REG.install({ manifest: f.manifest, sig: f.sig });
    const rev = await REG.revoke("im.zeolite.sample-observer");
    expect(rev.ok).toBe(true);
    const list = await REG.list();
    expect(list).toHaveLength(1);
    expect(list[0].state).toBe("revoked");
    const again = await REG.revoke("im.zeolite.sample-observer");
    expect(again.ok).toBe(true);
  });

  it("revoked modules are excluded from the boot input", async () => {
    const f = fixture(SAMPLE);
    await REG.install({ manifest: f.manifest, sig: f.sig });
    await REG.revoke("im.zeolite.sample-observer");
    expect(await REG.installedRecords()).toHaveLength(0);
  });

  it("revoking a signer key quarantines and blocks reinstalls", async () => {
    const f = fixture(TEST);
    await REG.install({ manifest: f.manifest, sig: f.sig });
    const key = await REG.revokeKey("sample-1");
    expect(key.ok).toBe(true);
    const fresh = fixture(SAMPLE);
    const r = await REG.install({ manifest: fresh.manifest, sig: fresh.sig });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("revoked");
  });

  it("a verified update from the same signer replaces the record", async () => {
    const v1 = fixture(TEST);
    const v2 = fixture(TEST_V2);
    await REG.install({ manifest: v1.manifest, sig: v1.sig });
    const up = await REG.install({ manifest: v2.manifest, sig: v2.sig });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.updated).toBe(true);
    expect(up.record.version).toBe("2.0.0");
    const list = await REG.list();
    expect(list).toHaveLength(1);
  });
});
