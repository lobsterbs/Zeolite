/* Zeolite extension subsystem: runtime.alarms.

   Timed alarms for extensions in the engine's shared service-worker
   context. Firing an alarm wakes an idle MV3 service-worker background
   first (the wake hook is wired by the host; without one, alarms
   dispatch directly), then delivers to the extension's onAlarm
   listeners.

   #594: the alarm table persists per extension to the subsystem's
   IndexedDB store (STORE_ALARMS) and re-arms on worker boot, so an
   alarm survives the service worker's routine idle termination.
   Restore semantics fall out of the arming rules already present:
   arming clamps an elapsed delay to 0, so an elapsed one-shot fires
   once on restore, and the periodic reschedule loop advances past
   elapsed slots to the next future one. Persistence is best-effort -
   a store that cannot be opened or written degrades honestly to the
   in-memory behavior, never to a failed alarm call. */

import type { ExtensionId } from "./types";
import { openDb, idbGet, idbGetAllKeys, idbPut, STORE_ALARMS } from "./idb";

export interface AlarmCreateInfo {
  when?: number;
  delayInMinutes?: number;
  periodInMinutes?: number;
}

export interface Alarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export type AlarmListener = (alarm: Alarm) => void;

interface ExtAlarms {
  alarms: Map<string, { timer: ReturnType<typeof setTimeout>; alarm: Alarm }>;
  listeners: Set<AlarmListener>;
}

/** One persisted alarm record as it sits on disk. Hostile or
    corrupted shapes are skipped on hydrate, never trusted. */
interface StoredAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

function isStoredAlarm(v: unknown): v is StoredAlarm {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.name === "string" &&
    a.name.length > 0 &&
    a.name.length <= 256 &&
    typeof a.scheduledTime === "number" &&
    Number.isFinite(a.scheduledTime) &&
    (a.periodInMinutes === undefined || (typeof a.periodInMinutes === "number" && a.periodInMinutes > 0))
  );
}

export class AlarmRegistry {
  private readonly exts = new Map<ExtensionId, ExtAlarms>();
  private wake: ((id: ExtensionId) => Promise<void>) | null = null;
  /* #594: hydration state and the in-flight persistence writes, so
     tests (and the boot path) can await a settled store. */
  private hydrated = false;
  private readonly inflight = new Set<Promise<void>>();

  /** Host wiring: how an alarm firing wakes an idle MV3 background. */
  setWake(fn: (id: ExtensionId) => Promise<void>): void {
    this.wake = fn;
  }

  private reg(id: ExtensionId): ExtAlarms {
    let r = this.exts.get(id);
    if (!r) {
      r = { alarms: new Map(), listeners: new Set() };
      this.exts.set(id, r);
    }
    return r;
  }

  /** MDN semantics: no timing info means a one-shot about one minute
      out. periodInMinutes reschedules after every fire. Creating an
      existing name replaces it. */
  create(id: ExtensionId, name: string, info: AlarmCreateInfo = {}): void {
    const r = this.reg(id);
    const period =
      typeof info.periodInMinutes === "number" && info.periodInMinutes > 0
        ? info.periodInMinutes
        : undefined;
    let when: number;
    if (typeof info.when === "number") when = info.when;
    else if (typeof info.delayInMinutes === "number") when = Date.now() + info.delayInMinutes * 60_000;
    else if (period !== undefined) when = Date.now() + period * 60_000;
    else when = Date.now() + 60_000;
    const prev = r.alarms.get(name);
    if (prev) clearTimeout(prev.timer);
    const alarm: Alarm = { name, scheduledTime: when, ...(period ? { periodInMinutes: period } : {}) };
    r.alarms.set(name, { timer: this.arm(id, alarm, period), alarm });
    this.persistExt(id);
  }

  private arm(id: ExtensionId, alarm: Alarm, period: number | undefined): ReturnType<typeof setTimeout> {
    const delay = Math.max(0, alarm.scheduledTime - Date.now());
    return setTimeout(() => {
      void this.fire(id, alarm, period);
    }, delay);
  }

