/* Zeolite extension subsystem: optional API module registry (LB #76
   modularity).

   Every namespace that is already optional in buildApi - mounted
   only when the extension holds the permission - is registered
   here. An embedder can detach one of these modules so the
   namespace disappears from every browser and chrome surface:
   feature detection then answers honestly (absent), exactly like
   an extension without the permission. Core surfaces (runtime,
   tabs, windows, scripting, permissions) are not optional and not
   detachable; detaching an unknown name is a type error, not a
   silent no-op. The registry is module state: one detach call at
   boot (or from a host control message) covers every extension
   context built afterwards. */

export const OPTIONAL_API_MODULES = [
  "alarms",
  "browsingData",
  "cookies",
  "downloads",
  "management",
  "menus",
  "notifications",
  "storage",
  "webNavigation",
  "webRequest",
] as const;

export type OptionalApiModule = (typeof OPTIONAL_API_MODULES)[number];

const detached = new Set<OptionalApiModule>();

/** Detach an optional API module: its namespace stops mounting for
    every extension context built after the call. */
export function detachApiModule(name: OptionalApiModule): void {
  detached.add(name);
}

/** Reattach a detached module. */
export function reattachApiModule(name: OptionalApiModule): void {
  detached.delete(name);
}

/** The gate buildApi consults for every optional namespace. */
export function isApiDetached(name: OptionalApiModule): boolean {
  return detached.has(name);
}

/** Test and boot seam: drop every detachment. */
export function resetApiModules(): void {
  detached.clear();
}
