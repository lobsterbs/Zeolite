/* Zeolite extension subsystem: compatibility matrix.

   Machine-readable, per API. "partial" means the surface exists with
   real behavior but known gaps; "no" entries carry the reason. This is
   the honest compatibility contract â nothing is listed as supported
   without an implementation behind it. */

export type CompatLevel = "yes" | "partial" | "no";

export interface CompatEntry {
  supported: CompatLevel;
  reason?: string;
}

export const COMPAT: Record<string, CompatEntry> = {
  "runtime.id": { supported: "yes" },
  "runtime.getManifest": { supported: "yes" },
  "runtime.getURL": { supported: "yes" },
  "runtime.sendMessage": { supported: "yes" },
  "runtime.onMessage": { supported: "yes" },
  "runtime.connect": { supported: "yes" },
  "runtime.onConnect": { supported: "yes" },
  "runtime.lastError": { supported: "yes" },
  "runtime.onInstalled": { supported: "yes", reason: "fires at first background boot with {reason: \"install\"}" },
  "runtime.onStartup": { supported: "yes", reason: "fires at every later background boot" },
  "background scripts (MV2 & Firefox MV3)": { supported: "yes", reason: "executed in a function scope with the extension API object; no engine-global access" },
  "runtime.onMessageExternal": { supported: "no", reason: "cross-extension messaging not implemented" },
  "storage.local": { supported: "yes" },
  "storage.sync": { supported: "partial", reason: "real API, but sync is local persistence only; no account backend" },
  "storage.session": { supported: "partial", reason: "in-memory as in Firefox, but per-context isolation pending the background runtime" },
  "content_scripts (manifest)": { supported: "partial", reason: "injection works via a bridge script in the page world; true isolated worlds need a renderer-level primitive a SW engine lacks" },
  "content-script runtime.sendMessage": { supported: "yes", reason: "MessageChannel to the SW with sender-page host verification" },
  "content-script runtime.onMessage": { supported: "partial", reason: "listeners register in the page-world bridge and background pushes via the zl:tabMessage channel with destination verification; no isolated world, so a listener cannot be hidden from page scripts" },
  "content-script storage access": { supported: "partial", reason: "local area via the verified bridge channel; sync/session pending" },
  "browser.scripting": { supported: "partial", reason: "executeScript/insertCSS read files from the package and run them in the page world via the SW->page channel; scripting + host permissions enforced; func injection and result capture not implemented" },
  "tabs.*": { supported: "partial", reason: "query/get/events mirror the real UI tab model via the UI->SW sync channel; create/update/remove dispatch to the UI and resolve on observed change; url/title visibility gated by the tabs/host permissions as in Firefox" },
  "tabs.sendMessage": { supported: "partial", reason: "background->content-script delivery with host-permission checks and a 30s response window; frame targeting is not supported, and a tab whose page never answers rejects on timeout" },
  "tabs.getCurrent": { supported: "no", reason: "no tab context exists in this engine; rejects honestly" },
  "windows.*": { supported: "partial", reason: "single-window engine: get/getCurrent/getLastFocused/getAll with optional tab population; focus events never fire" },
  "cookies.*": { supported: "no", reason: "requires the Zeolite virtual cookie jar bridge" },
  "webRequest.*": { supported: "partial", reason: "onBeforeRequest (cancel honored with webRequestBlocking), onBeforeSendHeaders/onHeadersReceived header modification, onCompleted/onErrorOccurred observation, all wired into the engine fetch pipeline with host-permission and url-filter gating; MV3 declarativeNetRequest is absent" },
  "webNavigation.onCommitted": { supported: "partial", reason: "fires for main-frame document loads observed by the engine's fetch pipeline; tab ids resolved from the UI tab model by exact destination match; listener url filters are not applied" },
  "webNavigation.onBeforeNavigate/onCompleted": { supported: "partial", reason: "beforeNavigate fires at navigation interception, completed when the document stream ends; tab ids resolved from the UI tab model by exact destination match; listener url filters are not applied" },
  "webNavigation.onDOMContentLoaded": { supported: "no", reason: "the fetch pipeline sees response bytes, not the page's DOM readiness" },
  "contextMenus.*": { supported: "partial", reason: "item registry + onClicked delivery via the zl:menuClick channel with tabs-bridge tab resolution; the visible menu surface ships with the LobsterBrowse integration" },
  "notifications.*": { supported: "no", reason: "requires the LobsterBrowse notification surface" },
  "downloads.*": { supported: "partial", reason: "download() hands off to the UI host via zl:downloadOp with permission checks; download-state queries and events absent until the UI reports state back" },
  "permissions.contains": { supported: "yes" },
  "permissions.getAll": { supported: "yes" },
  "permissions.request": { supported: "partial", reason: "granted automatically when the manifest declared it in optional_permissions; the engine has no user prompt" },
  "permissions.remove": { supported: "yes" },
  "permissions.onAdded/onRemoved": { supported: "partial", reason: "fires with the requested set; not deduplicated against already-granted entries" },
  "management.*": { supported: "no", reason: "not started" },
  "background.service_worker (MV3)": { supported: "partial", reason: "executed on demand (extension messages, menu clicks) via wakeExtension with a 30s idle termination; re-wakes fire no lifecycle events, and shared-context event listeners survive termination (documented limitation)" },
  "sidebar_action": { supported: "no", reason: "parsed and recorded; no sidebar host yet" },
  "popup pages": { supported: "no", reason: "extension-origin page hosting lands with the toolbar/popup phase" },
  "options pages": { supported: "no", reason: "extension-origin page hosting lands with the toolbar/popup phase" },
  "web_accessible_resources": { supported: "yes", reason: "glob exposure enforced by the resource loader" },
  "zip/xpi install": { supported: "yes" },
  "unpacked install": { supported: "yes" },
};

export function compatReport(): { api: string; supported: CompatLevel; reason?: string }[] {
  return Object.entries(COMPAT).map(([api, e]) => ({
    api,
    supported: e.supported,
    ...(e.reason ? { reason: e.reason } : {}),
  }));
}

