/* Zeolite extension subsystem: manager.

   Owns the lifecycle (installing, installed, starting, running,
   stopping, disabled, uninstalled, error), persistence of package
   files and metadata (IndexedDB: service workers have no filesystem),
   and every public operation. A malformed package or a failing
   operation lands that one extension in ERROR; the manager itself
   never takes the host down with it. */

import {
  idbDelete,
  idbGet,
  idbGetAll,
  idbGetAllKeys,
  idbPut,
  openDb,
  STORE_FILES,
  STORE_META,
} from "./idb";
import { locateManifest, readZip, DEFAULT_ZIP_LIMITS } from "./package";
import { parseManifest } from "./manifest";
import { normalizeExtensionPath } from "./origin";
import { globToRegExp } from "./content-scripts";
import { hostPatternsMatch } from "./permissions";
import { ALARMS } from "./alarms";
import type { ExtensionId, ExtensionRecord } from "./types";

export type LifecycleListener = (rec: ExtensionRecord) => void;

export interface InstallResult {
  id: ExtensionId;
  warnings: string[];
  unsupportedFields: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeRecord(v: unknown): ExtensionRecord | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || typeof v.name !== "string") return null;
  if (v.manifestVersion !== 2 && v.manifestVersion !== 3) return null;
  return v as unknown as ExtensionRecord;
}

export class ExtensionManager {
  private readonly exts = new Map<ExtensionId, ExtensionRecord>();
  private readonly lifecycle = new Set<LifecycleListener>();
  private started = false;

  onLifecycle(l: LifecycleListener): () => void {
    this.lifecycle.add(l);
    return () => this.lifecycle.delete(l);
  }

  private changed(id: ExtensionId): void {
    const rec = this.exts.get(id);
    if (rec) for (const l of this.lifecycle) l(rec);
  }

