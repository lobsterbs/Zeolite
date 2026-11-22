<!-- GENERATED FILE - edit the generator (app/src/extensions/gaps-doc.ts), not this file. -->

# Firefox WebExtensions API gap report

Generated from the same machine-readable facts the conformance tests hold fresh: `firefoxGapReport()` over the real mounted surface ([firefox-inventory.ts](../app/src/extensions/firefox-inventory.ts), issue #516). The staleness test [gaps-doc.test.ts](../app/src/extensions/__tests__/gaps-doc.test.ts) renders this document and compares it against the committed file, so it cannot drift from the inventory.

Regenerate after any slice that changes the mounted surface or the gap tables:

```
ZL_UPDATE_GAPS_DOC=1 npx vitest run src/extensions/__tests__/gaps-doc.test.ts   # from app/
```

## Summary

- Mounted namespaces: **25** (222 members), the union of the action-family fixtures
- Firefox namespaces not mounted: **38**, each with its honest reason
- Mounted namespaces with member-level gaps: **17**
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
| `types` | schema type namespace (types.Setting); no runtime surface in Firefox either |
| `urlbar` | privileged namespace; no engine surface |
| `userScripts` | userScripts registration needs the isolated-world work (#517) |

## Member-level gaps inside mounted namespaces

| Namespace | Member | Reason |
| --- | --- | --- |
| `runtime` | `connectNative` | native-messaging hosts are host-OS processes; the sandboxed worker has no process bridge |
| `runtime` | `getBackgroundPage` | MV2 background pages have no DOM window in a service-worker engine |
| `runtime` | `getFrameId` | frame identity exists only for content-script contexts (#517); the background context owns no frame |
| `runtime` | `getPackageDirectoryEntry` | the legacy DirectoryEntry API is not available inside a service worker |
| `runtime` | `onBrowserUpdateAvailable` | deprecated alias of onUpdateAvailable; host update lifecycle is not observable in-engine |
| `runtime` | `onPerformanceWarning` | no performance-warning emitter exists for extension contexts |
| `runtime` | `onRestartRequired` | host restart lifecycle is not observable in-engine |
| `runtime` | `onSuspendCanceled` | no suspend-cancel event source exists in the engine |
| `runtime` | `onUserScriptConnect` | userScripts messaging needs the isolated-world work (#517) |
| `runtime` | `onUserScriptMessage` | userScripts messaging needs the isolated-world work (#517) |
| `runtime` | `restart` | restarting the host browser is outside an embedded engine's authority |
| `runtime` | `sendNativeMessage` | native-messaging hosts are host-OS processes; the sandboxed worker has no process bridge |
| `i18n` | `detectLanguage` | no language-detection model ships with the engine; a guess would fake the detection |
| `tabs` | `captureTab` | the engine never rasterizes pages; no rendering surface exists |
| `tabs` | `captureVisibleTab` | the engine never rasterizes pages; no rendering surface exists |
| `tabs` | `connect` | per-tab channel messaging needs content-script contexts (#517) |
| `tabs` | `detectLanguage` | no language-detection model ships with the engine; a guess would fake the detection |
| `tabs` | `discard` | tab lifecycle (memory pressure, discard) belongs to the host UI; the tab registry is synchronized, not driven |
| `tabs` | `executeScript` | tab-legacy injection routes through the scripting engine; not mounted yet (#519 lane) |
| `tabs` | `getZoom` | zoom is host-UI state; the virtualized page has no zoom surface |
| `tabs` | `getZoomSettings` | zoom is host-UI state; the virtualized page has no zoom surface |
| `tabs` | `goBack` | session-history control is a host-UI verb; the tab bridge carries no history verb |
| `tabs` | `goForward` | session-history control is a host-UI verb; the tab bridge carries no history verb |
| `tabs` | `group` | the UI tab model has no group concept |
| `tabs` | `hide` | tab visibility is host-UI state; the tab bridge carries no visibility verb |
| `tabs` | `insertCSS` | tab-legacy style injection routes through the scripting engine; not mounted yet (#519 lane) |
| `tabs` | `move` | tab placement belongs to the host UI; the bridge has no move verb |
| `tabs` | `moveInSuccession` | tab placement belongs to the host UI; the bridge has no move verb |
| `tabs` | `onAttached` | window/tab attachment events need host-UI reporting; the bridge does not report them |
| `tabs` | `onDetached` | window/tab attachment events need host-UI reporting; the bridge does not report them |
| `tabs` | `onHighlighted` | the UI tab model has no selection surface to highlight |
| `tabs` | `onMoved` | the tab bridge does not report movement |
| `tabs` | `onReplaced` | prerender swaps do not exist; the tab model is UI-owned |
| `tabs` | `onZoomChange` | zoom is host-UI state; the virtualized page has no zoom surface |
| `tabs` | `print` | no rendering surface exists to print a proxied page |
| `tabs` | `printPreview` | no rendering surface exists to print a proxied page |
| `tabs` | `reload` | reload is a host-UI verb; the tab bridge carries no reload verb |
| `tabs` | `removeCSS` | injected styles carry no removal token; rides the scripting CSS work (#519) |
| `tabs` | `saveAsPDF` | no rendering surface exists to rasterize a proxied page to PDF |
| `tabs` | `setZoom` | zoom is host-UI state; the virtualized page has no zoom surface |
| `tabs` | `setZoomSettings` | zoom is host-UI state; the virtualized page has no zoom surface |
| `tabs` | `show` | tab visibility is host-UI state; the tab bridge carries no visibility verb |
| `tabs` | `toggleReaderMode` | reader mode is a Firefox UI feature with no engine or host equivalent |
| `tabs` | `ungroup` | the UI tab model has no group concept |
| `tabs` | `warmup` | preloading is a host tab-scheduler hint with no engine equivalent |
| `windows` | `create` | window lifecycle verbs belong to the host UI; the engine window view is synchronized, not driven |
| `windows` | `onCreated` | window lifecycle events need host-UI reporting; the bridge does not report them |
| `windows` | `onRemoved` | window lifecycle events need host-UI reporting; the bridge does not report them |
| `windows` | `remove` | window lifecycle verbs belong to the host UI; the engine window view is synchronized, not driven |
| `windows` | `update` | window lifecycle verbs belong to the host UI; the engine window view is synchronized, not driven |
| `scripting` | `getRegisteredContentScripts` | persistent content-script registration targets the content-script world (#517) |
| `scripting` | `registerContentScripts` | persistent content-script registration targets the content-script world (#517) |
| `scripting` | `removeCSS` | injected styles carry no removal token; rides the scripting CSS work (#519) |
| `scripting` | `unregisterContentScripts` | persistent content-script registration targets the content-script world (#517) |
| `scripting` | `updateContentScripts` | persistent content-script registration targets the content-script world (#517) |
| `webNavigation` | `getAllFrames` | no frame-tree query surface exists; navigation events carry what the bridge reports |
| `webNavigation` | `getFrame` | no frame-tree query surface exists; navigation events carry what the bridge reports |
| `webNavigation` | `onCreatedNavigationTarget` | target-attribute navigations are not reported by the navigation bridge |
| `webNavigation` | `onErrorOccurred` | navigation errors are engine-internal; the bridge reports stages only |
| `webNavigation` | `onHistoryStateUpdated` | same-document session-history updates happen in the page realm; the worker cannot see them |
| `webNavigation` | `onReferenceFragmentUpdated` | hash-only navigation happens in the page realm; the worker cannot see it |
| `webNavigation` | `onTabReplaced` | instant/prerender swaps do not exist; the tab model is UI-owned |
| `contextMenus` | `ACTION_MENU_TOP_LEVEL_LIMIT` | the top-level action limit bounds a menu host surface the engine does not have (#519) |
| `contextMenus` | `getTargetElement` | menu targets live in the page realm; unreachable without content-script worlds (#517) |
| `contextMenus` | `onHidden` | menu visibility is host-UI state; no menu host reports it |
| `contextMenus` | `onShown` | menu visibility is host-UI state; no menu host reports it |
| `contextMenus` | `overrideContext` | privileged Firefox UI override; no menu host exists |
| `contextMenus` | `refresh` | no host menu surface to refresh |
| `menus` | `ACTION_MENU_TOP_LEVEL_LIMIT` | the top-level action limit bounds a menu host surface the engine does not have (#519) |
| `menus` | `getTargetElement` | menu targets live in the page realm; unreachable without content-script worlds (#517) |
| `menus` | `onHidden` | menu visibility is host-UI state; no menu host reports it |
| `menus` | `onShown` | menu visibility is host-UI state; no menu host reports it |
| `menus` | `overrideContext` | privileged Firefox UI override; no menu host exists |
| `menus` | `refresh` | no host menu surface to refresh |
| `downloads` | `acceptDanger` | no OS download manager or danger-prompt surface exists |
| `downloads` | `cancel` | the engine hands downloads to the host; it holds no live transfer to cancel |
| `downloads` | `drag` | drag-on-demand is a host-UI gesture with no download surface |
| `downloads` | `erase` | the download record store exposes no erase surface |
| `downloads` | `getFileIcon` | no OS file-icon surface exists |
| `downloads` | `onCreated` | download lifecycle events beyond onChanged are not surfaced from the store (#522) |
| `downloads` | `onErased` | no erase verb exists, so an erased event has no source (#522) |
| `downloads` | `open` | no OS opener surface inside the engine |
| `downloads` | `pause` | the engine hands downloads to the host; it holds no live transfer to pause |
| `downloads` | `removeFile` | no OS file-system surface exists |
| `downloads` | `resume` | the engine hands downloads to the host; it holds no live transfer to resume |
| `downloads` | `setShelfEnabled` | no download shelf exists in the engine or host |
| `downloads` | `show` | no OS download-folder surface exists |
| `downloads` | `showDefaultFolder` | no OS download-folder surface exists |
| `management` | `install` | no fetch-and-prompt install host; packages install through the engine's own manager |
| `webRequest` | `filterResponseData` | response streams belong to the rewriter pipeline; per-listener body filters have no engine surface |
| `webRequest` | `getSecurityInfo` | transport security details stay inside the transport layer; no security-info surface reaches extensions |
| `webRequest` | `onAuthRequired` | auth challenges terminate inside the transport; no auth-prompt surface exists |
| `action` | `getUserSettings` | toolbar placement and user toggles are host-UI state the engine cannot see |
| `action` | `openPopup` | opening the action popup is a host-UI gesture; no popup host verb exists |
| `notifications` | `onPermissionLevelChanged` | the permission level is install-granted and immutable in this engine, so it can never honestly fire |
| `notifications` | `onShowSettings` | no OS notification-settings surface exists |
| `notifications` | `onShown` | the notification host reports click and close only; no shown event exists |
| `history` | `onTitleChanged` | titles never reach the worker; the visit store records URLs only |
| `extension` | `setUpdateUrlData` | update-URL state belongs to a host updater; the engine ships no updater |
| `browserAction` | `getUserSettings` | toolbar placement and user toggles are host-UI state the engine cannot see |
| `browserAction` | `onUserSettingsChanged` | user action settings are host-UI state with no change reporting |
| `browserAction` | `openPopup` | opening the action popup is a host-UI gesture; no popup host verb exists |
| `pageAction` | `openPopup` | opening the action popup is a host-UI gesture; no popup host verb exists |

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
| `browsingData` | `remove` (method), `removeAppcache` (method), `removeCache` (method), `removeCookies` (method), `removeDownloads` (method), `removeFileSystems` (method), `removeFormData` (method), `removeHistory` (method), `removeIndexedDB` (method), `removeLocalStorage` (method), `removePasswords` (method), `removePluginData` (method), `removeServiceWorkers` (method), `removeWebSQL` (method), `settings` (method) |
| `contextMenus` | `create` (method), `onClicked` (event), `remove` (method), `removeAll` (method), `update` (method) |
| `cookies` | `get` (method), `getAll` (method), `getAllCookieStores` (method), `onChanged` (event), `remove` (method), `set` (method) |
| `declarativeNetRequest` | `DYNAMIC_RULESET_ID` (constant), `GUARANTEED_MINIMUM_STATIC_RULES` (constant), `MAX_NUMBER_OF_DISABLED_STATIC_RULES` (constant), `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` (constant), `MAX_NUMBER_OF_DYNAMIC_RULES` (constant), `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` (constant), `MAX_NUMBER_OF_REGEX_RULES` (constant), `MAX_NUMBER_OF_SESSION_RULES` (constant), `MAX_NUMBER_OF_STATIC_RULESETS` (constant), `SESSION_RULESET_ID` (constant), `getAvailableStaticRuleCount` (method), `getDisabledRuleIds` (method), `getDynamicRules` (method), `getEnabledRulesets` (method), `getSessionRules` (method), `isRegexSupported` (method), `testMatchOutcome` (method), `updateDynamicRules` (method), `updateEnabledRulesets` (method), `updateSessionRules` (method), `updateStaticRules` (method) |
| `downloads` | `download` (method), `onChanged` (event), `search` (method) |
| `extension` | `getBackgroundPage` (method), `getURL` (method), `getViews` (method), `inIncognitoContext` (constant), `isAllowedFileSchemeAccess` (method), `isAllowedIncognitoAccess` (method), `lastError` (constant) |
| `history` | `addUrl` (method), `deleteAll` (method), `deleteRange` (method), `deleteUrl` (method), `getVisits` (method), `onVisitRemoved` (event), `onVisited` (event), `search` (method) |
| `i18n` | `getAcceptLanguages` (method), `getMessage` (method), `getPreferredSystemLanguages` (method), `getUILanguage` (method) |
| `management` | `get` (method), `getAll` (method), `getSelf` (method), `onDisabled` (event), `onEnabled` (event), `onInstalled` (event), `onUninstalled` (event), `setEnabled` (method), `uninstall` (method), `uninstallSelf` (method) |
| `menus` | `create` (method), `onClicked` (event), `remove` (method), `removeAll` (method), `update` (method) |
| `notifications` | `clear` (method), `create` (method), `getAll` (method), `getPermissionLevel` (method), `onButtonClicked` (event), `onClicked` (event), `onClosed` (event), `update` (method) |
| `pageAction` | `getPopup` (method), `getTitle` (method), `hide` (method), `isShown` (method), `onClicked` (event), `setIcon` (method), `setPopup` (method), `setTitle` (method), `show` (method) |
| `permissions` | `contains` (method), `getAll` (method), `onAdded` (event), `onRemoved` (event), `remove` (method), `request` (method) |
| `runtime` | `connect` (method), `getBrowserInfo` (method), `getContexts` (method), `getManifest` (method), `getPlatformInfo` (method), `getURL` (method), `id` (constant), `lastError` (constant), `onConnect` (event), `onConnectExternal` (event), `onInstalled` (event), `onMessage` (event), `onMessageExternal` (event), `onStartup` (event), `onSuspend` (event), `onUpdateAvailable` (event), `openOptionsPage` (method), `reload` (method), `requestUpdateCheck` (method), `sendMessage` (method), `setUninstallURL` (method) |
| `scripting` | `executeScript` (method), `insertCSS` (method) |
| `storage` | `local` (constant), `managed` (constant), `onChanged` (event), `session` (constant), `sync` (constant) |
| `tabs` | `TAB_ID_NONE` (constant), `create` (method), `duplicate` (method), `get` (method), `getCurrent` (method), `highlight` (method), `onActivated` (event), `onCreated` (event), `onRemoved` (event), `onUpdated` (event), `query` (method), `remove` (method), `sendMessage` (method), `update` (method) |
| `topSites` | `get` (method) |
| `webNavigation` | `onBeforeNavigate` (event), `onCommitted` (event), `onCompleted` (event), `onDOMContentLoaded` (event) |
| `webRequest` | `MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES` (constant), `handlerBehaviorChanged` (method), `onBeforeRedirect` (event), `onBeforeRequest` (event), `onBeforeSendHeaders` (event), `onCompleted` (event), `onErrorOccurred` (event), `onHeadersReceived` (event), `onResponseStarted` (event), `onSendHeaders` (event) |
| `windows` | `WINDOW_ID_CURRENT` (constant), `WINDOW_ID_NONE` (constant), `get` (method), `getAll` (method), `getCurrent` (method), `getLastFocused` (method), `onFocusChanged` (event) |