  private async fire(id: ExtensionId, alarm: Alarm, period: number | undefined): Promise<void> {
    const r = this.exts.get(id);
    if (!r) return;
    if (period !== undefined) {
      /* Periodic: reschedule from the previous scheduled time so drift
         stays bounded, then dispatch the current fire. */
      const next: Alarm = { ...alarm, scheduledTime: alarm.scheduledTime + period * 60_000 };
      while (next.scheduledTime <= Date.now()) next.scheduledTime += period * 60_000;
      r.alarms.set(alarm.name, { timer: this.arm(id, next, period), alarm: next });
      this.persistExt(id);
    } else {
      r.alarms.delete(alarm.name);
      this.persistExt(id);
    }
    if (this.wake) {
      try {
        await this.wake(id);
      } catch {
        /* a failing wake must not eat the dispatch */
      }
    }
    for (const l of [...r.listeners]) {
      try {
        l({ ...alarm });
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }

  get(id: ExtensionId, name: string): Alarm | undefined {
    const e = this.exts.get(id)?.alarms.get(name);
    return e ? { ...e.alarm } : undefined;
  }

  getAll(id: ExtensionId): Alarm[] {
    const r = this.exts.get(id);
    return r ? [...r.alarms.values()].map((e) => ({ ...e.alarm })) : [];
  }

  clear(id: ExtensionId, name?: string): boolean {
    const r = this.exts.get(id);
    if (!r) return false;
    if (name === undefined) return this.clearAll(id);
    const e = r.alarms.get(name);
    if (!e) return false;
    clearTimeout(e.timer);
    r.alarms.delete(name);
    this.persistExt(id);
    return true;
  }

  clearAll(id: ExtensionId): boolean {
    const r = this.exts.get(id);
    if (!r || r.alarms.size === 0) return false;
    for (const e of r.alarms.values()) clearTimeout(e.timer);
    r.alarms.clear();
    this.persistExt(id);
    return true;
  }

  onAlarm(id: ExtensionId, l: AlarmListener): () => void {
    const r = this.reg(id);
    r.listeners.add(l);
    return () => {
      r.listeners.delete(l);
    };
  }

  /** Engine hook: drop everything an extension owned (uninstall). */
  drop(id: ExtensionId): void {
    const r = this.exts.get(id);
    if (!r) return;
    for (const e of r.alarms.values()) clearTimeout(e.timer);
    this.exts.delete(id);
    this.persistExt(id);
  }

  /* ---- #594 persistence -------------------------------------------- */

  /** Load the persisted alarm table and re-arm it. Merge-guarded: a
      name already live in memory wins (its timer is already running
      and its next persist is authoritative), so a boot-time race
      between a freshly created alarm and hydration can never
      double-arm. Corrupted records are skipped, never trusted.
      Idempotent; safe to call when no store exists (it then leaves
      the registry in honest in-memory mode). */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true; /* set first: mutations from here on persist */
    try {
      const db = await openDb();
      const keys = await idbGetAllKeys(db, STORE_ALARMS);
      for (const extId of keys) {
        const recs = await idbGet(db, STORE_ALARMS, extId);
        if (!Array.isArray(recs)) continue;
        const r = this.reg(extId);
        let armed = 0;
        for (const v of recs) {
          if (!isStoredAlarm(v)) continue;
          if (r.alarms.has(v.name)) continue; /* merge guard */
          const period = typeof v.periodInMinutes === "number" ? v.periodInMinutes : undefined;
          const alarm: Alarm = {
            name: v.name,
            scheduledTime: v.scheduledTime,
            ...(period ? { periodInMinutes: period } : {}),
          };
          r.alarms.set(alarm.name, { timer: this.arm(extId, alarm, period), alarm });
          armed++;
        }
        if (armed > 0) {
          /* re-write the union: a create that landed inside the load
             window must not erase the alarms being restored */
          this.persistExt(extId);
        }
      }
    } catch {
      /* no IndexedDB (or a broken store): in-memory alarms only,
         exactly the pre-#594 behavior, never a failed call */
    }
  }

  /** Write one extension's alarm list. Best-effort by design: a
      rejected write is dropped (the alarm still runs in memory) and
      never propagates into alarm-call semantics. */
  private persistExt(id: ExtensionId): void {
    if (!this.hydrated) {
      /* pre-hydration writes would clobber the store with partial
         boot state; hydration is imminent at worker start */
      return;
    }
    const p = openDb()
      .then((db) => idbPut(db, STORE_ALARMS, id, this.getAll(id)))
      .catch(() => undefined);
    this.inflight.add(p);
    void p.finally(() => {
      this.inflight.delete(p);
    });
  }

  /** Tests: await every in-flight persistence write. */
  async flushForTests(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  resetForTests(): void {
    for (const r of this.exts.values()) {
      for (const e of r.alarms.values()) clearTimeout(e.timer);
    }
    this.exts.clear();
    this.wake = null;
    this.hydrated = false;
  }
}

export const ALARMS = new AlarmRegistry();
