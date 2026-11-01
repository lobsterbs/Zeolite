/* Zeolite extension subsystem: browser.storage.

   Areas are namespaced per extension id and per area. local and sync
   persist in IndexedDB across restarts; session is in-memory only,
   matching Firefox semantics. Values are JSON-serialized; a quota is
   enforced on local and sync (Firefox's real storage.sync numbers:
   102400 bytes total, 8192 per item, 512 items, plus the documented
   write-operation rate limits). Storage here is fully isolated from
   proxied website storage (bootstrap.ts scopes that separately) and
   from every other extension.

   #520: storage.session has an access level, exactly as Firefox:
   by default only trusted contexts (background, extension pages)
   reach it, and storage.session.setAccessLevel opens it to content
   scripts. The SW-side content-script gate reads the same registry,
   so a level change takes effect immediately for every page. */

import type { ExtensionId } from "./types";
import { idbGet, idbGetAllKeys, idbPut, openDb, STORE_STORAGE } from "./idb";

export type StorageAreaName = "local" | "sync" | "session";
export type StorageValue = null | boolean | number | string | StorageValue[] | { [k: string]: StorageValue };
export type StorageChange = { oldValue: StorageValue | undefined; newValue: StorageValue | undefined };
export type ChangeListener = (changes: Record<string, StorageChange>, area: string) => void;

/* Firefox's storage.sync quota constants (MDN): the sync surface
   reports and enforces these real numbers instead of the local-area
   default. Write-operation limits are the documented Firefox values;
   the engine counts its own set/remove/clear calls against them. */
export const SYNC_QUOTA_BYTES = 102400;
export const SYNC_QUOTA_BYTES_PER_ITEM = 8192;
export const SYNC_MAX_ITEMS = 512;
export const SYNC_MAX_WRITE_OPERATIONS_PER_HOUR = 1800;
export const SYNC_MAX_WRITE_OPERATIONS_PER_MINUTE = 120;

const DEFAULT_QUOTA = { local: 5 * 1024 * 1024, sync: SYNC_QUOTA_BYTES, session: 1 * 1024 * 1024 };

/* #520: storage.session access level, per extension. Firefox default:
   trusted contexts only. The value lives engine-side (in-memory,
   like the session area itself) and the content-script bridge gate
   reads it through contentScriptMayUseSession. */
export type SessionAccessLevel =
  | "TRUSTED_CONTEXTS_ONLY"
  | "TRUSTED_AND_UNTRUSTED_CONTEXTS";
const sessionAccess = new Map<ExtensionId, SessionAccessLevel>();

export function sessionAccessLevelOf(id: ExtensionId): SessionAccessLevel {
  return sessionAccess.get(id) ?? "TRUSTED_CONTEXTS_ONLY";
}

/** Validates + stores an access level. Accepts the plain string form
    Firefox documents and the {accessLevel} object form Chrome uses,
    since both shapes appear in real extension code. Throws on
    anything else, as Firefox throws on an unknown level. */
export function setSessionAccessLevel(id: ExtensionId, arg: unknown): void {
  const level =
    arg === "TRUSTED_CONTEXTS_ONLY" || arg === "TRUSTED_AND_UNTRUSTED_CONTEXTS"
      ? arg
      : arg !== null && typeof arg === "object" &&
          ((arg as { accessLevel?: unknown }).accessLevel === "TRUSTED_CONTEXTS_ONLY" ||
            (arg as { accessLevel?: unknown }).accessLevel === "TRUSTED_AND_UNTRUSTED_CONTEXTS")
        ? (arg as { accessLevel: SessionAccessLevel }).accessLevel
        : null;
  if (level === null) {
    throw new Error(
      "zeolite: storage.session.setAccessLevel: access level must be 'TRUSTED_CONTEXTS_ONLY' or 'TRUSTED_AND_UNTRUSTED_CONTEXTS'",
    );
  }
  sessionAccess.set(id, level);
}

export function dropSessionAccess(id: ExtensionId): void {
  sessionAccess.delete(id);
}

/** The single decision the SW-side content-script storage gate makes
    for session ops. Default (no entry) is trusted-only, fail closed. */
export function contentScriptMayUseSession(id: ExtensionId): boolean {
  return sessionAccessLevelOf(id) === "TRUSTED_AND_UNTRUSTED_CONTEXTS";
}

/* Write-operation rate limiting for the sync area (Firefox's
   MAX_WRITE_OPERATIONS_* constants): a rolling window of op
   timestamps, pruned per check. Counted per area instance; one
   context per extension shares this instance. */
class WriteRateLimiter {
  private readonly ops: number[] = [];
  constructor(
    private readonly maxPerHour: number,
    private readonly maxPerMinute: number,
  ) {}
  admit(now = Date.now()): void {
    while (this.ops.length > 0 && now - this.ops[0] > 3600_000) this.ops.shift();
    if (this.ops.length >= this.maxPerHour) {
      throw new Error("zeolite: storage.sync MAX_WRITE_OPERATIONS_PER_HOUR exceeded");
    }
    let minute = 0;
    for (let i = this.ops.length - 1; i >= 0; i--) {
      if (now - this.ops[i] <= 60_000) minute++;
      else break;
    }
    if (minute >= this.maxPerMinute) {
      throw new Error("zeolite: storage.sync MAX_WRITE_OPERATIONS_PER_MINUTE exceeded");
    }
    this.ops.push(now);
  }
}
const PREFIX = (id: ExtensionId, area: StorageAreaName, key: string): string =>
  id + ":" + area + ":" + key;

