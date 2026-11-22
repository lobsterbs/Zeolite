/* Zeolite extension subsystem: exhaustive Firefox API inventory
   (#516, slice 2).

   The seed inventory (./inventory.ts) made the engine's own mounted
   surface self-describing. This module adds the other side of the
   diff: the Firefox browser.* API surface itself, member by member,
   so the conformance tests can hold the mounted surface against
   Firefox instead of only against the compat matrix.

   Data: member-level namespace inventory transcribed from
   @types/firefox-webext-browser 143.0.1 (the community types
   generated from Firefox's own toolkit/browser components
   extensions/schemas JSON). Taxonomy matches buildInventory():
   method | event | constant. Argument schemas live in
   ./arg-schemas.ts (#516 slice 3) and per-member Firefox version
   annotations in ./firefox-versions.ts (#516 slice 4); shortcut:
   this file must be regenerated when Firefox's schema changes, the
   source package version is pinned in this header.

   Three conformance facts live here:
   - FIREFOX_UNMOUNTED_REASONS: every Firefox namespace the engine
     does NOT mount, with the honest reason. A namespace that gains
     an implementation must remove its reason (the conformance test
     enforces the 1:1 match), so the gap list cannot go stale.
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
  const engineExtras: FirefoxGapReport["engineExtras"] = [];
  for (const ns of Object.keys(ENGINE_EXTRA_MEMBERS).sort()) {
    for (const member of Object.keys(ENGINE_EXTRA_MEMBERS[ns]).sort()) {
      engineExtras.push({ namespace: ns, member, reason: ENGINE_EXTRA_MEMBERS[ns][member].reason });
    }
  }
  return { absentNamespaces, missingMembers, engineExtras };
}
