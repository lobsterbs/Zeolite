/* Signed-module lifecycle (#542): install, revoke and list for
   origin-local first-party module records, persisted in the extension
   IDB (modules store). Everything fails closed with a reason string
   and bounded diagnostics: a module with an invalid signature, a
   signer-key conflict, an engine-range miss or an undeclared grant
   is rejected and retains no state. Revocation is a state flag (the
   record stays for forensics); key revocation quarantines every
   module of that signer. */

import { DIAG } from "../diag";
import { idbGet, idbGetAllKeys, idbPut, openDb, STORE_MODULES } from "../extensions/idb";
import { ZEOLITE_VERSION } from "../swstate";
import { canonicalManifest, engineAccepts, validateManifest, type ModuleManifest } from "./schema";
import { verifyManifest } from "./verify";

export interface ModuleRecord {
  id: string;
  version: string;
  engine: string;
  keyId: string;
  entry: string;
  files: Record<string, string>;
  permissions: string[];
  granted: string[];
  canonical: string;
  sigHex: string;
  state: "installed" | "revoked";
  revokedAt?: number;
}

type KeyRevocation = { keyRevoked: true };

/** Narrowing helper: the store also holds quarantine marker records
    (signer-key:<id>); real module records never carry keyRevoked. */
function isKeyRevocation(r: ModuleRecord | KeyRevocation): r is KeyRevocation {
  return (r as KeyRevocation).keyRevoked === true;
}

function engineVersionTriple(): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(ZEOLITE_VERSION);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

const SIG_RE = /^[0-9a-f]{128}$/;

export type InstallResult =
  | { ok: true; record: ModuleRecord; updated: boolean }
  | { ok: false; reason: string };

/** Install (host-driven): validate, range-check, verify the Ed25519
    signature against the compiled-in keys, then persist. The same
    signature twice is an idempotent success; a verified update from
    the same signer replaces the record; any other id collision
    fails closed. */
export async function install(input: {
  manifest: unknown;
  sig?: unknown;
  granted?: unknown;
}): Promise<InstallResult> {
  const check = validateManifest(input.manifest);
  if (!check.ok) return { ok: false, reason: check.reason };
  const manifest: ModuleManifest = check.manifest;
  if (typeof input.sig !== "string" || !SIG_RE.test(input.sig)) {
    return { ok: false, reason: "bad signature encoding" };
  }
  /* Cheap range check first: a module for another engine line is
     rejected before any crypto runs. */
  if (!engineAccepts(manifest.engine, engineVersionTriple())) {
    return { ok: false, reason: "engine range rejects module" };
  }
  const verifiedKey = await verifyManifest(manifest, input.sig);
  if (verifiedKey === null || verifiedKey !== manifest.keyId) {
    return { ok: false, reason: "signature does not match a trusted signer key" };
  }
  const granted: string[] = [];
  const wanted: readonly unknown[] = Array.isArray(input.granted) ? input.granted : manifest.permissions;
  for (const p of wanted) {
    if (typeof p !== "string" || !manifest.permissions.includes(p)) {
      return { ok: false, reason: "grant not declared by the module" };
    }
    if (!granted.includes(p)) granted.push(p);
  }
  const db = await openDb();
  if (await isKeyRevoked(db, manifest.keyId)) {
    return { ok: false, reason: "signer key is revoked" };
  }
  const record: ModuleRecord = {
    id: manifest.id,
    version: manifest.version,
    engine: manifest.engine,
    keyId: manifest.keyId,
    entry: manifest.entry,
    files: manifest.files,
    permissions: manifest.permissions,
    granted,
    canonical: canonicalManifest(manifest),
    sigHex: input.sig,
    state: "installed",
  };
  const existing = await readRecord(db, manifest.id);
  const prior = existing && !isKeyRevocation(existing) ? existing : undefined;
  if (prior) {
    if (prior.keyId !== record.keyId) {
      /* Uncovered by tests (needs two trusted signer keys): a
         different signer for a live id is a hard conflict. */
      return { ok: false, reason: "module id already held by another signer" };
    }
    if (prior.sigHex === record.sigHex) return { ok: true, record, updated: false };
  }
  const prev = prior?.version ?? "(none)";
  await idbPut(db, STORE_MODULES, record.id, record);
  DIAG.emit({
    category: "RUNTIME",
    severity: "info",
    message: "module installed: " + record.id + " " + record.version + " (was " + prev + ")",
  });
  return { ok: true, record, updated: true };
}