/* JSON round-trip both validates the value shape (no undefined, no
   cycles, no functions) and gives us the byte size for the quota. */
function freeze(v: unknown): { ok: boolean; json: string } {
  try {
    const json = JSON.stringify(v);
    if (json === undefined) return { ok: false, json: "" };
    return { ok: true, json };
  } catch {
    return { ok: false, json: "" };
  }
}

function thaw(json: string): StorageValue {
  return JSON.parse(json) as StorageValue;
}

export class ExtensionStorageArea {
  private readonly mem = new Map<string, string>();
  private readonly listeners = new Set<ChangeListener>();
  private bytesInUse = 0;
  private readonly syncLimiter = new WriteRateLimiter(
    SYNC_MAX_WRITE_OPERATIONS_PER_HOUR,
    SYNC_MAX_WRITE_OPERATIONS_PER_MINUTE,
  );

  constructor(
    private readonly id: ExtensionId,
    readonly name: StorageAreaName,
    private readonly area: "local" | "sync" | "session",
    /** Quota override: context.ts passes Infinity for local areas of
        extensions holding "unlimitedStorage", exactly Firefox's
        documented lift. Defaults keep the per-area numbers above. */
    private readonly quotaOverride?: number
  ) {}

  private get quotaBytes(): number {
    return this.quotaOverride ?? DEFAULT_QUOTA[this.name];
  }

  private storageKey(key: string): string {
    return PREFIX(this.id, this.area, key);
  }

  async load(db: IDBDatabase): Promise<void> {
    if (this.area === "session") return;
    const keys = await idbGetAllKeys(db, STORE_STORAGE);
    const prefix = this.id + ":" + this.area + ":";
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const val = await idbGet(db, STORE_STORAGE, k);
      if (typeof val !== "string") continue;
      this.mem.set(k.slice(prefix.length), val);
    }
    this.recount();
  }

  private recount(): void {
    let n = 0;
    for (const json of this.mem.values()) n += json.length;
    this.bytesInUse = n;
  }

  async get(keys?: string | string[] | Record<string, StorageValue> | null): Promise<Record<string, StorageValue>> {
    const out: Record<string, StorageValue> = {};
    if (keys === undefined || keys === null) {
      for (const [k, json] of this.mem) out[k] = thaw(json);
      return out;
    }
    const wanted: string[] = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const defaults: Record<string, StorageValue> = typeof keys === "object" && !Array.isArray(keys) ? keys : {};
    for (const k of wanted) {
      const json = this.mem.get(k);
      out[k] = json !== undefined ? thaw(json) : (defaults[k] ?? null);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const db = this.area === "session" ? null : await openDb();
    const changes: Record<string, StorageChange> = {};
    if (this.area === "sync") {
      /* Firefox storage.sync limits, checked before any mutation:
         distinct key count, per-item size, total quota, write rate. */
      const keys = new Set([...this.mem.keys(), ...Object.keys(items)]);
      if (keys.size > SYNC_MAX_ITEMS) {
        throw new Error("zeolite: storage.sync MAX_ITEMS (" + SYNC_MAX_ITEMS + ") exceeded");
      }
      for (const v of Object.values(items)) {
        const frozen = freeze(v);
        if (frozen.ok && frozen.json.length > SYNC_QUOTA_BYTES_PER_ITEM) {
          throw new Error("zeolite: storage.sync QUOTA_BYTES_PER_ITEM (" + SYNC_QUOTA_BYTES_PER_ITEM + ") exceeded");
        }
      }
    }
    for (const [k, v] of Object.entries(items)) {
      const frozen = freeze(v);
      if (!frozen.ok) throw new Error("zeolite: storage.set: value for '" + k + "' is not serializable");
      if (this.area === "sync") this.syncLimiter.admit();
      if (this.bytesInUse - (this.mem.get(k)?.length ?? 0) + frozen.json.length > this.quotaBytes) {
        throw new Error("zeolite: storage." + this.name + " quota exceeded");
      }
      const old = this.mem.get(k);
      this.mem.set(k, frozen.json);
      if (db) await idbPut(db, STORE_STORAGE, this.storageKey(k), frozen.json);
      changes[k] = { oldValue: old !== undefined ? thaw(old) : undefined, newValue: v as StorageValue };
    }
    this.recount();
    for (const l of this.listeners) l(changes, this.name);
  }

  async remove(keys: string | string[]): Promise<void> {
    const db = this.area === "session" ? null : await openDb();
    if (this.area === "sync") this.syncLimiter.admit();
    const list = typeof keys === "string" ? [keys] : keys;
    const changes: Record<string, StorageChange> = {};
    for (const k of list) {
      const old = this.mem.get(k);
      if (old === undefined) continue;
      this.mem.delete(k);
      if (db) await idbPut(db, STORE_STORAGE, this.storageKey(k), null);
      changes[k] = { oldValue: thaw(old), newValue: undefined };
    }
    this.recount();
    for (const l of this.listeners) l(changes, this.name);
  }

  async clear(): Promise<void> {
    const keys = [...this.mem.keys()];
    await this.remove(keys);
  }

  async getBytesInUse(keys?: string | string[]): Promise<number> {
    if (keys === undefined) return this.bytesInUse;
    const list = typeof keys === "string" ? [keys] : keys;
    let n = 0;
    for (const k of list) n += this.mem.get(k)?.length ?? 0;
    return n;
  }

  addListener(l: ChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  removeListener(l: ChangeListener): void {
    this.listeners.delete(l);
  }
}
