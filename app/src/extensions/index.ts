/* Zeolite extension subsystem: public surface (Phase 1).

   Consumers (LobsterBrowse, tests) import from here only â never the
   internals. The singleton manager owns lifecycle and persistence;
   compatibility is queryable through the matrix. */

export { extensions, ExtensionManager } from "./manager";
export type { InstallResult, LifecycleListener } from "./manager";
export { parseManifest } from "./manifest";
export type { ManifestDiagnostics, ParsedExtension } from "./manifest";
export { ExtensionManager as Manager } from "./manager";
export { COMPAT, compatReport } from "./compat";
export type { CompatEntry, CompatLevel } from "./compat";
export type { ExtensionRecord, ExtensionId, ExtensionState } from "./types";
export { buildApi } from "./runtime";
export type { ApiDeps } from "./runtime";
export { ExtensionMessenger } from "./messaging";
export { ExtensionStorageArea } from "./storage";
export { readZip, locateManifest } from "./package";
export { resolveContentScripts, contentScriptMatches, globToRegExp } from "./content-scripts";
export { EXT_SCHEME, parseExtensionUrl, extensionUrl, normalizeExtensionPath } from "./origin";
export { MESSENGER, getExtensionContext } from "./context";
export {
  bootEnabled,
  bootInstalled,
  bootExtension,
  wakeExtension,
  idleTerminate,
  backgroundIsServiceWorker,
} from "./background";
export {
  serveExtensionAsset,
  parseServePath,
  EXT_ROUTE,
  CS_ROUTE,
  mintPageToken,
  checkPageToken,
  registerPageClient,
  pageClientOf,
} from "./serve";
export type { ServeCtx, ServeReq } from "./serve";
export { PAGE_BRIDGE_SOURCE } from "./pagebridge";
export { handleExtPageCall, pageCallList, PAGE_APIS } from "./pageapi";
export type { ExtPageCall } from "./pageapi";
export { TABS, TabRegistry, tabView, changeView } from "./tabs";
export type { UiTab, TabsEvent, TabsOp, TabsListener, TabChangeInfo, TabMessage } from "./tabs";
export { SCRIPTING, ScriptingHost, LISTENER_SOURCE } from "./scripting";
export type { ScriptingInjection, ScriptingMessage } from "./scripting";
export { WEBNAV, NavigationRegistry } from "./webnavigation";
export type { NavigationCommitted, NavigationListener, NavigationInfo, NavigationKind } from "./webnavigation";
export { WEBREQ, WebRequestRegistry, wrType, headersToPairs, pairsToHeaders } from "./webrequest";
export type {
  WrKind,
  WrDetails,
  WrSendDetails,
  WrReceiveDetails,
  WrCompletedDetails,
  WrErrorDetails,
  WrHeaderPair,
  BeforeRequestListener,
  BeforeSendHeadersListener,
  HeadersReceivedListener,
  CompletedListener,
  ErrorOccurredListener,
} from "./webrequest";
export { ALARMS, AlarmRegistry } from "./alarms";
export type { Alarm, AlarmCreateInfo, AlarmListener } from "./alarms";
export { MGMT, ManagementEvents, infoOf } from "./management";
export type { ManagementInfo, MgmtListener } from "./management";
export { MENUS, ContextMenusHost } from "./contextmenus";
export type { MenuItem, MenuClickInfo, MenuClickedListener } from "./contextmenus";
export { DOWNLOADS, DownloadsHost } from "./downloads";
export type { DownloadOptions, DownloadOp, DownloadState, DownloadStatus, DownloadChange, DownloadsChangedListener } from "./downloads";
export { NOTIFY, NotificationsHost } from "./notifications";
export type {
  NotificationButton,
  NotificationRecord,
  NotifyOp,
  NotifyEventKind,
  NotificationClickedListener,
  NotificationClosedListener,
  ButtonClickedListener,
} from "./notifications";
export { cookiesGet, cookiesGetAll, cookiesSet, cookiesRemove } from "./cookies";
export { PERMS, PermissionRegistry } from "./advanced-permissions";
export type { ApiPermissions, PermListener, PermBackend } from "./advanced-permissions";