  /* Load persisted extensions. Safe to call repeatedly. */
  async startup(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const db = await openDb();
      const metas = await idbGetAll(db, STORE_META);
      for (const m of metas) {
        const rec = looksLikeRecord(m);
        if (rec) this.exts.set(rec.id, rec);
      }
    } catch (e) {
      /* Persistence unavailable: run with nothing installed rather
         than failing the host. */
      this.exts.clear();
      void e;
    }
  }

  private async deriveId(manifestBytes: Uint8Array): Promise<ExtensionId> {
    const copy = manifestBytes.slice();
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, 32);
  }

  async installFromZip(bytes: Uint8Array): Promise<InstallResult> {
    const files = await readZip(bytes, DEFAULT_ZIP_LIMITS);
    return this.installFiles(files);
  }

  /* Install from an unpacked directory listing (path -> bytes). */
  async installFiles(files: Map<string, Uint8Array>): Promise<InstallResult> {
    const loc = locateManifest(files);
    if (!loc) throw new Error("zeolite: no manifest.json found in package");
    const mbytes = files.get(loc.manifestPath);
    if (!mbytes) throw new Error("zeolite: manifest.json is empty");
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(mbytes));
    } catch (e) {
      throw new Error("zeolite: manifest.json is not valid JSON: " + String(e));
    }
    const { ok, parsed, diags } = parseManifest(raw);
    if (!ok || parsed === null) {
      throw new Error("zeolite: manifest invalid: " + diags.errors.join("; "));
    }
    const id = await this.deriveId(mbytes);
    if (this.exts.has(id)) {
      throw new Error("zeolite: extension already installed (" + parsed.name + ")");
    }
    const rec: ExtensionRecord = {
      ...parsed,
      id,
      state: "installed",
      enabled: true,
      installTime: Date.now(),
      lastError: null,
    };
    const db = await openDb();
    try {
      await idbPut(db, STORE_META, id, rec);
      for (const [p, data] of files) {
        const rel = loc.root !== "" && p.startsWith(loc.root) ? p.slice(loc.root.length) : p;
        await idbPut(db, STORE_FILES, id + ":" + rel, data);
      }
    } catch (e) {
      rec.state = "error";
      rec.lastError = "install failed: " + String(e);
      this.changed(id);
      throw new Error("zeolite: install failed while persisting: " + String(e));
    }
    this.exts.set(id, rec);
    this.changed(id);
    return { id, warnings: diags.warnings, unsupportedFields: diags.unsupportedFields };
  }

  private async storedFiles(id: ExtensionId): Promise<Map<string, Uint8Array>> {
    const db = await openDb();
    const keys = await idbGetAllKeys(db, STORE_FILES);
    const prefix = id + ":";
    const out = new Map<string, Uint8Array>();
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const val = await idbGet(db, STORE_FILES, k);
      if (val instanceof Uint8Array) out.set(k.slice(prefix.length), val);
    }
    return out;
  }

  async uninstall(id: ExtensionId): Promise<void> {
    const rec = this.exts.get(id);
    if (!rec) throw new Error("zeolite: no such extension: " + id);
    const db = await openDb();
    await idbDelete(db, STORE_META, id);
    const keys = await idbGetAllKeys(db, STORE_FILES);
    for (const k of keys) {
      if (k.startsWith(id + ":")) await idbDelete(db, STORE_FILES, k);
    }
    rec.state = "uninstalled";
    rec.enabled = false;
    /* Lifecycle fires before the record leaves the map so
       management/extension events observe the transition. */
    this.changed(id);
    this.exts.delete(id);
    ALARMS.drop(id);
  }

  async setEnabled(id: ExtensionId, enabled: boolean): Promise<void> {
    const rec = this.exts.get(id);
    if (!rec) throw new Error("zeolite: no such extension: " + id);
    if (rec.enabled === enabled) return;
    rec.enabled = enabled;
    rec.state = enabled ? "installed" : "disabled";
    const db = await openDb();
    await idbPut(db, STORE_META, id, rec);
    this.changed(id);
  }

  /* Re-parse the stored package: fresh manifest, same identity. */
  async reload(id: ExtensionId): Promise<void> {
    const rec = this.exts.get(id);
    if (!rec) throw new Error("zeolite: no such extension: " + id);
    const files = await this.storedFiles(id);
    const mbytes = files.get("manifest.json");
    if (!mbytes) throw new Error("zeolite: stored package lost its manifest");
    const { ok, parsed, diags } = parseManifest(JSON.parse(new TextDecoder().decode(mbytes)));
    if (!ok || parsed === null) {
      rec.state = "error";
      rec.lastError = "reload failed: " + diags.errors.join("; ");
      this.changed(id);
      throw new Error("zeolite: reload failed: manifest no longer valid");
    }
    Object.assign(rec, parsed);
    rec.state = "installed";
    rec.lastError = null;
    const db = await openDb();
    await idbPut(db, STORE_META, id, rec);
    this.changed(id);
  }

  /* Lifecycle state transition from the runtime (background boot,
     crash capture). Persists so DevTools/UI can show it after a SW
     restart. */
  setState(
    id: ExtensionId,
    state: ExtensionRecord["state"],
    lastError: string | null,
  ): void {
    const rec = this.exts.get(id);
    if (!rec) return;
    rec.state = state;
    rec.lastError = lastError;
    this.changed(id);
    void openDb()
      .then((db) => idbPut(db, STORE_META, id, rec))
      .catch(() => undefined);
  }

  /* Advanced permissions: grant/revoke of manifest optional
     permissions. Firefox asks the user; the engine has no prompt UI,
     so request() auto-grants anything the manifest declared optional
     (documented in ./compat). Anything NOT declared optional is
     refused - permissions can never be self-escalated. */
  async grantOptional(
    id: ExtensionId,
    perms: { permissions?: string[]; origins?: string[] },
  ): Promise<ExtensionRecord | null> {
    const rec = this.exts.get(id);
    if (!rec) return null;
    const named = perms.permissions ?? [];
    const origins = perms.origins ?? [];
    for (const p of [...named, ...origins]) {
      if (!rec.optionalPermissions.includes(p)) return null;
    }
    for (const p of named) {
      if (!rec.permissions.includes(p)) rec.permissions.push(p);
    }
    for (const p of origins) {
      if (!rec.hostPermissions.includes(p)) rec.hostPermissions.push(p);
    }
    void openDb()
      .then((db) => idbPut(db, STORE_META, id, rec))
      .catch(() => undefined);
    this.changed(id);
    return { ...rec };
  }

  async revokeOptional(
    id: ExtensionId,
    perms: { permissions?: string[]; origins?: string[] },
  ): Promise<ExtensionRecord | null> {
    const rec = this.exts.get(id);
    if (!rec) return null;
    const named = perms.permissions ?? [];
    const origins = perms.origins ?? [];
    rec.permissions = rec.permissions.filter((p) => !named.includes(p));
    rec.hostPermissions = rec.hostPermissions.filter((p) => !origins.includes(p));
    void openDb()
      .then((db) => idbPut(db, STORE_META, id, rec))
      .catch(() => undefined);
    this.changed(id);
    return { ...rec };
  }

  /* Shallow clones: callers cannot mutate manager state. */
  list(): ExtensionRecord[] {
    return Array.from(this.exts.values()).map((r) => ({ ...r }));
  }

  get(id: ExtensionId): ExtensionRecord | null {
    const rec = this.exts.get(id);
    return rec ? { ...rec } : null;
  }

  /* Resource resolution through the extension origin. Websites only
     reach paths the manifest exposes via web_accessible_resources;
     extension contexts can reach everything. */
  async getResource(
    id: ExtensionId,
    path: string,
    opts: { fromWeb: boolean; pageUrl?: string | null }
  ): Promise<Uint8Array | null> {
    const rec = this.exts.get(id);
    if (!rec || !rec.enabled) return null;
    const norm = normalizeExtensionPath(path.startsWith("/") ? path : "/" + path);
    if (norm === null) return null;
    if (opts.fromWeb) {
      /* WAR globs are package-root-relative while globToRegExp is
         anchored (^...$), so test both the origin-absolute and the
         root-relative form of the path: MV2 globs like "public/*"
         must match "/public/x.js". */
      const warGlobHit = (g: string): boolean => {
        const re = globToRegExp(g);
        return re.test(norm) || re.test(norm.slice(1));
      };
      const okWar = rec.webAccessibleResources.some(warGlobHit);
      if (!okWar) {
        /* #51: MV3 web_accessible_resources entries with "matches" are
           scope-bound to the requesting page. The page destination is
           SW-observed only; without one this fails closed. */
        const pageUrl = opts.pageUrl;
        let okScoped = false;
        if (pageUrl) {
          for (const s of rec.webAccessibleScoped ?? []) {
            if (s.resources.some(warGlobHit) && hostPatternsMatch(s.matches, pageUrl)) {
              okScoped = true;
              break;
            }
          }
        }
        if (!okScoped) return null;
      }
    }
    const db = await openDb();
    /* Package paths are stored without the leading slash; the origin
       normalizer adds one. Accept both so manifest-relative and
       origin-absolute lookups both resolve. */
    let val = await idbGet(db, STORE_FILES, id + ":" + norm);
    if (val === undefined) val = await idbGet(db, STORE_FILES, id + ":" + norm.slice(1));
    return val instanceof Uint8Array ? val : null;
  }
}

export const extensions = new ExtensionManager();
