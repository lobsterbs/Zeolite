/* Zeolite extension subsystem: argument schemas + validation (#516,
   slices 3 + 5).

   #516 slice 2 made the mounted surface self-describing against
   Firefox member by member; slice 3 added the argument contract.
   ARG_SCHEMAS is a machine-readable table: per mounted method of the
   covered namespaces (alarms, action, bookmarks, browsingData,
   contextMenus + menus, cookies, declarativeNetRequest, downloads,
   i18n, management, notifications, permissions, runtime, scripting,
   storage, tabs, windows), the accepted argument count and the JS
   kind every position may carry. installArgValidation() wraps the
   mounted methods so out-of-contract calls reject with a TypeError
   before any engine work happens, and the conformance test
   (arg-schemas.test.ts) enforces that the table covers every mounted
   method of those namespaces 1:1 - a new method without a schema
   fails CI.

   The table describes the MOUNTED contract (what the engine really
   accepts today). Where that deliberately differs from Firefox's
   schema signature, `ff` carries Firefox's [minArgs, maxArgs] (from
   the @types/firefox-webext-browser 143.0.1 signatures) and `note`
   says why the engine shape differs - deviations stay visible, never
   silent. Nested storage areas are keyed by dotted path
   (storage.local.get). Honest gaps that remain open for later slices:
   Firefox's StorageArea.getKeys is not mounted (recorded here, feeds
   #520), the MV2-only action family aliases (browserAction,
   pageAction) and chrome.extension stay untabled until a fixture
   mounts them, and return-value/enum validation is not covered yet. */

export type ArgKind = "string" | "number" | "boolean" | "object" | "array" | "function" | "null" | "any";

export interface ArgSchema {
  /** Inclusive minimum argument count. */
  min: number;
  /** Inclusive maximum argument count. */
  max: number;
  /** Allowed kinds per position (index-aligned); null skips the
      check for that position. Shorter than args: trailing positions
      are unchecked. */
  types?: (ArgKind[] | null)[];
  /** Firefox's [minArgs, maxArgs] when the mounted shape differs. */
  ff?: [number, number];
  /** Why the mounted shape differs from Firefox's signature. */
  note?: string;
}

