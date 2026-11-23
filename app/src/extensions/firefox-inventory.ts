/* Zeolite extension subsystem: exhaustive Firefox API inventory
   (#516, slice 2).

   The seed inventory (./inventory.ts) made the engine's mounted
   surface self-describing; this module adds the other side of the
   diff, the Firefox browser.* surface itself, so conformance tests
   can hold the mount against Firefox, not just the compat matrix.

   Data: member-level namespace inventory transcribed from
   @types/firefox-webext-browser 143.0.1 (community types generated
   from Firefox's own schemas JSON). Taxonomy matches
   buildInventory(): method | event | constant. Argument schemas
   live in ./arg-schemas.ts, version annotations in
   ./firefox-versions.ts; regenerate when Firefox's schema changes.

   Four conformance facts live here:
   - FIREFOX_UNMOUNTED_REASONS: every Firefox namespace the engine
     does NOT mount, with the honest reason. A namespace that gains
     an implementation must remove its reason (the conformance test
     enforces the 1:1 match), so the gap list cannot go stale.
   - FIREFOX_MEMBER_GAP_REASONS: every Firefox member missing from a
     mounted namespace, with the honest reason it stays unmounted;
     firefoxGapReport() refuses a stale or unmotivated entry.
   - ENGINE_EXTRA_MEMBERS: members the engine mounts that Firefox
     does NOT have. Each carries the reason and the COMPAT key that
     documents it, so every deviation from Firefox stays justified.
   - firefoxGapReport(): the machine-readable gap list driving
     #517-#524: unmounted namespaces, Firefox members missing from
     mounted namespaces, and the engine extras. */

import type { InventoryMember } from "./inventory";

type MemberKind = InventoryMember["kind"];

/** Firefox browser.* API surface, member level. Dotted keys are
    nested namespaces (privacy.network). Zero-member namespaces are
    real schema namespaces whose members are types only (events,
    types, extensionTypes) or parents of nested namespaces (privacy,
    devtools). */
