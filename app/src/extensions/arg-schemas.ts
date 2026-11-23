/* Zeolite extension subsystem: argument schemas + validation (#516,
   slices 3 + 5).

   #516 slice 2 made the mounted surface self-describing against
   Firefox member by member; slice 3 added the argument contract.
   ARG_SCHEMAS is a machine-readable table: per mounted method of the
   covered namespaces (alarms, action, bookmarks, browserAction,
   browsingData, contextMenus + menus, cookies, declarativeNetRequest,
   downloads, extension, history, i18n, identity, management,
   notifications,
   permissions, pageAction, runtime, scripting, storage, tabs,
   topSites, windows), the
   accepted argument count and the JS kind every position may carry.
   installArgValidation() wraps the mounted methods so out-of-contract
   calls reject with a TypeError before any engine work happens, and
   the conformance test (arg-schemas.test.ts) enforces that the table
   covers every mounted method of those namespaces 1:1 - a new method
   without a schema fails CI.

   The table describes the MOUNTED contract (what the engine really
   accepts today). Where that deliberately differs from Firefox's
   schema signature, `ff` carries Firefox's [minArgs, maxArgs] (from
   the @types/firefox-webext-browser 143.0.1 signatures) and `note`
   says why the engine shape differs - deviations stay visible, never
   silent. Nested storage areas are keyed by dotted path
   (storage.local.get). Honest gaps that remain open for later slices:
   Firefox's StorageArea.getKeys is not mounted (recorded here, feeds
   #520), and return-value/enum validation is not covered yet.

   The counts are EFFECTIVE argument counts: trailing arguments the
   caller explicitly forwarded as undefined are trimmed (JS calls f(a,
   undefined) with arguments.length 2 - Tampermonkey's MV2 init chain
   died on exactly that until the 2026-11-20 arity fix), and one
   trailing function beyond max resolves to the optional WebExtension
   response callback (sliced and honored; see resolveCallArgs). */

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
  "cookies.getAllCookieStores": { min: 0, max: 0 },
  "history.search": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (every page by recency); query text matches the URL because titles are not part of the store" },
  "history.getVisits": { min: 1, max: 1, types: [["object"]] },
  "history.addUrl": { min: 1, max: 1, types: [["object"]], ff: [1, 1], note: "records the visit; title/transition are accepted but not stored (no titles reach the worker)" },
  "history.deleteUrl": { min: 1, max: 1, types: [["object"]] },
  "history.deleteRange": { min: 1, max: 1, types: [["object"]] },
  "history.deleteAll": { min: 0, max: 0 },
  "topSites.get": { min: 0, max: 1, types: [["object"]] },

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
  /* #519: Firefox's MV2 legacy leg over the scripting engine
     (schema max_manifest_version 2 - the members stay absent on MV3
     records). Both overloads are positionally ambiguous - the first
     slot carries the optional tabId, the second the details, and the
     (details, callback) form takes its callback in-slot - so the kind
     table stays unchecked here on the runtime.sendMessage precedent and
     the implementation owns the details-shape and host-grant checks
     (rejected honestly, never lied about); the (tabId, details,
     callback) form still resolves its trailing function through the
     generic slice. */
  "tabs.executeScript": { min: 1, max: 2, ff: [1, 3], note: "MV2-only (#519): resolves with the per-frame results array, injected-unit errors reject the promise per MDN; the omitted tabId defaults to the active tab; kinds unchecked (runtime.sendMessage precedent), shape + host-grant checked by the implementation" },
  "tabs.insertCSS": { min: 1, max: 2, ff: [1, 3], note: "MV2-only (#519): resolves void per MDN; code before file; frame targeting, allFrames and user cssOrigin reject (page world, main frame, author styles); kinds unchecked (runtime.sendMessage precedent), shape + host-grant checked by the implementation" },
  "tabs.removeCSS": { min: 1, max: 2, ff: [1, 3], note: "MV2-only (#519): resolves void per MDN, removing styles tabs.insertCSS injected; exact-content record scoped to the listener-created styles of this extension; kinds unchecked (runtime.sendMessage precedent), shape + host-grant checked by the implementation" },
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

  /* ---- browserAction (the MV2 alias of the action family) ------------
     Mounted for MV2 browser_action manifests over actionNsFor's
     identical contract; the conformance test covers it on the MV2
     fixture, so the table mirrors action.* member for member. */
  "browserAction.enable": { min: 0, max: 1, types: [["number", "null"]] },
  "browserAction.disable": { min: 0, max: 1, types: [["number", "null"]] },
  "browserAction.isEnabled": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.setTitle": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.getTitle": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.setBadgeText": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.getBadgeText": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.setBadgeBackgroundColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.getBadgeBackgroundColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.setBadgeTextColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.getBadgeTextColor": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.setPopup": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.getPopup": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "browserAction.setIcon": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },

  /* ---- pageAction (MV2) ------------------------------------------------
     Firefox mounts no badge surface and no enable/disable on it;
     visibility is per-tab via show/hide and starts hidden, so show and
     hide genuinely require the tabId. */
  "pageAction.isShown": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "pageAction.show": { min: 1, max: 1, types: [["number"]] },
  "pageAction.hide": { min: 1, max: 1, types: [["number"]] },
  "pageAction.setTitle": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "pageAction.getTitle": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "pageAction.setPopup": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "pageAction.getPopup": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },
  "pageAction.setIcon": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (details default to the global state)" },

  /* ---- extension (MV2 chrome.extension) --------------------------------
     Chrome keeps this namespace on every MV2 context and removed it in
     MV3; the engine mounts it for MV2 records only. getURL shares the
     runtime implementation; getViews accepts Firefox's properties
     filter and ignores it (no live page views). inIncognitoContext is
     a constant, not a method - no argument contract. */
  "extension.getURL": { min: 1, max: 1, types: [["string"]] },
  "extension.getBackgroundPage": { min: 0, max: 0 },
  "extension.isAllowedFileSchemeAccess": { min: 0, max: 0 },
  "extension.isAllowedIncognitoAccess": { min: 0, max: 0 },
  "extension.getViews": { min: 0, max: 1, types: [["object"]], note: "the engine accepts Firefox's properties filter and ignores it (no live page views)" },

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
  "browsingData.remove": { min: 2, max: 2, types: [["object"], ["object"]] },
  "browsingData.settings": { min: 0, max: 0 },
  "browsingData.removeAppcache": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (no appcache store exists in this engine)" },
  "browsingData.removeCache": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeCookies": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeDownloads": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeIndexedDB": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (defaults to every origin)" },
  "browsingData.removeFileSystems": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (no FileSystem store exists in this engine)" },
  "browsingData.removeFormData": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  "browsingData.removeHistory": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "really clears the engine visit store (#520): origins scopes the clear (excludeOrigins honored through the shared validation) and since filters per-URL by visit times, whole store otherwise" },
  "browsingData.removeLocalStorage": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  "browsingData.removePasswords": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  "browsingData.removePluginData": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (host-browser-owned data type)" },
  /* Engine extra (Chrome parity), documented in COMPAT and the gap
     report; Firefox has no removeServiceWorkers. */
  "browsingData.removeWebSQL": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine mounts the no-arg form; the call itself rejects (no WebSQL store exists in this engine)" },
  "browsingData.removeServiceWorkers": { min: 0, max: 0 },

  /* ---- contextMenus / menus ---------------------------------------------- */
  /* One registry under both names; the table keys both namespaces.
     Firefox requires createProperties and accepts a trailing callback
     the engine does not take; update requires updateProperties. */
  "contextMenus.create": { min: 0, max: 1, types: [["object"]], ff: [1, 2], note: "the engine also mounts the no-arg form; the generic argument contract resolves one trailing function beyond the maximum as the response callback (impl-return fires it async)" },
  "contextMenus.update": { min: 0, max: 2, types: [["string", "number"], ["object"]], ff: [2, 2], note: "the engine also mounts the no-props form" },
  "contextMenus.remove": { min: 1, max: 1, types: [["string", "number"]] },
  "contextMenus.removeAll": { min: 0, max: 0 },
  "menus.create": { min: 0, max: 1, types: [["object"]], ff: [1, 2], note: "the engine also mounts the no-arg form; the generic argument contract resolves one trailing function beyond the maximum as the response callback (impl-return fires it async)" },
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
  "downloads.erase": { min: 0, max: 1, types: [["object"]], ff: [0, 1], note: "erases this extension own TERMINAL handoff records (ascending ids, memory + store row); active handoffs stay tracked; query filters: id, limit" },

  /* ---- i18n ------------------------------------------------------------------ */
  "i18n.getAcceptLanguages": { min: 0, max: 0 },
  "i18n.getMessage": { min: 1, max: 2, types: [["string"], ["any"]] },
  "i18n.getPreferredSystemLanguages": { min: 0, max: 0 },
  "i18n.getUILanguage": { min: 0, max: 0 },

  /* ---- identity ---------------------------------------------------------- */
  /* #522: mounts only with the identity permission; getRedirectURL
     is Firefox's own sync computation (ext-identity.js: sha1 hex of
     the extension id + the allizom redirect domain), path optional. */
  "identity.getRedirectURL": { min: 0, max: 1, types: [["string"]] },

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
  "notifications.getPermissionLevel": { min: 0, max: 0 },

  /* ---- permissions -------------------------------------------------------------------- */
  "permissions.contains": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty permission set)" },
  "permissions.getAll": { min: 0, max: 0 },
  "permissions.request": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty permission set)" },
  "permissions.remove": { min: 0, max: 1, types: [["object"]], ff: [1, 1], note: "the engine also mounts the no-arg form (an empty permission set)" },

  /* ---- scripting ------------------------------------------------------------------------ */
  "scripting.executeScript": { min: 1, max: 1, types: [["object"]] },
  "scripting.insertCSS": { min: 1, max: 1, types: [["object"]] },
  "scripting.removeCSS": { min: 1, max: 1, types: [["object"]] },

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

