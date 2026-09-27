/* Zeolite extension subsystem: runtime.alarms.

   Timed alarms for extensions, in-memory in the engine's shared
   service-worker context. Firing an alarm wakes an idle MV3
   service-worker background first (the wake hook is wired by the
   host; without one, alarms dispatch directly), then delivers to the
   extension's onAlarm listeners. Honest limits, documented in
   ./compat: alarms are NOT persisted - an engine restart drops them -
   and no disk storage is involved. */

import type { ExtensionId } from "./types";

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

export class AlarmRegistry {
  private readonly exts = new Map<ExtensionId, ExtAlarms>();
  private wake: ((id: ExtensionId) => Promise<void>) | null = null;

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
    } else {
      r.alarms.delete(alarm.name);
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
    return true;
  }

  clearAll(id: ExtensionId): boolean {
    const r = this.exts.get(id);
    if (!r || r.alarms.size === 0) return false;
    for (const e of r.alarms.values()) clearTimeout(e.timer);
    r.alarms.clear();
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
  }

  resetForTests(): void {
    for (const r of this.exts.values()) {
      for (const e of r.alarms.values()) clearTimeout(e.timer);
    }
    this.exts.clear();
    this.wake = null;
  }
}

export const ALARMS = new AlarmRegistry();