export const FIREFOX_API: Record<string, Record<string, MemberKind>> = {
  action: { disable: "method", enable: "method", getBadgeBackgroundColor: "method", getBadgeText: "method", getBadgeTextColor: "method", getPopup: "method", getTitle: "method", getUserSettings: "method", isEnabled: "method", onClicked: "event", openPopup: "method", setBadgeBackgroundColor: "method", setBadgeText: "method", setBadgeTextColor: "method", setIcon: "method", setPopup: "method", setTitle: "method" },
  activityLog: { onExtensionActivity: "event" },
  alarms: { clear: "method", clearAll: "method", create: "method", get: "method", getAll: "method", onAlarm: "event" },
  bookmarks: { create: "method", get: "method", getChildren: "method", getRecent: "method", getSubTree: "method", getTree: "method", move: "method", onChanged: "event", onCreated: "event", onMoved: "event", onRemoved: "event", remove: "method", removeTree: "method", search: "method", update: "method" },
  browserAction: { disable: "method", enable: "method", getBadgeBackgroundColor: "method", getBadgeText: "method", getBadgeTextColor: "method", getPopup: "method", getTitle: "method", getUserSettings: "method", isEnabled: "method", onClicked: "event", onUserSettingsChanged: "event", openPopup: "method", setBadgeBackgroundColor: "method", setBadgeText: "method", setBadgeTextColor: "method", setIcon: "method", setPopup: "method", setTitle: "method" },
  browserSettings: { allowPopupsForUserEvents: "constant", cacheEnabled: "constant", closeTabsByDoubleClick: "constant", contextMenuShowEvent: "constant", ftpProtocolEnabled: "constant", homepageOverride: "constant", imageAnimationBehavior: "constant", newTabPageOverride: "constant", newTabPosition: "constant", openBookmarksInNewTabs: "constant", openSearchResultsInNewTabs: "constant", openUrlbarResultsInNewTabs: "constant", overrideContentColorScheme: "constant", overrideDocumentColors: "constant", useDocumentFonts: "constant", verticalTabs: "constant", webNotificationsDisabled: "constant", zoomFullPage: "constant", zoomSiteSpecific: "constant" },
  "browserSettings.colorManagement": { mode: "constant", useNativeSRGB: "constant", useWebRenderCompositor: "constant" },
  browsingData: { remove: "method", removeAppcache: "method", removeCache: "method", removeCookies: "method", removeDownloads: "method", removeFileSystems: "method", removeFormData: "method", removeHistory: "method", removeIndexedDB: "method", removeLocalStorage: "method", removePasswords: "method", removePluginData: "method", removeWebSQL: "method", settings: "method" },
  captivePortal: { canonicalURL: "constant", getLastChecked: "method", getState: "method", onConnectivityAvailable: "event", onStateChanged: "event" },
  clipboard: { setImageData: "method" },
  commands: { getAll: "method", onChanged: "event", onCommand: "event", openShortcutSettings: "method", reset: "method", update: "method" },
  contentScripts: { register: "method" },
  contextMenus: { ACTION_MENU_TOP_LEVEL_LIMIT: "constant", create: "method", getTargetElement: "method", onClicked: "event", onHidden: "event", onShown: "event", overrideContext: "method", refresh: "method", remove: "method", removeAll: "method", update: "method" },
  contextualIdentities: { create: "method", get: "method", move: "method", onCreated: "event", onRemoved: "event", onUpdated: "event", query: "method", remove: "method", update: "method" },
  cookies: { get: "method", getAll: "method", getAllCookieStores: "method", onChanged: "event", remove: "method", set: "method" },
  declarativeNetRequest: { DYNAMIC_RULESET_ID: "constant", GUARANTEED_MINIMUM_STATIC_RULES: "constant", MAX_NUMBER_OF_DISABLED_STATIC_RULES: "constant", MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: "constant", MAX_NUMBER_OF_DYNAMIC_RULES: "constant", MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: "constant", MAX_NUMBER_OF_REGEX_RULES: "constant", MAX_NUMBER_OF_SESSION_RULES: "constant", MAX_NUMBER_OF_STATIC_RULESETS: "constant", SESSION_RULESET_ID: "constant", getAvailableStaticRuleCount: "method", getDisabledRuleIds: "method", getDynamicRules: "method", getEnabledRulesets: "method", getSessionRules: "method", isRegexSupported: "method", testMatchOutcome: "method", updateDynamicRules: "method", updateEnabledRulesets: "method", updateSessionRules: "method", updateStaticRules: "method" },
  devtools: {},
  "devtools.inspectedWindow": { eval: "method", getResources: "method", onResourceAdded: "event", onResourceContentCommitted: "event", reload: "method", tabId: "constant" },
  "devtools.network": { getHAR: "method", onNavigated: "event", onRequestFinished: "event" },
  "devtools.panels": { create: "method", elements: "constant", onThemeChanged: "event", openResource: "method", setOpenResourceHandler: "method", sources: "constant", themeName: "constant" },
  dns: { resolve: "method" },
  downloads: { acceptDanger: "method", cancel: "method", download: "method", drag: "method", erase: "method", getFileIcon: "method", onChanged: "event", onCreated: "event", onErased: "event", open: "method", pause: "method", removeFile: "method", resume: "method", search: "method", setShelfEnabled: "method", show: "method", showDefaultFolder: "method" },
  events: {},
  experiments: {},
  extension: { getBackgroundPage: "method", getURL: "method", getViews: "method", inIncognitoContext: "constant", isAllowedFileSchemeAccess: "method", isAllowedIncognitoAccess: "method", lastError: "constant", setUpdateUrlData: "method" },
  extensionTypes: {},
  find: { find: "method", highlightResults: "method", removeHighlighting: "method" },
  geckoProfiler: { dumpProfileToFile: "method", getProfile: "method", getProfileAsArrayBuffer: "method", getProfileAsGzippedArrayBuffer: "method", getSymbols: "method", onRunning: "event", pause: "method", resume: "method", start: "method", stop: "method" },
  history: { addUrl: "method", deleteAll: "method", deleteRange: "method", deleteUrl: "method", getVisits: "method", onTitleChanged: "event", onVisitRemoved: "event", onVisited: "event", search: "method" },
  i18n: { detectLanguage: "method", getAcceptLanguages: "method", getMessage: "method", getPreferredSystemLanguages: "method", getUILanguage: "method" },
  identity: { getAccounts: "method", getAuthToken: "method", getProfileUserInfo: "method", getRedirectURL: "method", launchWebAuthFlow: "method", onSignInChanged: "event", removeCachedAuthToken: "method" },
  idle: { onStateChanged: "event", queryState: "method", setDetectionInterval: "method" },
  management: { get: "method", getAll: "method", getSelf: "method", install: "method", onDisabled: "event", onEnabled: "event", onInstalled: "event", onUninstalled: "event", setEnabled: "method", uninstallSelf: "method" },
  menus: { ACTION_MENU_TOP_LEVEL_LIMIT: "constant", create: "method", getTargetElement: "method", onClicked: "event", onHidden: "event", onShown: "event", overrideContext: "method", refresh: "method", remove: "method", removeAll: "method", update: "method" },
  networkStatus: { getLinkInfo: "method", onConnectionChanged: "event" },
  normandyAddonStudy: { endStudy: "method", getClientMetadata: "method", getStudy: "method", onUnenroll: "event" },
  notifications: { clear: "method", create: "method", getAll: "method", getPermissionLevel: "method", onButtonClicked: "event", onClicked: "event", onClosed: "event", onPermissionLevelChanged: "event", onShowSettings: "event", onShown: "event", update: "method" },
  omnibox: { onDeleteSuggestion: "event", onInputCancelled: "event", onInputChanged: "event", onInputEntered: "event", onInputStarted: "event", setDefaultSuggestion: "method" },
  pageAction: { getPopup: "method", getTitle: "method", hide: "method", isShown: "method", onClicked: "event", openPopup: "method", setIcon: "method", setPopup: "method", setTitle: "method", show: "method" },
  permissions: { contains: "method", getAll: "method", onAdded: "event", onRemoved: "event", remove: "method", request: "method" },
  pkcs11: { getModuleSlots: "method", installModule: "method", isModuleInstalled: "method", uninstallModule: "method" },
  privacy: {},
  "privacy.network": { globalPrivacyControl: "constant", httpsOnlyMode: "constant", networkPredictionEnabled: "constant", peerConnectionEnabled: "constant", tlsVersionRestriction: "constant", webRTCIPHandlingPolicy: "constant" },
  "privacy.services": { passwordSavingEnabled: "constant" },
  "privacy.websites": { cookieConfig: "constant", firstPartyIsolate: "constant", hyperlinkAuditingEnabled: "constant", protectedContentEnabled: "constant", referrersEnabled: "constant", resistFingerprinting: "constant", thirdPartyCookiesAllowed: "constant", trackingProtectionMode: "constant" },
  proxy: { onError: "event", onRequest: "event", settings: "constant" },
  runtime: { connect: "method", connectNative: "method", getBackgroundPage: "method", getBrowserInfo: "method", getContexts: "method", getFrameId: "method", getManifest: "method", getPackageDirectoryEntry: "method", getPlatformInfo: "method", getURL: "method", id: "constant", lastError: "constant", onBrowserUpdateAvailable: "event", onConnect: "event", onConnectExternal: "event", onInstalled: "event", onMessage: "event", onMessageExternal: "event", onPerformanceWarning: "event", onRestartRequired: "event", onStartup: "event", onSuspend: "event", onSuspendCanceled: "event", onUpdateAvailable: "event", onUserScriptConnect: "event", onUserScriptMessage: "event", openOptionsPage: "method", reload: "method", requestUpdateCheck: "method", restart: "method", sendMessage: "method", sendNativeMessage: "method", setUninstallURL: "method" },
  scripting: { executeScript: "method", getRegisteredContentScripts: "method", insertCSS: "method", registerContentScripts: "method", removeCSS: "method", unregisterContentScripts: "method", updateContentScripts: "method" },
  search: { get: "method", query: "method", search: "method" },
  sessions: { MAX_SESSION_RESULTS: "constant", forgetClosedTab: "method", forgetClosedWindow: "method", getDevices: "method", getRecentlyClosed: "method", getTabValue: "method", getWindowValue: "method", onChanged: "event", removeTabValue: "method", removeWindowValue: "method", restore: "method", setTabValue: "method", setWindowValue: "method" },
  sidebarAction: { close: "method", getPanel: "method", getTitle: "method", isOpen: "method", open: "method", setIcon: "method", setPanel: "method", setTitle: "method", toggle: "method" },
  storage: { local: "constant", managed: "constant", onChanged: "event", session: "constant", sync: "constant" },
  tabGroups: { TAB_GROUP_ID_NONE: "constant", get: "method", move: "method", onCreated: "event", onMoved: "event", onRemoved: "event", onUpdated: "event", query: "method", update: "method" },
  tabs: { TAB_ID_NONE: "constant", captureTab: "method", captureVisibleTab: "method", connect: "method", create: "method", detectLanguage: "method", discard: "method", duplicate: "method", executeScript: "method", get: "method", getCurrent: "method", getZoom: "method", getZoomSettings: "method", goBack: "method", goForward: "method", group: "method", hide: "method", highlight: "method", insertCSS: "method", move: "method", moveInSuccession: "method", onActivated: "event", onAttached: "event", onCreated: "event", onDetached: "event", onHighlighted: "event", onMoved: "event", onRemoved: "event", onReplaced: "event", onUpdated: "event", onZoomChange: "event", print: "method", printPreview: "method", query: "method", reload: "method", remove: "method", removeCSS: "method", saveAsPDF: "method", sendMessage: "method", setZoom: "method", setZoomSettings: "method", show: "method", toggleReaderMode: "method", ungroup: "method", update: "method", warmup: "method" },
  telemetry: { canUpload: "method", keyedScalarAdd: "method", keyedScalarSet: "method", keyedScalarSetMaximum: "method", recordEvent: "method", registerEvents: "method", registerScalars: "method", scalarAdd: "method", scalarSet: "method", scalarSetMaximum: "method", setEventRecordingEnabled: "method", submitPing: "method" },
  theme: { getCurrent: "method", onUpdated: "event", reset: "method", update: "method" },
  topSites: { get: "method" },
  types: {},
  urlbar: { closeView: "method", engagementTelemetry: "constant", focus: "method", onBehaviorRequested: "event", onEngagement: "event", onQueryCanceled: "event", onResultPicked: "event", onResultsRequested: "event", search: "method" },
  userScripts: { configureWorld: "method", getScripts: "method", getWorldConfigurations: "method", onBeforeScript: "event", register: "method", resetWorldConfiguration: "method", unregister: "method", update: "method" },
  webNavigation: { getAllFrames: "method", getFrame: "method", onBeforeNavigate: "event", onCommitted: "event", onCompleted: "event", onCreatedNavigationTarget: "event", onDOMContentLoaded: "event", onErrorOccurred: "event", onHistoryStateUpdated: "event", onReferenceFragmentUpdated: "event", onTabReplaced: "event" },
  webRequest: { MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: "constant", filterResponseData: "method", getSecurityInfo: "method", handlerBehaviorChanged: "method", onAuthRequired: "event", onBeforeRedirect: "event", onBeforeRequest: "event", onBeforeSendHeaders: "event", onCompleted: "event", onErrorOccurred: "event", onHeadersReceived: "event", onResponseStarted: "event", onSendHeaders: "event" },
  windows: { WINDOW_ID_CURRENT: "constant", WINDOW_ID_NONE: "constant", create: "method", get: "method", getAll: "method", getCurrent: "method", getLastFocused: "method", onCreated: "event", onFocusChanged: "event", onRemoved: "event", remove: "method", update: "method" },
};