/** The argument vector a call resolves to. Explicit trailing
    undefined arguments are omitted: real SDK wrappers forward the
    optional slots they never received (Tampermonkey's MV2 adapter
    compiles setIcon(details, callback) and calls it with an undefined
    callback, so arguments.length reports 2 for a one-argument call;
    the engine's validator used to reject exactly that and killed the
    extension's whole init chain). The trim never goes below
    schema.min: too few real arguments stay an arity error. Exactly
    one trailing function argument BEYOND schema.max is the optional
    WebExtension response callback: sliced off and returned so the
    wrapper can honor it (a second trailing function is not a
    callback slot and stays an arity error, as in Chrome). */
export interface ResolvedCallArgs {
  /** The effective argument vector the implementation receives. */
  args: unknown[];
  /** The sliced-off trailing response callback, when one was passed. */
  callback?: (value?: unknown) => void;
}

/** Resolve a raw call into its effective argument vector plus the
    optional trailing response callback (same semantics on browser.*
    and chrome.*: the chrome adapter's CALLBACK_METHODS list pops its
    own callbacks before this wrapper runs, so the two wirings never
    double-fire). */
export function resolveCallArgs(schema: ArgSchema, raw: unknown[]): ResolvedCallArgs {
  let end = raw.length;
  while (end > schema.min && raw[end - 1] === undefined) end--;
  let callback: ((value?: unknown) => void) | undefined;
  if (end === schema.max + 1 && typeof raw[end - 1] === "function") {
    callback = raw[end - 1] as (value?: unknown) => void;
    end--;
  }
  if (end === raw.length) return { args: raw };
  return { args: raw.slice(0, end), callback };
}

