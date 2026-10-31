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
  "runtime.getManifest": { supported: "yes", reason: "async in background worlds; synchronous in extension pages (the manifest is embedded in the page bridge, #560)" },
  "runtime.getURL": { supported: "yes" },
  "runtime.sendMessage": { supported: "yes" },
  "runtime.onMessage": { supported: "yes" },
  "runtime.connect": { supported: "yes" },
  "runtime.onConnect": { supported: "yes" },
  "runtime.lastError": { supported: "yes" },
  "runtime.onInstalled": { supported: "yes", reason: "fires at first background boot with {reason: \"install\"}" },
  "runtime.onStartup": { supported: "yes", reason: "fires at every later background boot" },
  "background scripts (MV2 & Firefox MV3)": { supported: "yes", reason: "executed in a function scope with the extension API object; no engine-global access" },
  "chrome.extension (MV2)": { supported: "yes", reason: "inIncognitoContext false (the engine has no incognito contexts), getURL shared with runtime, getBackgroundPage null and getViews []; MV3 records get no namespace, Chrome parity" },
  "chrome.i18n": { supported: "partial", reason: "getMessage answers from the package own _locales (navigator match, then default_locale) with Chrome $n substitution and $NAME$ placeholder semantics; a missing name answers the empty string. getUILanguage/getAcceptLanguages report the resolved locale - the engine has no locale host beyond the worker navigator; detectLanguage is absent" },
  "runtime.onMessageExternal": { supported: "no", reason: "cross-extension messaging not implemented" },
  "storage.local": { supported: "yes", reason: "mounted only with the 'storage' permission, as in Firefox (#50)" },
  "storage.sync": { supported: "partial", reason: "real API, but sync is local persistence only; no account backend" },
  "storage.session": { supported: "partial", reason: "in-memory as in Firefox, but per-context isolation pending the background runtime" },
  "content_scripts (manifest)": { supported: "partial", reason: "injection works via a bridge script in the page world; true isolated worlds need a renderer-level primitive a SW engine lacks" },
  "content-script runtime.sendMessage": { supported: "yes", reason: "MessageChannel to the SW with sender-page host verification" },
  "content-script runtime.onMessage": { supported: "partial", reason: "listeners register in the page-world bridge and background pushes via the zl:tabMessage channel with destination verification; no isolated world, so a listener cannot be hidden from page scripts" },
  "content-script storage access": { supported: "partial", reason: "local area via the verified bridge channel; sync/session pending. No isolated world: ANY script on a matched page can post the zl:ext storage ops itself, so storage.local is NOT hidden from the page (#336); no engine-side fix exists without a renderer-level isolated world" },
  "browser.scripting": { supported: "partial", reason: "executeScript/insertCSS read files from the package and run them in the page world via the SW->page channel; scripting + host permissions enforced; func injection and result capture not implemented" },
  "tabs.*": { supported: "partial", reason: "query/get/events mirror the real UI tab model via the UI->SW sync channel; create/update/remove dispatch to the UI and resolve on observed change; url/title visibility gated by the tabs/host permissions as in Firefox" },
  "tabs.sendMessage": { supported: "partial", reason: "background->content-script delivery with host-permission checks and a 30s response window; frame targeting is rejected honestly (content scripts run in the page world), and a removed tab's pending message rejects immediately instead of timing out" },
  "tabs.getCurrent": { supported: "no", reason: "no tab context exists in this engine; rejects honestly" },
  "windows.*": { supported: "partial", reason: "single-window engine: get/getCurrent/getLastFocused/getAll with optional tab population; focus events never fire" },
  "cookies.*": { supported: "partial", reason: "get/getAll/set/remove over the virtual cookie jar with the same host-permission gating webRequest uses; reads see the active jar profile, writes pass the central admission gates (an extension cannot mint HttpOnly, and a rejected set resolves null); onChanged fires for extension-driven set and remove (cause explicit); upstream Set-Cookie jar merges are not surfaced yet" },
  "webRequest.*": { supported: "partial", reason: "onBeforeRequest (cancel honored with webRequestBlocking), onBeforeSendHeaders/onHeadersReceived header modification, onCompleted/onErrorOccurred observation, all wired into the engine fetch pipeline with host-permission and url-filter gating; MV3 declarativeNetRequest is absent" },
  "webNavigation.onCommitted": { supported: "partial", reason: "fires for main-frame document loads observed by the engine's fetch pipeline; tab ids resolved from the UI tab model by exact destination match; listener url filters use the webRequest pattern grammar" },
  "webNavigation.onBeforeNavigate/onCompleted": { supported: "partial", reason: "beforeNavigate fires at navigation interception, completed when the document stream ends; tab ids resolved from the UI tab model by exact destination match; listener url filters use the webRequest pattern grammar" },
  "webNavigation.onDOMContentLoaded": { supported: "partial", reason: "fires via the page-world content-script bridge; pages without a bridge (no matching content scripts) report nothing" },
  "alarms.*": { supported: "partial", reason: "real create/get/getAll/clear/clearAll/onAlarm with in-memory timers in the shared worker context; alarms do not survive an engine restart and are never persisted to disk" },
  "management.*": { supported: "partial", reason: "getSelf/uninstallSelf with no permission; get/getAll/setEnabled/uninstall of other extensions gated on the 'management' permission; onInstalled/onUninstalled/onEnabled/onDisabled fire on observed lifecycle transitions" },
  "contextMenus.*": { supported: "partial", reason: "item registry (nesting, checkbox/radio/separator types) + onClicked delivery via the zl:menuClick channel with tabs-bridge tab resolution; zl:listMenus exposes the registry to the host; the visible menu surface ships with the LobsterBrowse integration" },
  "notifications.*": { supported: "partial", reason: "create/update/clear/getAll over a real registry handed to the host UI via zl:notifyOp; onClosed/onClicked/onButtonClicked fire from the host's zl:notifyEvent reports (idle MV3 backgrounds woken); the rendering surface ships with the LobsterBrowse integration" },
  "downloads.*": { supported: "partial", reason: "download() hands off to the UI host via zl:downloadOp with permission checks; search/onChanged answer from the zl:downloadState host-report registry (own handoffs only, in-memory, lost on worker restart)" },
  "permissions.contains": { supported: "yes" },
  "permissions.getAll": { supported: "yes" },
  "permissions.request": { supported: "partial", reason: "granted automatically when the manifest declared it in optional_permissions; the engine has no user prompt" },
  "permissions.remove": { supported: "yes" },
  "permissions.onAdded/onRemoved": { supported: "partial", reason: "fires with the requested set; not deduplicated against already-granted entries" },
  "background.service_worker (MV3)": { supported: "partial", reason: "executed on demand (extension messages, menu clicks, alarms) via wakeExtension with a 30s idle termination; re-wakes fire no lifecycle events, and shared-context event listeners survive termination (documented limitation)" },
  "background.page (MV2)": { supported: "partial", reason: "the page's classic inline and external scripts are extracted and run in the background sandbox in document order, and background.page takes precedence over background.scripts exactly as in Chrome; the scripts receive an inert document stub and a window alias as scope params (the stub's script-tag loader fetches package resources and evaluates them in the same scope, #560), and the page itself is not browsable (#505)" },
  "webextension-polyfill (background + popup contexts)": { supported: "yes", reason: "background boots expose globalThis.browser/.chrome during the synchronous script load (verified against the polyfill's 0.12.0 detection), so it binds to the native promise surface and never wraps; popup/options pages expose window.browser natively (#139)" },
  "webextension-polyfill (content scripts)": { supported: "no", reason: "content scripts run in the page's JS world; a global browser would hand a hostile page the extension's API object via a property-setter trap, so the global detection stays unsatisfied there - content scripts use the injected (browser, chrome) scope params (#139)" },
  "chrome.* callback style": { supported: "partial", reason: "implemented async background APIs accept callbacks with callback-scoped runtime.lastError; calls without callbacks keep Promises. Extension-page bridges accept trailing-function callbacks resolved with the call outcome (undefined on failure) while keeping the promise return (#560); content-script bridges remain promise-only; synchronous methods and event registration are unchanged" },
  "sidebar_action": { supported: "no", reason: "parsed and recorded; no sidebar host yet" },
  "popup pages": { supported: "partial", reason: "served ROOTED at the origin root (/options.html?zlExt=<id>, #560) so pathname-keyed boot dispatch matches real extension origins, with relative resources re-rooted by an injected <base> tag onto /zl-ext/<id>/; the page bridge is injected into HTML: browser.runtime/storage/cookies/downloads/notifications/contextMenus subset; runtime.connect opens a duplex port bridged to the background onConnect listeners (#560); other events are not delivered; the host opens them via the zl:openExtPage token flow" },
  "options pages": { supported: "partial", reason: "same rooted hosting as popups (runtime.connect ports included, #560; synchronous getManifest and callback-shape calls in the page bridge); the first navigation needs a zl:openExtPage token (or self-navigation from an already-open page of the same extension); pages are in-memory state, so a worker restart requires re-opening via zl:openExtPage; residual: tabs.create/window.open of a getURL page from a non-registered client (the background world) falls through to virtual handling" },
  "runtime.connect (extension pages)": { supported: "partial", reason: "the page bridge transfers one end of a MessageChannel to the SW, which pairs it with a real extension port so background onConnect listeners receive a Chrome-shaped Port with onMessage/onDisconnect event objects (#560); page-side runtime.onConnect stays undelivered and cross-extension connect is refused everywhere" },
  "web_accessible_resources": { supported: "partial", reason: "MV2 globs enforced by the resource loader; MV3 matches scopes enforced against the SW-observed requesting page destination (#51); extension_ids scoping not implemented" },
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

