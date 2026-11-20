<!-- GENERATED FILE - edit the generator (app/src/extensions/gaps-doc.ts), not this file. -->

# Firefox WebExtensions API gap report

Generated from the same machine-readable facts the conformance tests hold fresh: `firefoxGapReport()` over the real mounted surface ([firefox-inventory.ts](../app/src/extensions/firefox-inventory.ts), issue #516). The staleness test [gaps-doc.test.ts](../app/src/extensions/__tests__/gaps-doc.test.ts) renders this document and compares it against the committed file, so it cannot drift from the inventory.

Regenerate after any slice that changes the mounted surface or the gap tables:

```
ZL_UPDATE_GAPS_DOC=1 npx vitest run src/extensions/__tests__/gaps-doc.test.ts   # from app/
```

## Summary

- Mounted namespaces: **23** (203 members), the union of the action-family fixtures
- Firefox namespaces not mounted: **40**, each with its honest reason
- Mounted namespaces with member-level gaps: **18**
- Engine extras (mounted members Firefox does not have): **4**, each justified in COMPAT

The wave issues #517-#524 diff against this baseline; a namespace that gains an implementation removes its reason from `FIREFOX_UNMOUNTED_REASONS` and this document regenerates with it gone.

## Firefox namespaces the engine does not mount

| Namespace | Reason |
| --- | --- |
| `activityLog` | privileged namespace (System-privileged add-ons only); no engine surface |
| `browserSettings` | host settings (homepage, new-tab override, cache) have no engine surface (#521) |
| `browserSettings.colorManagement` | no host color-management surface (#521) |
| `captivePortal` | no captive-portal detection exists in the engine (#522) |
| `clipboard` | setImageData needs a page-realm clipboard host surface (#523) |
| `commands` | manifest commands are parsed and recorded (#519) but no keyboard surface exists to fire onCommand or to report shortcuts |
| `contentScripts` | programmatic content-script registration needs the isolated-world work (#517) |
| `contextualIdentities` | no Firefox container model; jar profiles are engine-internal, not a contextualIdentities surface (#522) |
| `devtools` | the devtools surface is served through the devtools page bridge (#523), not on browser.* |
| `devtools.inspectedWindow` | served through the devtools page bridge (#523), not on browser.* |
| `devtools.network` | served through the devtools page bridge (#523), not on browser.* |
| `devtools.panels` | served through the devtools page bridge (#523), not on browser.* |
| `dns` | the service worker cannot resolve names; DNS lives server-side (#521) |
| `events` | schema type namespace (events.Event); no runtime surface in Firefox either |
| `experiments` | schema namespace for experiment APIs; no runtime surface |
| `extensionTypes` | schema enum types (RunAt, CSSOrigin); no runtime object in Firefox either |
| `find` | the engine finder is a page feature, not an extension API surface (#520/#523) |
| `geckoProfiler` | privileged namespace; no engine surface |
| `history` | no history store exists in the engine; browsingData.removeHistory rejects for the same reason (#520) |
| `identity` | no OAuth redirect host surface (#522) |
| `idle` | no OS idle source; reporting 'active' unconditionally would fake a signal, so the namespace stays unmounted (#522: 'where platform capability exists') |
| `networkStatus` | no host network-status source (#521/#522) |
| `normandyAddonStudy` | privileged namespace (Firefox study machinery); no engine surface |
| `omnibox` | no address-bar surface (#519) |
| `pkcs11` | no PKCS#11 module integration (#522) |
| `privacy` | host privacy settings have no engine surface (#521) |
| `privacy.network` | host privacy settings have no engine surface (#521) |
| `privacy.services` | host privacy settings have no engine surface (#521) |
| `privacy.websites` | host privacy settings have no engine surface (#521) |
| `proxy` | proxy configuration is engine config (KDL), not an extension API (#521) |
| `search` | no search-engine integration (#522) |
| `sessions` | no closed-tab/window history; the UI tab model does not report closures to the engine (#519) |
| `sidebarAction` | parsed from manifests; no sidebar host (#519) |
| `tabGroups` | the UI tab model has no group concept (#519) |
| `telemetry` | privileged namespace; no engine surface |
| `theme` | theme manifest keys are parsed and recorded (#524); no host theme engine consumes them |
| `topSites` | no history store to rank (#520) |
| `types` | schema type namespace (types.Setting); no runtime surface in Firefox either |
| `urlbar` | privileged namespace; no engine surface |
| `userScripts` | userScripts registration needs the isolated-world work (#517) |

## Member-level gaps inside mounted namespaces

| Namespace | Firefox members not mounted |
| --- | --- |
| `runtime` | connectNative, getBackgroundPage, getFrameId, getPackageDirectoryEntry, onBrowserUpdateAvailable, onPerformanceWarning, onRestartRequired, onSuspendCanceled, onUserScriptConnect, onUserScriptMessage, restart, sendNativeMessage |
| `i18n` | detectLanguage, getPreferredSystemLanguages |
| `tabs` | captureTab, captureVisibleTab, connect, detectLanguage, discard, executeScript, getZoom, getZoomSettings, goBack, goForward, group, hide, insertCSS, move, moveInSuccession, onAttached, onDetached, onHighlighted, onMoved, onReplaced, onZoomChange, print, printPreview, reload, removeCSS, saveAsPDF, setZoom, setZoomSettings, show, toggleReaderMode, ungroup, warmup |
| `windows` | create, onCreated, onRemoved, remove, update |
| `scripting` | getRegisteredContentScripts, registerContentScripts, removeCSS, unregisterContentScripts, updateContentScripts |
| `webNavigation` | getAllFrames, getFrame, onCreatedNavigationTarget, onErrorOccurred, onHistoryStateUpdated, onReferenceFragmentUpdated, onTabReplaced |
| `contextMenus` | ACTION_MENU_TOP_LEVEL_LIMIT, getTargetElement, onHidden, onShown, overrideContext, refresh |
| `menus` | ACTION_MENU_TOP_LEVEL_LIMIT, getTargetElement, onHidden, onShown, overrideContext, refresh |
| `downloads` | acceptDanger, cancel, drag, erase, getFileIcon, onCreated, onErased, open, pause, removeFile, resume, setShelfEnabled, show, showDefaultFolder |
| `management` | install |
| `webRequest` | filterResponseData, getSecurityInfo, onAuthRequired |
| `action` | getUserSettings, openPopup |
| `notifications` | getPermissionLevel, onPermissionLevelChanged, onShowSettings, onShown |
| `cookies` | getAllCookieStores |
| `browsingData` | remove, removeAppcache, removeFileSystems, removeWebSQL |
| `extension` | isAllowedFileSchemeAccess, isAllowedIncognitoAccess, lastError, setUpdateUrlData |
| `browserAction` | getUserSettings, onUserSettingsChanged, openPopup |
| `pageAction` | openPopup |

## Engine extras (mounted members Firefox does not have)

| Member | Reason |
| --- | --- |
| `browsingData.removeServiceWorkers` | Chrome parity: Firefox has no browsingData.removeServiceWorkers; the engine really clears its guest service-worker realms |
| `declarativeNetRequest.getMatchedRules` | Chrome's DNR feedback surface, mounted only with the declarativeNetRequestFeedback permission; Firefox has no DNR debug surface |
| `declarativeNetRequest.onRuleMatchedDebug` | Chrome's DNR feedback event, gated and bounded exactly like getMatchedRules; Firefox has no DNR debug surface |
| `management.uninstall` | Chrome parity: Firefox never implemented management.uninstall (MDN marks it unsupported there); the engine uninstalls behind the 'management' permission |

## Mounted surface

| Namespace | Members |
| --- | --- |
| `action` | `disable` (method), `enable` (method), `getBadgeBackgroundColor` (method), `getBadgeText` (method), `getBadgeTextColor` (method), `getPopup` (method), `getTitle` (method), `isEnabled` (method), `onClicked` (event), `setBadgeBackgroundColor` (method), `setBadgeText` (method), `setBadgeTextColor` (method), `setIcon` (method), `setPopup` (method), `setTitle` (method) |
| `alarms` | `clear` (method), `clearAll` (method), `create` (method), `get` (method), `getAll` (method), `onAlarm` (event) |
| `bookmarks` | `create` (method), `get` (method), `getChildren` (method), `getRecent` (method), `getSubTree` (method), `getTree` (method), `move` (method), `onChanged` (event), `onCreated` (event), `onMoved` (event), `onRemoved` (event), `remove` (method), `removeTree` (method), `search` (method), `update` (method) |
| `browserAction` | `disable` (method), `enable` (method), `getBadgeBackgroundColor` (method), `getBadgeText` (method), `getBadgeTextColor` (method), `getPopup` (method), `getTitle` (method), `isEnabled` (method), `onClicked` (event), `setBadgeBackgroundColor` (method), `setBadgeText` (method), `setBadgeTextColor` (method), `setIcon` (method), `setPopup` (method), `setTitle` (method) |
| `browsingData` | `removeCache` (method), `removeCookies` (method), `removeDownloads` (method), `removeFormData` (method), `removeHistory` (method), `removeIndexedDB` (method), `removeLocalStorage` (method), `removePasswords` (method), `removePluginData` (method), `removeServiceWorkers` (method), `settings` (method) |
| `contextMenus` | `create` (method), `onClicked` (event), `remove` (method), `removeAll` (method), `update` (method) |
| `cookies` | `get` (method), `getAll` (method), `onChanged` (event), `remove` (method), `set` (method) |
| `declarativeNetRequest` | `DYNAMIC_RULESET_ID` (constant), `GUARANTEED_MINIMUM_STATIC_RULES` (constant), `MAX_NUMBER_OF_DISABLED_STATIC_RULES` (constant), `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` (constant), `MAX_NUMBER_OF_DYNAMIC_RULES` (constant), `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` (constant), `MAX_NUMBER_OF_REGEX_RULES` (constant), `MAX_NUMBER_OF_SESSION_RULES` (constant), `MAX_NUMBER_OF_STATIC_RULESETS` (constant), `SESSION_RULESET_ID` (constant), `getAvailableStaticRuleCount` (method), `getDisabledRuleIds` (method), `getDynamicRules` (method), `getEnabledRulesets` (method), `getSessionRules` (method), `isRegexSupported` (method), `testMatchOutcome` (method), `updateDynamicRules` (method), `updateEnabledRulesets` (method), `updateSessionRules` (method), `updateStaticRules` (method) |
| `downloads` | `download` (method), `onChanged` (event), `search` (method) |
| `extension` | `getBackgroundPage` (method), `getURL` (method), `getViews` (method), `inIncognitoContext` (constant) |
| `i18n` | `getAcceptLanguages` (method), `getMessage` (method), `getUILanguage` (method) |
| `management` | `get` (method), `getAll` (method), `getSelf` (method), `onDisabled` (event), `onEnabled` (event), `onInstalled` (event), `onUninstalled` (event), `setEnabled` (method), `uninstall` (method), `uninstallSelf` (method) |
| `menus` | `create` (method), `onClicked` (event), `remove` (method), `removeAll` (method), `update` (method) |
| `notifications` | `clear` (method), `create` (method), `getAll` (method), `onButtonClicked` (event), `onClicked` (event), `onClosed` (event), `update` (method) |
| `pageAction` | `getPopup` (method), `getTitle` (method), `hide` (method), `isShown` (method), `onClicked` (event), `setIcon` (method), `setPopup` (method), `setTitle` (method), `show` (method) |
| `permissions` | `contains` (method), `getAll` (method), `onAdded` (event), `onRemoved` (event), `remove` (method), `request` (method) |
| `runtime` | `connect` (method), `getBrowserInfo` (method), `getContexts` (method), `getManifest` (method), `getPlatformInfo` (method), `getURL` (method), `id` (constant), `lastError` (constant), `onConnect` (event), `onConnectExternal` (event), `onInstalled` (event), `onMessage` (event), `onMessageExternal` (event), `onStartup` (event), `onUpdateAvailable` (event), `onSuspend` (event), `openOptionsPage` (method), `reload` (method), `requestUpdateCheck` (method), `sendMessage` (method), `setUninstallURL` (method) |
| `scripting` | `executeScript` (method), `insertCSS` (method) |
| `storage` | `local` (constant), `managed` (constant), `onChanged` (event), `session` (constant), `sync` (constant) |
| `tabs` | `TAB_ID_NONE` (constant), `create` (method), `duplicate` (method), `get` (method), `getCurrent` (method), `highlight` (method), `onActivated` (event), `onCreated` (event), `onRemoved` (event), `onUpdated` (event), `query` (method), `remove` (method), `sendMessage` (method), `update` (method) |
| `webNavigation` | `onBeforeNavigate` (event), `onCommitted` (event), `onCompleted` (event), `onDOMContentLoaded` (event) |
| `webRequest` | `MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES` (constant), `handlerBehaviorChanged` (method), `onBeforeRedirect` (event), `onBeforeRequest` (event), `onBeforeSendHeaders` (event), `onCompleted` (event), `onErrorOccurred` (event), `onHeadersReceived` (event), `onResponseStarted` (event), `onSendHeaders` (event) |
| `windows` | `WINDOW_ID_CURRENT` (constant), `WINDOW_ID_NONE` (constant), `get` (method), `getAll` (method), `getCurrent` (method), `getLastFocused` (method), `onFocusChanged` (event) |