/** Every Firefox namespace absent from the mounted surface, with the
    honest reason it stays absent. Kept 1:1 with the unmounted set by
    the conformance tests. */
export const FIREFOX_UNMOUNTED_REASONS: Record<string, string> = {
  activityLog: "privileged namespace (System-privileged add-ons only); no engine surface",
  browserSettings: "host settings (homepage, new-tab override, cache) have no engine surface (#521)",
  "browserSettings.colorManagement": "no host color-management surface (#521)",
  captivePortal: "no captive-portal detection exists in the engine (#522)",
  clipboard: "setImageData needs a page-realm clipboard host surface (#523)",
  commands: "manifest commands are parsed and recorded (#519) but no keyboard surface exists to fire onCommand or to report shortcuts",
  contentScripts: "programmatic content-script registration needs the isolated-world work (#517)",
  contextualIdentities: "no Firefox container model; jar profiles are engine-internal, not a contextualIdentities surface (#522)",
  devtools: "the devtools surface is served through the devtools page bridge (#523), not on browser.*",
  "devtools.inspectedWindow": "served through the devtools page bridge (#523), not on browser.*",
  "devtools.network": "served through the devtools page bridge (#523), not on browser.*",
  "devtools.panels": "served through the devtools page bridge (#523), not on browser.*",
  dns: "the service worker cannot resolve names; DNS lives server-side (#521)",
  events: "schema type namespace (events.Event); no runtime surface in Firefox either",
  experiments: "schema namespace for experiment APIs; no runtime surface",
  extensionTypes: "schema enum types (RunAt, CSSOrigin); no runtime object in Firefox either",
  find: "the engine finder is a page feature, not an extension API surface (#520/#523)",
  geckoProfiler: "privileged namespace; no engine surface",
  identity: "no OAuth redirect host surface (#522)",
  idle: "no OS idle source; reporting 'active' unconditionally would fake a signal, so the namespace stays unmounted (#522: 'where platform capability exists')",
  networkStatus: "no host network-status source (#521/#522)",
  normandyAddonStudy: "privileged namespace (Firefox study machinery); no engine surface",
  omnibox: "no address-bar surface (#519)",
  pkcs11: "no PKCS#11 module integration (#522)",
  privacy: "host privacy settings have no engine surface (#521)",
  "privacy.network": "host privacy settings have no engine surface (#521)",
  "privacy.services": "host privacy settings have no engine surface (#521)",
  "privacy.websites": "host privacy settings have no engine surface (#521)",
  proxy: "proxy configuration is engine config (KDL), not an extension API (#521)",
  search: "no search-engine integration (#522)",
  sessions: "no closed-tab/window history; the UI tab model does not report closures to the engine (#519)",
  sidebarAction: "parsed from manifests; no sidebar host (#519)",
  tabGroups: "the UI tab model has no group concept (#519)",
  telemetry: "privileged namespace; no engine surface",
  theme: "theme manifest keys are parsed and recorded (#524); no host theme engine consumes them",
  types: "schema type namespace (types.Setting); no runtime surface in Firefox either",
  urlbar: "privileged namespace; no engine surface",
  userScripts: "userScripts registration needs the isolated-world work (#517)",
};

