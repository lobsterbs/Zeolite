/* Zeolite extension subsystem: programmatically registered content
   scripts (#520 wave: contentScripts.register, userScripts.register,
   scripting.registerContentScripts/unregisterContentScripts/
   getRegisteredContentScripts/updateContentScripts).

   One persistent registration list per extension id, stored in the
   subsystem's IndexedDB (cs-registrations) and merged into the same
   resolution the manifest's content_scripts entries feed
   (content-scripts.ts), so registered scripts run through the exact
   same injection pipeline: same match grammar, same per-entry
   bridge, same #285 file scoping, same page-world honestly that
   manifest scripts document in compat.ts.

   Firefox semantics kept:
   - contentScripts.register/userScripts.register persist across
     restarts by definition; the handle's unregister() is the only
     removal surface.
   - scripting.registerContentScripts honors persistAcrossSessions
     (default true); false registrations live for this worker life
     only and are answered honestly by getRegisteredContentScripts
     until then.
   - A scripting id must be unique per extension: a duplicate id
     rejects instead of silently replacing.
   - A registration with zero executable files (no js, no css)
     rejects: Firefox refuses a script that cannot run. */

import type { ContentScriptSpec, ExtensionId } from "./types";
import { parseHostPattern } from "./permissions";
import { openDb, idbPut, idbDelete, STORE_CSREG } from "./idb";

export type RegistrationOrigin = "contentScripts" | "scripting" | "userScripts";

export interface RegisteredScript {
  /** API id (scripting) or engine-generated opaque id (legacy APIs). */
  id: string;
  origin: RegistrationOrigin;
  spec: ContentScriptSpec;
  persist: boolean;
  registeredAt: number;
}

interface PersistedRecord {
  nextSeq: number;
  scripts: RegisteredScript[];
}

const CSREG_WARN = "zeolite: content-script registrations degraded to memory-only";

/* The JS APIs speak camelCase; the resolution grammar speaks the
   manifest's snake_case. Normalize once at the boundary. */
export interface RegistrationOptions {
  matches?: unknown;
  excludeMatches?: unknown;
  includeGlobs?: unknown;
  excludeGlobs?: unknown;
  allFrames?: unknown;
  matchAboutBlank?: unknown;
  runAt?: unknown;
  js?: unknown;
  css?: unknown;
  id?: unknown;
  persistAcrossSessions?: unknown;
}

const strArray = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x === "") return null;
    out.push(x);
  }
  return out;
};

/* js/css entries: {file} references into the extension package. The
   inline {code} form is a documented ceiling (compat.ts): the bridge
   serves package files through the #285 scoped route, so a code
   string would need a package path to live at. Firefox's legacy
   APIs take files only here anyway; userScripts' code form is the
   one honest miss. */
const fileList = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("zeolite: " + what + " must be an array of {file}");
  const out: string[] = [];
  for (const e of v) {
    if (typeof e === "string") {
      /* Tolerate the shorthand some callers use: plain path strings. */
      out.push(e.startsWith("/") ? e : "/" + e);
      continue;
    }
    if (e === null || typeof e !== "object" || typeof (e as { file?: unknown }).file !== "string") {
      throw new Error("zeolite: " + what + " entries must be {file: string}");
    }
    const f = (e as { file: string }).file;
    if (f === "") throw new Error("zeolite: " + what + " {file} cannot be empty");
    out.push(f.startsWith("/") ? f : "/" + f);
  }
  return out;
};

/* Optional string arrays reject on invalid entries instead of
   silently dropping them (the #285 lesson at the API boundary). */
function mustBeStrArray(v: unknown, what: string): string[] {
  const arr = strArray(v);
  if (arr === null) {
    throw new Error("zeolite: " + what + " must be an array of non-empty strings");
  }
  return arr;
}

/** Normalize/validate one registration against the Firefox grammar.
    Throws (rejects) on a bad one; never silently drops fields. */
