/* Zeolite extension subsystem: mounted-surface inventory (#516, first
   slice).

   Issue #516 asks for a machine-readable source of truth driving
   implementation tracking and automated conformance tests. This
   module is the seed of that: it walks a MOUNTED api object (the same
   object an extension receives) and produces a structural inventory —
   every namespace, and per member whether it is a method, an event
   object (addListener/removeListener/hasListener) or a constant.

   The conformance tests (inventory.test.ts) hold the mounted surface
   to four invariants:
   1. every mounted namespace is documented in the compat matrix
      (NAMESPACE_COMPAT maps each namespace to the COMPAT keys that
      claim it; a dangling key or an undocumented namespace fails),
   2. every event object really is one (all three listener methods),
   3. no namespace mounts empty,
   4. permission-gated namespaces stay absent without the permission
      (feature detection answers honestly).

   What this deliberately is NOT yet: the full MDN inventory with
   argument schemas and Firefox version annotations. #516 stays open;
   this slice makes the engine's own surface self-describing so every
   later wave diffs against a stable machine-readable baseline. */

export interface InventoryMember {
  name: string;
  kind: "method" | "event" | "constant";
}

export interface InventoryNamespace {
  name: string;
  members: InventoryMember[];
}

export function isEventObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.addListener === "function" && typeof o.removeListener === "function" && typeof o.hasListener === "function";
}

/** Build the structural inventory of a mounted api object (browser
    or chrome — the namespaces are shared). */
export function buildInventory(api: Record<string, unknown>): InventoryNamespace[] {
  const out: InventoryNamespace[] = [];
  for (const nsName of Object.keys(api).sort()) {
    const ns = api[nsName];
    if (typeof ns !== "object" || ns === null) {
      out.push({ name: nsName, members: [{ name: String(nsName), kind: "constant" }] });
      continue;
    }
    const members: InventoryMember[] = [];
    for (const m of Object.keys(ns as Record<string, unknown>).sort()) {
      const v = (ns as Record<string, unknown>)[m];
      members.push({
        name: m,
        kind: typeof v === "function" ? "method" : isEventObject(v) ? "event" : "constant",
      });
    }
    out.push({ name: nsName, members });
  }
  return out;
}

/** Every mounted namespace, with the compat-matrix keys that claim
    it. A namespace not listed here fails the conformance test; a key
    not present in COMPAT fails it too. */
export const NAMESPACE_COMPAT: Record<string, string[]> = {
  action: ["action.* / browserAction.* / pageAction.*"],
  alarms: ["alarms.*"],
  browserAction: ["action.* / browserAction.* / pageAction.*"],
  browsingData: ["browsingData.*"],
  cookies: ["cookies.*"],
  contextMenus: ["contextMenus.*"],
  downloads: ["downloads.*"],
  extension: ["chrome.extension (MV2)"],
  i18n: ["chrome.i18n"],
  management: ["management.*"],
  menus: ["contextMenus.*"],
  notifications: ["notifications.*"],
  pageAction: ["action.* / browserAction.* / pageAction.*"],
  permissions: ["permissions.contains", "permissions.getAll", "permissions.request", "permissions.remove", "permissions.onAdded/onRemoved"],
  runtime: [
    "runtime.id", "runtime.getManifest", "runtime.sendMessage", "runtime.onMessage",
    "runtime.connect", "runtime.onConnect", "runtime.lastError", "runtime.onInstalled",
    "runtime.onStartup", "runtime.onMessageExternal", "runtime.onConnectExternal",
    "runtime.openOptionsPage", "runtime.reload", "runtime.getPlatformInfo",
    "runtime.getBrowserInfo",
  ],
  scripting: ["browser.scripting"],
  storage: ["storage.local", "storage.sync", "storage.session", "storage.onChanged"],
  tabs: ["tabs.*", "tabs.sendMessage", "tabs.getCurrent"],
  webNavigation: ["webNavigation.onCommitted", "webNavigation.onBeforeNavigate/onCompleted", "webNavigation.onDOMContentLoaded"],
  webRequest: ["webRequest.*"],
  windows: ["windows.*"],
};