/** The mounted argument contract, per dotted member path. */
export const ARG_SCHEMAS: Record<string, ArgSchema> = {
  /* ---- alarms -------------------------------------------------------- */
  "alarms.create": {
    min: 1,
    max: 2,
    types: [["string", "object"], ["object"]],
    /* Firefox: create(alarmInfo) | create(name, alarmInfo) */
  },
  "alarms.get": { min: 0, max: 1, types: [["string"]] },
  "alarms.getAll": { min: 0, max: 0 },
  "alarms.clear": { min: 0, max: 1, types: [["string"]] },
  "alarms.clearAll": { min: 0, max: 0 },

  /* ---- cookies --------------------------------------------------------- */
  /* Firefox requires the details object on all four; the engine
     mounts the no-arg form (it rejects honestly inside the call for
     the shapes that need details). */
  "cookies.get": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form; the call itself rejects without a usable details object" },
  "cookies.getAll": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (all cookies of the active profile)" },
  "cookies.set": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form; the call itself rejects without a usable details object" },
  "cookies.remove": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form; the call itself rejects without a usable details object" },

  /* ---- runtime --------------------------------------------------------- */
  "runtime.connect": {
    min: 0,
    max: 2,
    types: [["string", "object"], ["object"]],
    /* Firefox: connect() | connect(connectInfo) | connect(extensionId, connectInfo?) */
  },
  "runtime.getBrowserInfo": { min: 0, max: 0 },
  /* Firefox: getContexts(filter) with a required ContextFilter; the
     engine mounts the no-filter form (every live context of the
     extension), so a filter argument is refused instead of silently
     ignored. */
  "runtime.getContexts": { min: 0, max: 0, ff: [1, 1], note: "the engine mounts the no-filter form; Firefox's ContextFilter is not accepted" },
  "runtime.getManifest": { min: 0, max: 0 },
  "runtime.getPlatformInfo": { min: 0, max: 0 },
  "runtime.getURL": { min: 1, max: 1, types: [["string"]] },
  "runtime.openOptionsPage": { min: 0, max: 0 },
  "runtime.reload": { min: 0, max: 0 },
  /* #518: the engine answers no_update honestly (no update server);
     setUninstallURL clears the stored URL when called without one. */
  "runtime.requestUpdateCheck": { min: 0, max: 0 },
  "runtime.setUninstallURL": { min: 0, max: 1, types: [["string"]] },
  /* Firefox adds sendMessage(extensionId, message, options?) - the
     engine has no options argument. Positions stay unchecked: both
     the (message) and (extensionId, message) overloads are live. */
  "runtime.sendMessage": { min: 1, max: 2, ff: [1, 3], note: "the engine does not accept Firefox's options argument" },

  /* ---- storage areas ----------------------------------------------------- */
  /* Firefox's StorageArea also declares getKeys(); the engine does
     not mount it yet (feeds #520). getBytesInUse is Firefox-deprecated
     but mounted for Chrome parity. */
  "storage.local.get": { min: 0, max: 1, types: [["null", "string", "array", "object"]] },
  "storage.local.set": { min: 1, max: 1, types: [["object"]] },
  "storage.local.remove": { min: 1, max: 1, types: [["string", "array"]] },
  "storage.local.clear": { min: 0, max: 0 },
  "storage.local.getBytesInUse": { min: 0, max: 1, types: [["null", "string", "array"]] },
  "storage.sync.get": { min: 0, max: 1, types: [["null", "string", "array", "object"]] },
  "storage.sync.set": { min: 1, max: 1, types: [["object"]] },
  "storage.sync.remove": { min: 1, max: 1, types: [["string", "array"]] },
  "storage.sync.clear": { min: 0, max: 0 },
  "storage.sync.getBytesInUse": { min: 0, max: 1, types: [["null", "string", "array"]] },
  "storage.session.get": { min: 0, max: 1, types: [["null", "string", "array", "object"]] },
  "storage.session.set": { min: 1, max: 1, types: [["object"]] },
  "storage.session.remove": { min: 1, max: 1, types: [["string", "array"]] },
  "storage.session.clear": { min: 0, max: 0 },
  "storage.session.getBytesInUse": { min: 0, max: 1, types: [["null", "string", "array"]] },
  /* Firefox documents the plain-string form; Chrome's {accessLevel}
     object form is accepted too (storage.ts setSessionAccessLevel). */
  "storage.session.setAccessLevel": { min: 1, max: 1, types: [["string", "object"]] },

  /* #520: the managed area answers honestly empty (no policy source)
     and every write rejects read-only (storage.ts makeManagedArea) -
     the shapes exist exactly as Firefox's do. */
  "storage.managed.get": { min: 0, max: 1, types: [["null", "string", "array", "object"]] },
  "storage.managed.set": { min: 1, max: 1, types: [["object"]] },
  "storage.managed.remove": { min: 1, max: 1, types: [["string", "array"]] },
  "storage.managed.clear": { min: 0, max: 0 },
  "storage.managed.getBytesInUse": { min: 0, max: 1, types: [["null", "string", "array"]] },

  /* ---- tabs --------------------------------------------------------------- */
  "tabs.create": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty active tab)" },
  "tabs.get": { min: 1, max: 1, types: [["number"]] },
  "tabs.getCurrent": { min: 0, max: 0 },
  "tabs.query": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (all tabs visible to the extension)" },
  "tabs.remove": { min: 1, max: 1, types: [["number", "array"]] },
  "tabs.sendMessage": { min: 2, max: 3, types: [["number"], ["any"], ["object"]] },
  /* Firefox: update(updateProperties) | update(tabId, updateProperties);
     the engine mounts the no-tab form (the single-window model). */
  "tabs.update": { min: 0, max: 2, types: [["number", "object"], ["object"]], ff: [1, 2], note: "the engine also mounts the no-tab form" },
  /* #519: duplicate(tabId, properties?) matches Firefox's shape
     (duplicateProperties is a Firefox extension); highlight takes the
     highlightInfo object. */
  "tabs.duplicate": { min: 1, max: 2, types: [["number"], ["object"]] },
  "tabs.highlight": { min: 1, max: 1, types: [["object"]] },
  /* ---- action family -----------------------------------------------------
     The toolbar action family mounts for MV3 `action`, MV2
     `browserAction` and MV2 `pageAction` (pageAction without badge /
     enable-disable). Firefox requires the details object on the
     setters and getters; the engine defaults it, so the no-arg form
     addresses the global state. enable/disable take the genuinely
     optional tabId. The conformance test covers `action` on the MV3
     fixture; browserAction/pageAction mount on MV2 manifests only and
     share actionNsFor's identical contract. */
  "action.enable": { min: 0, max: 1, types: [["number", "null"]] },
  "action.disable": { min: 0, max: 1, types: [["number", "null"]] },
  "action.isEnabled": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.setTitle": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.getTitle": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.setBadgeText": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.getBadgeText": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.setBadgeBackgroundColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.getBadgeBackgroundColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.setBadgeTextColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.getBadgeTextColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.setPopup": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.getPopup": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "action.setIcon": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },

  /* ---- bookmarks ------------------------------------------------------- */
  /* Firefox shapes match everywhere; search accepts both the word
     string and the verbatim url/title object form. */
  "bookmarks.create": { min: 1, max: 1, types: [["object"]] },
  "bookmarks.get": { min: 1, max: 1, types: [["string", "array"]] },
  "bookmarks.getChildren": { min: 1, max: 1, types: [["string"]] },
  "bookmarks.getRecent": { min: 1, max: 1, types: [["number"]] },
  "bookmarks.getTree": { min: 0, max: 0 },
  "bookmarks.getSubTree": { min: 1, max: 1, types: [["string"]] },
  "bookmarks.search": { min: 1, max: 1, types: [["string", "object"]] },
  "bookmarks.move": { min: 2, max: 2, types: [["string"], ["object"]] },
  "bookmarks.update": { min: 2, max: 2, types: [["string"], ["object"]] },
  "bookmarks.remove": { min: 1, max: 1, types: [["string"]] },
  "bookmarks.removeTree": { min: 1, max: 1, types: [["string"]] },

  /* ---- browsingData ------------------------------------------------------ */
  /* The engine-owned types accept the no-arg form (defaults to every
     origin); the host-browser-owned types mount the no-arg form too
     but the call itself rejects (browsingdata.ts unreachable). */
  "browsingData.settings": { min: 0, max: 0 },
  "browsingData.removeCache": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeCookies": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeDownloads": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeIndexedDB": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeFormData": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  "browsingData.removeHistory": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  "browsingData.removeLocalStorage": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  "browsingData.removePasswords": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  "browsingData.removePluginData": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  /* Engine extra (Chrome parity), documented in COMPAT and the gap
     report; Firefox has no removeServiceWorkers. */
  "browsingData.removeServiceWorkers": { min: 0, max: 0 },

  /* ---- contextMenus / menus ---------------------------------------------- */
  /* One registry under both names; the table keys both namespaces.
     Firefox requires createProperties and accepts a trailing callback
     the engine does not take; update requires updateProperties. */
  "contextMenus.create": { min: 0, max: 1, types: [["object"]], ff: [1, 2], note: "the engine also mounts the no-arg form and does not accept Firefox's trailing callback" },
  "contextMenus.update": { min: 0, max: 2, types: [["string", "number"], ["object"]], ff: [2, 2], note: "the engine also mounts the no-props form" },
  "contextMenus.remove": { min: 1, max: 1, types: [["string", "number"]] },
  "contextMenus.removeAll": { min: 0, max: 0 },
  "menus.create": { min: 0, max: 1, types: [["object"]], ff: [1, 2], note: "the engine also mounts the no-arg form and does not accept Firefox's trailing callback" },
  "menus.update": { min: 0, max: 2, types: [["string", "number"], ["object"]], ff: [2, 2], note: "the engine also mounts the no-props form" },
  "menus.remove": { min: 1, max: 1, types: [["string", "number"]] },
  "menus.removeAll": { min: 0, max: 0 },

  /* ---- declarativeNetRequest ----------------------------------------------- */
  "declarativeNetRequest.updateDynamicRules": { min: 1, max: 1, types: [["object"]] },
  "declarativeNetRequest.getDynamicRules": { min: 0, max: 0 },
  "declarativeNetRequest.updateSessionRules": { min: 1, max: 1, types: [["object"]] },
  "declarativeNetRequest.getSessionRules": { min: 0, max: 0 },
  "declarativeNetRequest.updateEnabledRulesets": { min: 1, max: 1, types: [["object"]] },
  "declarativeNetRequest.getEnabledRulesets": { min: 0, max: 0 },
  "declarativeNetRequest.getAvailableStaticRuleCount": { min: 0, max: 0 },
  "declarativeNetRequest.getMatchedRules": { min: 0, max: 0 },
  /* #521 slice 4: the typed surface remainder. Firefox requires
     isRegexSupported(regexValue) only; the engine also accepts
     Chrome's isCaseSensitive argument and ignores it (matching stays
     case-sensitive). */
  "declarativeNetRequest.isRegexSupported": { min: 1, max: 2, types: [["string"], ["boolean"]], ff: [1, 1], note: "the engine also accepts Chrome's isCaseSensitive argument and ignores it" },
  "declarativeNetRequest.getDisabledRuleIds": { min: 1, max: 1, types: [["object"]] },
  "declarativeNetRequest.updateStaticRules": { min: 1, max: 1, types: [["object"]] },
  "declarativeNetRequest.testMatchOutcome": { min: 1, max: 2, types: [["object"], ["object"]] },

  /* ---- downloads ------------------------------------------------------------ */
  "downloads.download": { min: 1, max: 1, types: [["object"]] },
  "downloads.search": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (every handoff of this extension)" },

  /* ---- i18n ------------------------------------------------------------------ */
  "i18n.getAcceptLanguages": { min: 0, max: 0 },
  "i18n.getMessage": { min: 1, max: 2, types: [["string"], ["any"]] },
  "i18n.getUILanguage": { min: 0, max: 0 },

  /* ---- management --------------------------------------------------------------- */
  "management.getSelf": { min: 0, max: 0 },
  "management.get": { min: 1, max: 1, types: [["string"]] },
  "management.getAll": { min: 0, max: 0 },
  "management.setEnabled": { min: 2, max: 2, types: [["string"], ["boolean"]] },
  /* Engine extra (Chrome parity), documented in COMPAT and the gap
     report; Firefox never implemented management.uninstall. */
  "management.uninstall": { min: 1, max: 1, types: [["string"]] },
  "management.uninstallSelf": { min: 0, max: 0 },

  /* ---- notifications --------------------------------------------------------------- */
  "notifications.create": { min: 0, max: 2, types: [["string", "object"], ["object"]], ff: [1, 2], note: "the engine also mounts the no-arg form; the call itself rejects without a usable options object" },
  "notifications.update": { min: 2, max: 2, types: [["string"], ["object"]] },
  "notifications.clear": { min: 1, max: 1, types: [["string"]] },
  "notifications.getAll": { min: 0, max: 0 },

  /* ---- permissions -------------------------------------------------------------------- */
  "permissions.contains": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty permission set)" },
  "permissions.getAll": { min: 0, max: 0 },
  "permissions.request": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty permission set)" },
  "permissions.remove": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty permission set)" },

  /* ---- scripting ------------------------------------------------------------------------ */
  "scripting.executeScript": { min: 1, max: 1, types: [["object"]] },
  "scripting.insertCSS": { min: 1, max: 1, types: [["object"]] },

  /* ---- windows ----------------------------------------------------------------------------- */
  "windows.get": { min: 1, max: 2, types: [["number"], ["object"]] },
  "windows.getCurrent": { min: 0, max: 1, types: [["object"]] },
  "windows.getLastFocused": { min: 0, max: 1, types: [["object"]] },
  "windows.getAll": { min: 0, max: 1, types: [["object"]] },
};