export function normalizeRegistration(
  opts: RegistrationOptions,
  origin: RegistrationOrigin,
  requireId: boolean,
): { id: string | null; spec: ContentScriptSpec; persist: boolean } {
  const matches = strArray(opts.matches);
  if (matches === null || matches.length === 0) {
    throw new Error("zeolite: registration requires a non-empty matches array");
  }
  for (const p of matches) {
    if (parseHostPattern(p) === null) {
      throw new Error("zeolite: invalid match pattern: " + p);
    }
  }
  const excludeMatches =
    opts.excludeMatches === undefined ? [] : mustBeStrArray(opts.excludeMatches, "excludeMatches");
  const includeGlobs =
    opts.includeGlobs === undefined ? [] : mustBeStrArray(opts.includeGlobs, "includeGlobs");
  const excludeGlobs =
    opts.excludeGlobs === undefined ? [] : mustBeStrArray(opts.excludeGlobs, "excludeGlobs");
  const js = fileList(opts.js, "js");
  const css = fileList(opts.css, "css");
  if (js.length === 0 && css.length === 0) {
    throw new Error("zeolite: registration needs at least one js or css file");
  }
  const allFrames = opts.allFrames === undefined ? false : opts.allFrames === true;
  const matchAboutBlank = opts.matchAboutBlank === undefined ? false : opts.matchAboutBlank === true;
  const runAt =
    opts.runAt === undefined || opts.runAt === "document_idle"
      ? "document_idle"
      : opts.runAt === "document_start" || opts.runAt === "document_end"
        ? opts.runAt
        : null;
  if (runAt === null) {
    throw new Error("zeolite: runAt must be document_start, document_end or document_idle");
  }
  if (opts.id !== undefined && typeof opts.id !== "string") {
    throw new Error("zeolite: registration id must be a string");
  }
  if (requireId && (typeof opts.id !== "string" || opts.id === "")) {
    throw new Error("zeolite: scripting registrations require an id");
  }
  const persist = origin === "scripting" ? opts.persistAcrossSessions !== false : true;
  return {
    id: typeof opts.id === "string" && opts.id !== "" ? opts.id : null,
    spec: {
      matches,
      exclude_matches: excludeMatches,
      include_globs: includeGlobs,
      exclude_globs: excludeGlobs,
      js,
      css,
      run_at: runAt,
      all_frames: allFrames,
      match_about_blank: matchAboutBlank,
    },
    persist,
  };
}

