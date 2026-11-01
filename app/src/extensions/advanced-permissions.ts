/* Zeolite extension subsystem: advanced permissions.

   The browser.permissions API: contains/getAll read the granted set,
   request/remove run through a manager-backed backend (wired by the
   service worker exactly like the tabs bridge, so grants mutate and
   persist the master record). The engine has no user prompt, so
   request() auto-grants anything the manifest declared in
   optional_permissions and refuses everything else: no extension can
   self-escalate past its manifest. onAdded/onRemoved fire with the
   requested set. */

import type { ExtensionId, ExtensionRecord } from "./types";

export interface ApiPermissions {
  permissions?: string[];
  origins?: string[];
}

export type PermListener = (perms: ApiPermissions) => void;

export type PermBackend = (
  id: ExtensionId,
  op: "grant" | "revoke",
  perms: ApiPermissions,
) => Promise<{ permissions: string[]; origins: string[] } | null>;

export class PermissionRegistry {
  private backend: PermBackend | null = null;
  private readonly added = new Set<PermListener>();
  private readonly removed = new Set<PermListener>();
  /* Live view per extension: the API object is built from a record
     snapshot, so grants must be observable without a reload. */
  private readonly views = new Map<ExtensionId, { permissions: string[]; origins: string[] }>();

  setBackend(b: PermBackend | null): void {
    this.backend = b;
  }

  private fire(listeners: Set<PermListener>, perms: ApiPermissions): void {
    for (const l of listeners) {
      try {
        l({
          permissions: [...(perms.permissions ?? [])],
          origins: [...(perms.origins ?? [])],
        });
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }

  subscribeAdded(l: PermListener): () => void {
    this.added.add(l);
    return () => this.added.delete(l);
  }

  subscribeRemoved(l: PermListener): () => void {
    this.removed.add(l);
    return () => this.removed.delete(l);
  }

  private view(ext: ExtensionRecord): { permissions: string[]; origins: string[] } {
    let v = this.views.get(ext.id);
    if (!v) {
      v = { permissions: [...ext.permissions], origins: [...ext.hostPermissions] };
      this.views.set(ext.id, v);
    }
    return v;
  }

  contains(ext: ExtensionRecord, perms: ApiPermissions): boolean {
    const v = this.view(ext);
    const named = perms.permissions ?? [];
    const origins = perms.origins ?? [];
    return (
      named.every((p) => v.permissions.includes(p)) &&
      origins.every((p) => v.origins.includes(p))
    );
  }

  getAll(ext: ExtensionRecord): { permissions: string[]; origins: string[] } {
    const v = this.view(ext);
    return { permissions: [...v.permissions], origins: [...v.origins] };
  }

  /** #522: the event payload is the DELTA actually applied — requested
      entries that changed state against the recorded view — never the
      requested superset. A re-request of already-granted permissions
      fires nothing; a mixed request fires only the new entries. The
      view (not the record snapshot) is the prior source: the manager
      hands out shallow clones, so the record object the API closure
      holds can go stale across grants. */
  private static delta(
    requested: ApiPermissions,
    prior: { permissions: ReadonlySet<string>; origins: ReadonlySet<string> },
    after: { permissions: string[]; origins: string[] },
  ): ApiPermissions {
    const nowP = new Set(after.permissions);
    const nowO = new Set(after.origins);
    return {
      permissions: (requested.permissions ?? []).filter((p) => !prior.permissions.has(p) && nowP.has(p)),
      origins: (requested.origins ?? []).filter((p) => !prior.origins.has(p) && nowO.has(p)),
    };
  }

  private static nonEmpty(d: ApiPermissions): boolean {
    return (d.permissions?.length ?? 0) > 0 || (d.origins?.length ?? 0) > 0;
  }

  async request(ext: ExtensionRecord, perms: ApiPermissions): Promise<boolean> {
    if (!this.backend) return false;
    const prior = this.view(ext);
    const priorSets = { permissions: new Set(prior.permissions), origins: new Set(prior.origins) };
    const after = await this.backend(ext.id, "grant", perms);
    if (!after) return false;
    this.views.set(ext.id, after);
    const granted = PermissionRegistry.delta(perms, priorSets, after);
    if (PermissionRegistry.nonEmpty(granted)) this.fire(this.added, granted);
    return true;
  }

  async remove(ext: ExtensionRecord, perms: ApiPermissions): Promise<boolean> {
    if (!this.backend) return false;
    const prior = this.view(ext);
    const priorSets = { permissions: new Set(prior.permissions), origins: new Set(prior.origins) };
    const after = await this.backend(ext.id, "revoke", perms);
    if (!after) return false;
    this.views.set(ext.id, after);
    /* onRemoved mirrors onAdded: only entries that really left the
       granted set are reported, as in Firefox. */
    const revoked: ApiPermissions = {
      permissions: (perms.permissions ?? []).filter((p) => priorSets.permissions.has(p) && !after.permissions.includes(p)),
      origins: (perms.origins ?? []).filter((p) => priorSets.origins.has(p) && !after.origins.includes(p)),
    };
    if (PermissionRegistry.nonEmpty(revoked)) this.fire(this.removed, revoked);
    return true;
  }
}

export const PERMS = new PermissionRegistry();