/** Members the engine mounts that Firefox does NOT have. Every entry
    must be a real mounted member, absent from FIREFOX_API, and name
    the COMPAT key that documents the deviation. */
export const ENGINE_EXTRA_MEMBERS: Record<string, Record<string, { reason: string; compatKey: string }>> = {
  browsingData: {
    removeServiceWorkers: {
      reason: "Chrome parity: Firefox has no browsingData.removeServiceWorkers; the engine really clears its guest service-worker realms",
      compatKey: "browsingData.*",
    },
  },
  declarativeNetRequest: {
    getMatchedRules: {
      reason: "Chrome's DNR feedback surface, mounted only with the declarativeNetRequestFeedback permission; Firefox has no DNR debug surface",
      compatKey: "declarativeNetRequest.*",
    },
    onRuleMatchedDebug: {
      reason: "Chrome's DNR feedback event, gated and bounded exactly like getMatchedRules; Firefox has no DNR debug surface",
      compatKey: "declarativeNetRequest.*",
    },
  },
  management: {
    uninstall: {
      reason: "Chrome parity: Firefox never implemented management.uninstall (MDN marks it unsupported there); the engine uninstalls behind the 'management' permission",
      compatKey: "management.*",
    },
  },
};

/** Every Firefox member missing from a mounted namespace, with the
    honest reason it stays unmounted. Kept 1:1 with the live gap set
    by firefoxGapReport() itself: a reason for a mounted member, or
    a gap without a reason, throws. */
