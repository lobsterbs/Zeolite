/* Zeolite extension subsystem: management API support.

   getSelf/uninstallSelf need no permission; get/getAll/setEnabled/
   uninstall of OTHER extensions require the "management" permission
   (Chrome semantics; Firefox restricts regular extensions to the
   self surface - this runtime implements the wider surface honestly
   gated on the permission). Lifecycle events are derived from the
   manager's lifecycle stream with per-id dedup, so repeated
   changed() calls fire events only on real transitions. */

import type { ExtensionManager, LifecycleListener } from "./manager";
import type { ExtensionRecord, ExtensionId } from "./types";

export interface ManagementInfo {
  id: string;
  name: string;
  version: string;
  type: "extension";
  enabled: boolean;
  permissions: string[];
  hostPermissions: string[];
}

export function infoOf(rec: ExtensionRecord): ManagementInfo {
  return {
    id: rec.id,
    name: rec.name,
    version: rec.version,
    type: "extension",
    enabled: rec.enabled,
    permissions: [...rec.permissions],
    hostPermissions: [...rec.hostPermissions],
  };
}

export type MgmtListener = (info: ManagementInfo) => void;

type MgmtKind = "installed" | "uninstalled" | "enabled" | "disabled";

export class ManagementEvents {
  private readonly subs: Record<MgmtKind, Set<MgmtListener>> = {
    installed: new Set(),
    uninstalled: new Set(),
    enabled: new Set(),
    disabled: new Set(),
  };
  private readonly last = new Map<ExtensionId, { enabled: boolean; state: string }>();
  private off: (() => void) | null = null;

  /** Observe one manager's lifecycle stream. Re-wiring drops the
      previous subscription; tests wire fresh managers. */
  wire(m: ExtensionManager): void {
    this.off?.();
    this.last.clear();
    const l: LifecycleListener = (rec) => this.observe(rec);
    this.off = m.onLifecycle(l);
  }

  private observe(rec: ExtensionRecord): void {
    const cur = { enabled: rec.enabled, state: rec.state };
    const prev = this.last.get(rec.id);
    this.last.set(rec.id, cur);
    const info = infoOf(rec);
    const emit = (ls: Set<MgmtListener>) => {
      for (const f of [...ls]) {
        try {
          f(info);
        } catch {
          /* a broken listener is the extension's own problem */
        }
      }
    };
    if (rec.state === "uninstalled") {
      this.last.delete(rec.id);
      emit(this.subs.uninstalled);
      return;
    }
    if (!prev) {
      if (cur.state !== "installing") emit(this.subs.installed);
      return;
    }
    if (prev.enabled !== cur.enabled) emit(cur.enabled ? this.subs.enabled : this.subs.disabled);
  }

  on(kind: MgmtKind, l: MgmtListener): () => void {
    this.subs[kind].add(l);
    return () => {
      this.subs[kind].delete(l);
    };
  }

  resetForTests(): void {
    this.off?.();
    this.off = null;
    this.last.clear();
    for (const s of Object.values(this.subs)) s.clear();
  }
}

export const MGMT = new ManagementEvents();