/** Reject out-of-contract calls with a precise TypeError. The arity
    check runs first over the EFFECTIVE argument vector (trailing
    undefined trimmed, the optional response callback sliced), so a
    too-many/too-few call never also reports a type complaint. */
export function validateArgs(path: string, schema: ArgSchema, args: unknown[]): void {
  const eff = resolveCallArgs(schema, args).args;
  if (eff.length < schema.min) {
    throw new TypeError(`zeolite: ${path}: expected at least ${schema.min} argument(s), got ${eff.length}`);
  }
  if (eff.length > schema.max) {
    throw new TypeError(`zeolite: ${path}: expected at most ${schema.max} argument(s), got ${eff.length}`);
  }
  const types = schema.types;
  if (!types) return;
  for (let i = 0; i < eff.length && i < types.length; i++) {
    const allowed = types[i];
    if (!allowed || allowed.includes("any")) continue;
    /* Standard optional-argument semantics: an explicit undefined at
       an optional position (i >= min) means "omitted" - real callers
       write f(id, undefined) - while undefined at a required position
       still fails the kind check, as Firefox's schema would. */
    if (eff[i] === undefined && i >= schema.min) continue;
    const kind = argKindOf(eff[i]);
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
      const { args: call, callback } = resolveCallArgs(schema, args);
      validateArgs(path, schema, call);
      const result = (fn as (...a: unknown[]) => unknown).apply(parent, call);
      if (!callback) return result;
      /* Honor the sliced-off response callback on both surfaces (a
         deliberate Firefox deviation: browser.* is promise-only
         there, recorded in COMPAT under "chrome.* callback
         style"): invoked once with the fulfillment value, no
         arguments when the value is undefined, and no arguments on
         rejection while the returned promise stays rejected so the
         failure remains visible to promise-style callers. */
      Promise.resolve(result).then(
        (value) => {
          queueMicrotask(() => {
            if (value === undefined) callback();
            else callback(value);
          });
        },
        () => {
          queueMicrotask(() => callback());
        },
      );
      return result;
    };
  }
}