export class RegistrationStore {
  private readonly byExt = new Map<ExtensionId, PersistedRecord>();
  private hydrated = false;

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    let rows: unknown[];
    try {
      const db = await openDb();
      rows = (await idbGetAllKeysSafe(db)) as unknown[];
    } catch {
      console.warn(CSREG_WARN);
      return;
    }
    for (const row of rows as Array<{ key: string; value: unknown }>) {
      const rec = row?.value as PersistedRecord | null;
      if (!rec || !Array.isArray(rec.scripts)) continue;
      const clean = rec.scripts.filter(
        (s) => s !== null && typeof s === "object" && typeof (s as RegisteredScript).id === "string" && (s as RegisteredScript).spec !== null,
      );
      this.byExt.set(row.key as ExtensionId, {
        nextSeq: typeof rec.nextSeq === "number" ? rec.nextSeq : clean.length,
        scripts: clean,
      });
    }
  }

  /** Register one script for an extension. Duplicate ids reject.
      Returns the stored registration. */
  register(
    extId: ExtensionId,
    opts: RegistrationOptions,
    origin: RegistrationOrigin,
  ): RegisteredScript {
    const { id, spec, persist } = normalizeRegistration(opts, origin, origin === "scripting");
    const rec = this.ensure(extId);
    if (id !== null && rec.scripts.some((s) => s.id === id)) {
      throw new Error("zeolite: duplicate registration id: " + id);
    }
    const script: RegisteredScript = {
      id: id ?? origin + "-" + ++rec.nextSeq,
      origin,
      spec,
      persist,
      registeredAt: Date.now(),
    };
    rec.scripts.push(script);
    if (persist) void this.persistOne(extId).catch(() => console.warn(CSREG_WARN));
    return { ...script, spec: { ...script.spec } };
  }

  /** updateContentScripts: merge new fields into one id; unknown id
      rejects (Firefox: InvalidIndex, not a silent no-op). */
  update(extId: ExtensionId, opts: RegistrationOptions): RegisteredScript {
    if (typeof opts.id !== "string" || opts.id === "") {
      throw new Error("zeolite: update requires an id");
    }
    const rec = this.byExt.get(extId);
    const hit = rec?.scripts.find((s) => s.id === opts.id);
    if (!rec || !hit) {
      throw new Error("zeolite: no registered script with id: " + opts.id);
    }
    const merged: RegistrationOptions = {
      matches: opts.matches ?? hit.spec.matches,
      excludeMatches: opts.excludeMatches ?? hit.spec.exclude_matches,
      includeGlobs: opts.includeGlobs ?? hit.spec.include_globs,
      excludeGlobs: opts.excludeGlobs ?? hit.spec.exclude_globs,
      allFrames: opts.allFrames ?? hit.spec.all_frames,
      matchAboutBlank: opts.matchAboutBlank ?? hit.spec.match_about_blank,
      runAt: opts.runAt ?? hit.spec.run_at,
      js: opts.js ?? hit.spec.js.map((f) => ({ file: f })),
      css: opts.css ?? hit.spec.css.map((f) => ({ file: f })),
      id: opts.id,
    };
    const { spec } = normalizeRegistration(merged, "scripting", true);
    hit.spec = spec;
    if (hit.persist) void this.persistOne(extId).catch(() => console.warn(CSREG_WARN));
    return { ...hit, spec: { ...hit.spec } };
  }

  /** unregisterContentScripts(ids?)/drop: without ids every
      registration of the extension goes. False only when nothing
      matched (Firefox resolves false for an unknown id). */
  unregister(extId: ExtensionId, ids?: string[]): boolean {
    const rec = this.byExt.get(extId);
    if (!rec) return false;
    const before = rec.scripts.length;
    rec.scripts = ids === undefined ? [] : rec.scripts.filter((s) => !ids.includes(s.id));
    if (rec.scripts.length === before) return false;
    if (rec.scripts.length === 0) {
      this.byExt.delete(extId);
      void this.forgetOne(extId);
    } else {
      void this.persistOne(extId).catch(() => console.warn(CSREG_WARN));
    }
    return true;
  }

  /** Uninstall/reset cleanup: drop everything the extension
      registered. */
  dropAll(extId: ExtensionId): void {
    this.byExt.delete(extId);
    void this.forgetOne(extId);
  }

  /** The merge surface: registered specs in registration order. */
  specsFor(extId: ExtensionId): ContentScriptSpec[] {
    const rec = this.byExt.get(extId);
    return rec ? rec.scripts.map((s) => s.spec) : [];
  }

  /** getRegisteredContentScripts: full API view, copies only. */
  recordsFor(extId: ExtensionId): RegisteredScript[] {
    const rec = this.byExt.get(extId);
    return rec ? rec.scripts.map((s) => ({ ...s, spec: { ...s.spec } })) : [];
  }

  private ensure(extId: ExtensionId): PersistedRecord {
    let rec = this.byExt.get(extId);
    if (!rec) {
      rec = { nextSeq: 0, scripts: [] };
      this.byExt.set(extId, rec);
    }
    return rec;
  }

  private async persistOne(extId: ExtensionId): Promise<void> {
    const rec = this.byExt.get(extId);
    if (!rec) return;
    const db = await openDb();
    const payload: PersistedRecord = {
      nextSeq: rec.nextSeq,
      scripts: rec.scripts.filter((s) => s.persist),
    };
    await idbPut(db, STORE_CSREG, extId, payload);
  }

  private async forgetOne(extId: ExtensionId): Promise<void> {
    try {
      const db = await openDb();
      await idbDelete(db, STORE_CSREG, extId);
    } catch {
      console.warn(CSREG_WARN);
    }
  }

  /** Tests only. */
  resetForTests(): void {
    this.byExt.clear();
    this.hydrated = false;
  }
}

/* getAll with keys: the records themselves do not echo their key,
   so hydrate reads entries as (key, value) pairs. */
async function idbGetAllKeysSafe(db: IDBDatabase): Promise<unknown[]> {
  const store = db.transaction(STORE_CSREG, "readonly").objectStore(STORE_CSREG);
  return new Promise((resolve, reject) => {
    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      const keys = keysReq.result;
      const out: Array<{ key: string; value: unknown }> = [];
      let pending = keys.length;
      if (pending === 0) return resolve(out);
      for (const k of keys) {
        const vReq = store.get(k);
        vReq.onsuccess = () => {
          out.push({ key: String(k), value: vReq.result });
          if (--pending === 0) resolve(out);
        };
        vReq.onerror = () => reject(vReq.error ?? new Error("zeolite: csreg read failed"));
      }
    };
    keysReq.onerror = () => reject(keysReq.error ?? new Error("zeolite: csreg keys failed"));
  });
}

export const REGISTRATIONS = new RegistrationStore();