export const FIREFOX_MEMBER_GAP_REASONS: Record<string, string> = {
  "action.getUserSettings": "toolbar placement and user toggles are host-UI state the engine cannot see",
  "action.openPopup": "opening the action popup is a host-UI gesture; no popup host verb exists",
  "browserAction.getUserSettings": "toolbar placement and user toggles are host-UI state the engine cannot see",
  "browserAction.onUserSettingsChanged": "user action settings are host-UI state with no change reporting",
  "browserAction.openPopup": "opening the action popup is a host-UI gesture; no popup host verb exists",
  "contextMenus.getTargetElement": "menu targets live in the page realm; unreachable without content-script worlds (#517)",
  "contextMenus.onHidden": "menu visibility is host-UI state; no menu host reports it",
  "contextMenus.onShown": "menu visibility is host-UI state; no menu host reports it",
  "contextMenus.overrideContext": "privileged Firefox UI override; no menu host exists",
  "contextMenus.refresh": "no host menu surface to refresh",
  "downloads.acceptDanger": "no OS download manager or danger-prompt surface exists",
  "downloads.cancel": "the engine hands downloads to the host; it holds no live transfer to cancel",
  "downloads.drag": "drag-on-demand is a host-UI gesture with no download surface",
  "downloads.getFileIcon": "no OS file-icon surface exists",
  "downloads.open": "no OS opener surface inside the engine",
  "downloads.pause": "the engine hands downloads to the host; it holds no live transfer to pause",
  "downloads.removeFile": "no OS file-system surface exists",
  "downloads.resume": "the engine hands downloads to the host; it holds no live transfer to resume",
  "downloads.setShelfEnabled": "no download shelf exists in the engine or host",
  "downloads.show": "no OS download-folder surface exists",
  "downloads.showDefaultFolder": "no OS download-folder surface exists",
  "extension.setUpdateUrlData": "update-URL state belongs to a host updater; the engine ships no updater",
  "history.onTitleChanged": "titles never reach the worker; the visit store records URLs only",
  "i18n.detectLanguage": "no language-detection model ships with the engine; a guess would fake the detection",
  "management.install": "no fetch-and-prompt install host; packages install through the engine's own manager",
  "menus.getTargetElement": "menu targets live in the page realm; unreachable without content-script worlds (#517)",
  "menus.onHidden": "menu visibility is host-UI state; no menu host reports it",
  "menus.onShown": "menu visibility is host-UI state; no menu host reports it",
  "menus.overrideContext": "privileged Firefox UI override; no menu host exists",
  "menus.refresh": "no host menu surface to refresh",
  "notifications.onPermissionLevelChanged": "the permission level is install-granted and immutable in this engine, so it can never honestly fire",
  "notifications.onShowSettings": "no OS notification-settings surface exists",
  "notifications.onShown": "the notification host reports click and close only; no shown event exists",
  "pageAction.openPopup": "opening the action popup is a host-UI gesture; no popup host verb exists",
  "runtime.connectNative": "native-messaging hosts are host-OS processes; the sandboxed worker has no process bridge",
  "runtime.getBackgroundPage": "MV2 background pages have no DOM window in a service-worker engine",
  "runtime.getFrameId": "frame identity exists only for content-script contexts (#517); the background context owns no frame",
  "runtime.getPackageDirectoryEntry": "the legacy DirectoryEntry API is not available inside a service worker",
  "runtime.onBrowserUpdateAvailable": "deprecated alias of onUpdateAvailable; host update lifecycle is not observable in-engine",
  "runtime.onPerformanceWarning": "no performance-warning emitter exists for extension contexts",
  "runtime.onRestartRequired": "host restart lifecycle is not observable in-engine",
  "runtime.onSuspendCanceled": "no suspend-cancel event source exists in the engine",
  "runtime.onUserScriptConnect": "userScripts messaging needs the isolated-world work (#517)",
  "runtime.onUserScriptMessage": "userScripts messaging needs the isolated-world work (#517)",
  "runtime.restart": "restarting the host browser is outside an embedded engine's authority",
  "runtime.sendNativeMessage": "native-messaging hosts are host-OS processes; the sandboxed worker has no process bridge",
  "scripting.getRegisteredContentScripts": "persistent content-script registration targets the content-script world (#517)",
  "scripting.registerContentScripts": "persistent content-script registration targets the content-script world (#517)",
  "scripting.removeCSS": "injected styles carry no removal token; rides the scripting CSS work (#519)",
  "scripting.unregisterContentScripts": "persistent content-script registration targets the content-script world (#517)",
  "scripting.updateContentScripts": "persistent content-script registration targets the content-script world (#517)",
  "tabs.captureTab": "the engine never rasterizes pages; no rendering surface exists",
  "tabs.captureVisibleTab": "the engine never rasterizes pages; no rendering surface exists",
  "tabs.connect": "per-tab channel messaging needs content-script contexts (#517)",
  "tabs.detectLanguage": "no language-detection model ships with the engine; a guess would fake the detection",
  "tabs.discard": "tab lifecycle (memory pressure, discard) belongs to the host UI; the tab registry is synchronized, not driven",
  "tabs.executeScript": "tab-legacy injection routes through the scripting engine; not mounted yet (#519 lane)",
  "tabs.getZoom": "zoom is host-UI state; the virtualized page has no zoom surface",
  "tabs.getZoomSettings": "zoom is host-UI state; the virtualized page has no zoom surface",
  "tabs.goBack": "session-history control is a host-UI verb; the tab bridge carries no history verb",
  "tabs.goForward": "session-history control is a host-UI verb; the tab bridge carries no history verb",
  "tabs.group": "the UI tab model has no group concept",
  "tabs.hide": "tab visibility is host-UI state; the tab bridge carries no visibility verb",
  "tabs.insertCSS": "tab-legacy style injection routes through the scripting engine; not mounted yet (#519 lane)",
  "tabs.move": "tab placement belongs to the host UI; the bridge has no move verb",
  "tabs.moveInSuccession": "tab placement belongs to the host UI; the bridge has no move verb",
  "tabs.onAttached": "window/tab attachment events need host-UI reporting; the bridge does not report them",
  "tabs.onDetached": "window/tab attachment events need host-UI reporting; the bridge does not report them",
  "tabs.onHighlighted": "the UI tab model has no selection surface to highlight",
  "tabs.onMoved": "the tab bridge does not report movement",
  "tabs.onReplaced": "prerender swaps do not exist; the tab model is UI-owned",
  "tabs.onZoomChange": "zoom is host-UI state; the virtualized page has no zoom surface",
  "tabs.print": "no rendering surface exists to print a proxied page",
  "tabs.printPreview": "no rendering surface exists to print a proxied page",
  "tabs.reload": "reload is a host-UI verb; the tab bridge carries no reload verb",
  "tabs.removeCSS": "injected styles carry no removal token; rides the scripting CSS work (#519)",
  "tabs.saveAsPDF": "no rendering surface exists to rasterize a proxied page to PDF",
  "tabs.setZoom": "zoom is host-UI state; the virtualized page has no zoom surface",
  "tabs.setZoomSettings": "zoom is host-UI state; the virtualized page has no zoom surface",
  "tabs.show": "tab visibility is host-UI state; the tab bridge carries no visibility verb",
  "tabs.toggleReaderMode": "reader mode is a Firefox UI feature with no engine or host equivalent",
  "tabs.ungroup": "the UI tab model has no group concept",
  "tabs.warmup": "preloading is a host tab-scheduler hint with no engine equivalent",
  "webNavigation.getAllFrames": "no frame-tree query surface exists; navigation events carry what the bridge reports",
  "webNavigation.getFrame": "no frame-tree query surface exists; navigation events carry what the bridge reports",
  "webNavigation.onCreatedNavigationTarget": "target-attribute navigations are not reported by the navigation bridge",
  "webNavigation.onErrorOccurred": "navigation errors are engine-internal; the bridge reports stages only",
  "webNavigation.onHistoryStateUpdated": "same-document session-history updates happen in the page realm; the worker cannot see them",
  "webNavigation.onReferenceFragmentUpdated": "hash-only navigation happens in the page realm; the worker cannot see it",
  "webNavigation.onTabReplaced": "instant/prerender swaps do not exist; the tab model is UI-owned",
  "webRequest.filterResponseData": "response streams belong to the rewriter pipeline; per-listener body filters have no engine surface",
  "webRequest.getSecurityInfo": "transport security details stay inside the transport layer; no security-info surface reaches extensions",
  "webRequest.onAuthRequired": "auth challenges terminate inside the transport; no auth-prompt surface exists",
  "windows.create": "window lifecycle verbs belong to the host UI; the engine window view is synchronized, not driven",
  "windows.onCreated": "window lifecycle events need host-UI reporting; the bridge does not report them",
  "windows.onRemoved": "window lifecycle events need host-UI reporting; the bridge does not report them",
  "windows.remove": "window lifecycle verbs belong to the host UI; the engine window view is synchronized, not driven",
  "windows.update": "window lifecycle verbs belong to the host UI; the engine window view is synchronized, not driven",
};

