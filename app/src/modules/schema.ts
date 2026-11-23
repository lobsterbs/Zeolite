/* First-party module format (#542, the signed-module runtime slice of
   docs/plugin-modules-design.md): a module is a canonical manifest
   (this file) plus an Ed25519 signature over those exact canonical
   bytes (modules/verify.ts). The manifest binds an id, a version, an
   engine compatibility range, the declared permission set and the
   distribution file hashes. Validation is fail-closed: every honest
   rejection names a reason string and retains no state. */

export const MODULE_PERMISSIONS = [
  "observe:requests",
  "block:requests",
  "modify:requests",
  "modify:responses",
  "modify:streams",
  "storage:site",
  "spoof:configure",
] as const;
export type ModulePermission = (typeof MODULE_PERMISSIONS)[number];

export interface ModuleManifest {
  id: string;
  version: string;
  engine: string;
  keyId: string;
  permissions: string[];
  entry: string;
  files: Record<string, string>;
}

export type ManifestCheck = { ok: true; manifest: ModuleManifest } | { ok: false; reason: string };

const ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/* Engine ranges accept ">=x.y.z" or ">=x.y.z <a.b.c" and nothing else. */
const RANGE_RE = /^>=(\d+)\.(\d+)\.(\d+)(?: ?<(\d+)\.(\d+)\.(\d+))?$/;
const ENTRY_RE = /^\.\/[A-Za-z0-9._\-\/]+\.ts$/;
const KEYID_RE = /^[a-z0-9-]{1,32}$/;

/** Recursively key-sorted structural copy; arrays keep their order. */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    const src = v as Record<string, unknown>;
    for (const k of Object.keys(src).sort()) o[k] = canonicalize(src[k]);
    return o;
  }
  return v;
}

/** The exact text the signature covers: sorted keys, no whitespace. */
export function canonicalManifest(manifest: unknown): string {
  return JSON.stringify(canonicalize(manifest));
}

export function parseEngineRange(
  range: string,
): { min: [number, number, number]; max?: [number, number, number] } | null {
  const m = RANGE_RE.exec(range);
  if (!m) return null;
  return {
    min: [Number(m[1]), Number(m[2]), Number(m[3])],
    max: m[4] !== undefined ? [Number(m[4]), Number(m[5]), Number(m[6])] : undefined,
  };
}

export function engineAccepts(range: string, version: [number, number, number]): boolean {
  const parsed = parseEngineRange(range);
  if (!parsed) return false;
  const cmp = (x: [number, number, number], y: [number, number, number]) =>
    x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  if (cmp(version, parsed.min) < 0) return false;
  if (parsed.max && cmp(version, parsed.max) >= 0) return false;
  return true;
}

/** Fail-closed manifest validation: shape, grammar, vocabulary. */
export function validateManifest(input: unknown): ManifestCheck {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "manifest is not an object" };
  }
  const m = input as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) return { ok: false, reason: "bad module id" };
  if (typeof m.version !== "string" || !VER_RE.test(m.version)) return { ok: false, reason: "bad version" };
  if (typeof m.engine !== "string" || parseEngineRange(m.engine) === null) {
    return { ok: false, reason: "bad engine range" };
  }
  if (typeof m.keyId !== "string" || !KEYID_RE.test(m.keyId)) return { ok: false, reason: "bad signer key id" };
  if (typeof m.entry !== "string" || !ENTRY_RE.test(m.entry)) return { ok: false, reason: "bad entry" };
  if (!Array.isArray(m.permissions) || m.permissions.length === 0) {
    return { ok: false, reason: "no permissions declared" };
  }
  const vocab = new Set<string>(MODULE_PERMISSIONS);
  const perms: string[] = [];
  for (const p of m.permissions) {
    if (typeof p !== "string" || !vocab.has(p)) return { ok: false, reason: "undeclared permission vocabulary" };
    if (perms.includes(p)) return { ok: false, reason: "duplicate permissions" };
    perms.push(p);
  }
  if (m.files === null || typeof m.files !== "object" || Array.isArray(m.files)) {
    return { ok: false, reason: "bad files map" };
  }
  const files = m.files as Record<string, unknown>;
  const keys = Object.keys(files);
  if (keys.length === 0) return { ok: false, reason: "no files" };
  const out: Record<string, string> = {};
  for (const k of keys) {
    const h = files[k];
    if (typeof h !== "string" || !SHA_RE.test(h)) {
      /* The hash binds the distribution bytes; the engine guards format. */
      return { ok: false, reason: "bad file hash" };
    }
    out[k] = h;
  }
  return {
    ok: true,
    manifest: {
      id: m.id,
      version: m.version,
      engine: m.engine,
      keyId: m.keyId,
      permissions: perms,
      entry: m.entry,
      files: out,
    },
  };
}