/** Classify one argument value into the table's kind vocabulary. */
export function argKindOf(v: unknown): ArgKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as ArgKind;
}

/** Reject out-of-contract calls with a precise TypeError. The arity
    check runs first, so a too-many/too-few call never also reports a
    type complaint. */
export function validateArgs(path: string, schema: ArgSchema, args: unknown[]): void {
  if (args.length < schema.min) {
    throw new TypeError(`zeolite: ${path}: expected at least ${schema.min} argument(s), got ${args.length}`);
  }
  if (args.length > schema.max) {
    throw new TypeError(`zeolite: ${path}: expected at most ${schema.max} argument(s), got ${args.length}`);
  }
  const types = schema.types;
  if (!types) return;
  for (let i = 0; i < args.length && i < types.length; i++) {
    const allowed = types[i];
    if (!allowed || allowed.includes("any")) continue;
    /* Standard optional-argument semantics: an explicit undefined at
       an optional position (i >= min) means "omitted" - real callers
       write f(id, undefined) - while undefined at a required position
       still fails the kind check, as Firefox's schema would. */
    if (args[i] === undefined && i >= schema.min) continue;
    const kind = argKindOf(args[i]);
    if (!allowed.includes(kind)) {
      throw new TypeError(`zeolite: ${path}: argument ${i + 1} must be ${allowed.join(" | ")}, got ${kind}`);
    }
  }
}

/** Wrap every mounted method named by ARG_SCHEMAS so out-of-contract
    calls reject before the engine runs. Paths whose namespace or
    member is not mounted (permission-gated away, or an area the
    context lacks) are skipped silently - the conformance test holds
    the table to the mounted surface 1:1, so a skipped path that
    should mount fails CI there instead. */
export function installArgValidation(api: Record<string, unknown>): void {
  for (const [path, schema] of Object.entries(ARG_SCHEMAS)) {
    const parts = path.split(".");
    let parent: Record<string, unknown> | undefined = api;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = parent?.[parts[i]];
      if (typeof next !== "object" || next === null) {
        parent = undefined;
        break;
      }
      parent = next as Record<string, unknown>;
    }
    if (!parent) continue;
    const key = parts[parts.length - 1];
    const fn = parent[key];
    if (typeof fn !== "function") continue;
    parent[key] = (...args: unknown[]): unknown => {
      validateArgs(path, schema, args);
      return (fn as (...a: unknown[]) => unknown).apply(parent, args);
    };
  }
}