export interface FirefoxGapReport {
  /** Firefox namespaces not mounted, with their reasons, sorted. */
  absentNamespaces: { name: string; reason: string }[];
  /** For every mounted namespace, the Firefox members it does not
      mount, sorted. */
  missingMembers: { namespace: string; members: string[] }[];
  /** Mounted members Firefox does not have (the justified extras). */
  engineExtras: { namespace: string; member: string; reason: string }[];
}

/** Diff a mounted api object (browser surface) against the Firefox
    inventory. The shape the #517-#524 waves diff against. */
export function firefoxGapReport(mounted: Record<string, unknown>): FirefoxGapReport {
  const mountedNamespaces = new Set(
    Object.keys(mounted).filter((n) => typeof mounted[n] === "object" && mounted[n] !== null),
  );
  const absentNamespaces = Object.keys(FIREFOX_UNMOUNTED_REASONS)
    .sort()
    .map((name) => ({ name, reason: FIREFOX_UNMOUNTED_REASONS[name] }));
  const missingMembers: FirefoxGapReport["missingMembers"] = [];
  for (const ns of mountedNamespaces) {
    const ff = FIREFOX_API[ns];
    if (!ff) continue;
    const have = Object.keys((mounted[ns] ?? {}) as Record<string, unknown>);
    const missing = Object.keys(ff)
      .filter((m) => !have.includes(m))
      .sort();
    if (missing.length > 0) missingMembers.push({ namespace: ns, members: missing });
  }

  for (const gap of missingMembers) {
    for (const member of gap.members) {
      if (!FIREFOX_MEMBER_GAP_REASONS[gap.namespace + "." + member])
        throw new Error("member gap lacks a reason: " + gap.namespace + "." + member);
    }
  }
  for (const key of Object.keys(FIREFOX_MEMBER_GAP_REASONS)) {
    const dot = key.indexOf(".");
    const ns = key.slice(0, dot);
    if (!mountedNamespaces.has(ns)) continue;
    const have = Object.keys((mounted[ns] ?? {}) as Record<string, unknown>);
    if (have.includes(key.slice(dot + 1)))
      throw new Error("stale member gap reason: " + key + " is mounted");
  }
  const engineExtras: FirefoxGapReport["engineExtras"] = [];
  for (const ns of Object.keys(ENGINE_EXTRA_MEMBERS).sort()) {
    for (const member of Object.keys(ENGINE_EXTRA_MEMBERS[ns]).sort()) {
      engineExtras.push({ namespace: ns, member, reason: ENGINE_EXTRA_MEMBERS[ns][member].reason });
    }
  }
  return { absentNamespaces, missingMembers, engineExtras };
}
