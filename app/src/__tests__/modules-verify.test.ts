import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalManifest, canonicalize, engineAccepts, validateManifest } from "../modules/schema";
import { SIGNER_KEYS, verifyManifest, type SignerKey, verifyWithKeys } from "../modules/verify";

const FIXTURES = new URL("../modules/fixtures/", import.meta.url);

interface ModuleFile {
  manifest: Record<string, unknown>;
  sig: string;
  signerKey: { id?: string };
}

function fixture(name: string): ModuleFile {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as ModuleFile;
}

function hexOf(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

describe("modules/schema", () => {
  it("canonicalizes with sorted keys, order-independent", () => {
    const src = fixture("sample-observer.module.json").manifest;
    const shuffled: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort().reverse()) shuffled[k] = src[k];
    expect(canonicalManifest(shuffled)).toEqual(canonicalManifest(src));
    expect(canonicalManifest(shuffled)).toEqual(JSON.stringify(canonicalize(shuffled)));
  });

  it("accepts the engine exactly at the inclusive range edges", () => {
    expect(engineAccepts(">=3.4.5", [3, 4, 4])).toBe(false);
    expect(engineAccepts(">=3.4.5", [3, 4, 5])).toBe(true);
    expect(engineAccepts(">=3.4.5", [3, 5, 0])).toBe(true);
    expect(engineAccepts(">=3.4.5 <4.0.0", [3, 9, 9])).toBe(true);
    expect(engineAccepts(">=3.4.5 <4.0.0", [4, 0, 0])).toBe(false);
    expect(engineAccepts("3.4.5", [3, 4, 5])).toBe(false);
    expect(engineAccepts(">=3.4", [3, 4, 0])).toBe(false);
  });

  it("rejects every malformed shape with a reason", () => {
    const good = () => fixture("sample-observer.module.json").manifest;
    const cases: Array<[() => unknown, string]> = [
      [() => null, "not an object"],
      [() => [], "not an object"],
      [() => ({ ...good(), id: "has space" }), "module id"],
      [() => ({ ...good(), version: "1.0" }), "version"],
      [() => ({ ...good(), engine: "3.4.5" }), "engine range"],
      [() => ({ ...good(), keyId: "over-32-chars-aaaaaaaaaaaaaaaaaaaaaaaa" }), "signer key id"],
      [() => ({ ...good(), entry: "fixtures/no-dot.ts" }), "entry"],
      [() => ({ ...good(), permissions: [] }), "permissions declared"],
      [() => ({ ...good(), permissions: ["read:mind"] }), "vocab"],
      [() => ({ ...good(), permissions: ["observe:requests", "observe:requests"] }), "duplicate"],
      [() => ({ ...good(), files: {} }), "files"],
      [() => ({ ...good(), files: { "./x.ts": "not-hex" } }), "file hash"],
    ];
    for (const [make, needle] of cases) {
      const check = validateManifest(make());
      expect(check.ok, needle).toBe(false);
      expect((check as { reason?: string }).reason ?? "").toContain(needle);
    }
    expect(validateManifest(good()).ok).toBe(true);
  });
});

describe("modules/verify", () => {
  it("verifies every shipped fixture against sample-1", async () => {
    for (const name of [
      "sample-observer.module.json",
      "test-observer.module.json",
      "test-observer-v2.module.json",
    ]) {
      const f = fixture(name);
      expect(await verifyManifest(f.manifest, f.sig)).toBe("sample-1");
    }
  });

  it("rejects a tampered manifest without retaining state", async () => {
    const f = fixture("sample-observer.module.json");
    const tampered = { ...f.manifest, version: "9.9.9" };
    expect(await verifyManifest(tampered, f.sig)).toBeNull();
    /* The untouched record still verifies afterwards: no retained failure. */
    expect(await verifyManifest(f.manifest, f.sig)).toBe("sample-1");
  });

  it("rejects malformed signatures fail-closed", async () => {
    const f = fixture("sample-observer.module.json");
    expect(await verifyManifest(f.manifest, "nothex")).toBeNull();
    expect(await verifyManifest(f.manifest, "aabb")).toBeNull();
    expect(await verifyManifest(f.manifest, "zz".repeat(64))).toBeNull();
  });

  it("verifies a fresh throwaway keypair and rejects a foreign key", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "Ed25519" } as Algorithm,
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const manifest = fixture("sample-observer.module.json").manifest;
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" } as Algorithm,
      pair.privateKey,
      new TextEncoder().encode(canonicalManifest(manifest)),
    );
    const threw: SignerKey[] = [
      { id: "throwaway", publicHex: hexOf(await crypto.subtle.exportKey("raw", pair.publicKey)) },
    ];
    expect(await verifyWithKeys(threw, canonicalManifest(manifest), hexOf(sig))).toBe("throwaway");
    /* A signature from a key the engine never trusted matches nothing. */
    expect(await verifyWithKeys(SIGNER_KEYS, canonicalManifest(manifest), hexOf(sig))).toBeNull();
  });
});