async function readRecord(db: IDBDatabase, id: string): Promise<ModuleRecord | KeyRevocation | undefined> {
  return (await idbGet(db, STORE_MODULES, id)) as ModuleRecord | KeyRevocation | undefined;
}

async function isKeyRevoked(db: IDBDatabase, keyId: string): Promise<boolean> {
  const rec = await readRecord(db, "signer-key:" + keyId);
  return rec !== undefined;
}

/** Revoke one module: its hooks unbind at the next boot and its
    retained record is quarantine-flagged, not deleted. */
export async function revoke(id: string): Promise<{ ok: boolean; reason?: string }> {
  if (typeof id !== "string" || id.length === 0 || id.startsWith("signer-key:")) {
    return { ok: false, reason: "bad module id" };
  }
  const db = await openDb();
  const rec = await readRecord(db, id);
  if (!rec || (rec as KeyRevocation).keyRevoked) return { ok: false, reason: "no such module" };
  const r = rec as ModuleRecord;
  r.state = "revoked";
  r.revokedAt = Date.now();
  await idbPut(db, STORE_MODULES, r.id, r);
  DIAG.emit({
    category: "RUNTIME",
    severity: "info",
    message: "module revoked: " + r.id,
  });
  return { ok: true };
}

/** Revoke a signer key: quarantines every module that key signed and
    refuses future installs from it (fleet-wide kill on next boot). */
export async function revokeKey(keyId: string): Promise<{ ok: boolean; count: number }> {
  if (typeof keyId !== "string" || keyId.length === 0) return { ok: false, count: 0 };
  const db = await openDb();
  const keys = await idbGetAllKeys(db, STORE_MODULES);
  let count = 0;
  for (const k of keys) {
    if (typeof k !== "string" || k.startsWith("signer-key:")) continue;
    const rec = (await readRecord(db, k)) as ModuleRecord | undefined;
    if (rec && rec.keyId === keyId && rec.state === "installed") {
      rec.state = "revoked";
      rec.revokedAt = Date.now();
      await idbPut(db, STORE_MODULES, rec.id, rec);
      count++;
    }
  }
  if (!(await isKeyRevoked(db, keyId))) {
    await idbPut(db, STORE_MODULES, "signer-key:" + keyId, { keyRevoked: true } satisfies KeyRevocation);
  }
  DIAG.emit({
    category: "RUNTIME",
    severity: "info",
    message: "signer key revoked: " + keyId + " (" + count + " modules quarantined)",
  });
  return { ok: true, count };
}

/** Boot input for bind.ts: the installed (non-revoked) records. */
export async function installedRecords(): Promise<ModuleRecord[]> {
  const db = await openDb();
  const keys = await idbGetAllKeys(db, STORE_MODULES);
  const out: ModuleRecord[] = [];
  for (const k of keys) {
    if (typeof k !== "string" || k.startsWith("signer-key:")) continue;
    const rec = (await readRecord(db, k)) as ModuleRecord | KeyRevocation | undefined;
    if (rec && !(rec as KeyRevocation).keyRevoked && (rec as ModuleRecord).state === "installed") {
      out.push(rec as ModuleRecord);
    }
  }
  return out;
}

/** Host display surface: summaries only, no signatures. */
export async function list(): Promise<
  Array<{ id: string; version: string; keyId: string; granted: string[]; state: string }>
> {
  const db = await openDb();
  const keys = await idbGetAllKeys(db, STORE_MODULES);
  const out: Array<{ id: string; version: string; keyId: string; granted: string[]; state: string }> = [];
  for (const k of keys) {
    if (typeof k !== "string" || k.startsWith("signer-key:")) continue;
    const rec = (await readRecord(db, k)) as ModuleRecord | KeyRevocation | undefined;
    if (rec && !(rec as KeyRevocation).keyRevoked) {
      const r = rec as ModuleRecord;
      out.push({ id: r.id, version: r.version, keyId: r.keyId, granted: r.granted, state: r.state });
    }
  }
  return out;
}
