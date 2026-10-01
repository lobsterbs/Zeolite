/* Zeolite extension subsystem: runtime API surface.

   The centralized registry. buildApi() produces the browser.* object a
   given extension context sees, plus the chrome.* alias (Firefox
   exposes compatible chrome.* names for the same underlying APIs).
   Not-yet-implemented namespaces are intentionally ABSENT so feature
   detection like "if (browser.tabs)" answers honestly instead of
   throwing or, worse, lying. Events that need the background runtime
   (onInstalled/onStartup) register listeners but do not fire until
   that phase lands. */

import type { ExtensionRecord, ExtensionId } from "./types";
import { extensionUrl } from "./origin";
import { TABS, tabView, changeView } from "./tabs";
import type { TabsEvent } from "./tabs";
import { SCRIPTING } from "./scripting";
import type { ScriptingInjection } from "./scripting";
import { WEBNAV } from "./webnavigation";
import type { NavigationCommitted, NavigationKind } from "./webnavigation";
import { WEBREQ } from "./webrequest";
import type { WrKind } from "./webrequest";
import { MENUS } from "./contextmenus";
import { DOWNLOADS } from "./downloads";
import { NOTIFY } from "./notifications";
import type {
  NotificationClickedListener,
  NotificationClosedListener,
  ButtonClickedListener,
} from "./notifications";
import { PERMS } from "./advanced-permissions";
import type { ApiPermissions, PermListener } from "./advanced-permissions";
import type { ExtensionStorageArea, StorageValue } from "./storage";
import type { ExtensionMessenger, MessageListener, ConnectListener, MessageSender } from "./messaging";
import { ALARMS } from "./alarms";
import type { Alarm, AlarmCreateInfo } from "./alarms";
import { MGMT, infoOf } from "./management";
import type { MgmtListener } from "./management";
import type { ExtensionManager } from "./manager";
import { bootEnabled } from "./background";

export interface EventNamespace<L> {
  addListener(l: L): void;
  removeListener(l: L): void;
  hasListener(l: L): boolean;
}

export function makeEvent<L>(): EventNamespace<L> & { _listeners: Set<L> } {
  const listeners = new Set<L>();
  return {
    addListener: (l: L) => listeners.add(l),
    removeListener: (l: L) => listeners.delete(l),
    hasListener: (l: L) => listeners.has(l),
    _listeners: listeners,
  };
}

export interface ApiDeps {
  messenger: ExtensionMessenger;
  storage: { local: ExtensionStorageArea; sync: ExtensionStorageArea; session: ExtensionStorageArea };
  /** Manager owning the installed set; management.* reads live state
      from it. Without one, management.get/getAll see nothing and the
      mutating calls reject honestly. */
  manager?: ExtensionManager;
}

function wrapArea(area: ExtensionStorageArea): Record<string, unknown> {
  return {
    get: (keys?: string | string[] | Record<string, StorageValue> | null) => area.get(keys),
    set: (items: Record<string, unknown>) => area.set(items),
    remove: (keys: string | string[]) => area.remove(keys),
    clear: () => area.clear(),
    getBytesInUse: (keys?: string | string[]) => area.getBytesInUse(keys),
  };
}

/* ---- tabs / windows event plumbing -------------------------------- */

/** Args one extension's tab listener gets for a registry event, with
    url/title fields permission-gated per Firefox semantics. */
function tabsEventArgs(
  ext: ExtensionRecord,
  kind: "created" | "updated" | "activated" | "removed",
  ev: TabsEvent
): unknown[] | null {
  switch (ev.type) {
    case "created":
      return kind === "created" ? [tabView(ext, ev.tab)] : null;
    case "updated":
      return kind === "updated" ? [ev.tabId, changeView(ext, ev.change), tabView(ext, ev.tab)] : null;
    case "activated":
      return kind === "activated" ? [{ tabId: ev.tabId, windowId: ev.windowId }] : null;
    case "removed":
      return kind === "removed" ? [ev.tabId, { windowId: ev.windowId, isWindowClosing: false }] : null;
  }
}

function makeTabsEvent(
  ext: ExtensionRecord,
  kind: "created" | "updated" | "activated" | "removed"
): EventNamespace<(...args: unknown[]) => void> {
  const offs = new Map<unknown, () => void>();
  return {
    addListener: (l) => {
      if (offs.has(l)) return;
      offs.set(l, TABS.subscribe((ev) => {
        const args = tabsEventArgs(ext, kind, ev);
        if (!args) return;
        try {
          l(...args);
        } catch {
          /* a broken listener is the extension's own problem */
        }
      }));
    },
    removeListener: (l) => {
      offs.get(l)?.();
      offs.delete(l);
    },
    hasListener: (l) => offs.has(l),
  };
}

/* webNavigation events gated by the webNavigation permission, exactly
   as Firefox delivers them. Listener url filters use the webRequest
   pattern grammar ({ urls: [...] }); Firefox's richer filter object
   (urlMatches etc.) is not implemented (documented in ./compat). */
function makeWebNavEvent(
  ext: ExtensionRecord,
  kind: NavigationKind,
): {
  addListener: (l: (info: NavigationCommitted) => void, filter?: { urls?: unknown }) => void;
  removeListener: (l: (info: NavigationCommitted) => void) => void;
  hasListener: (l: (info: NavigationCommitted) => void) => boolean;
} {
  const offs = new Map<unknown, () => void>();
  return {
    addListener: (l, filter) => {
      if (offs.has(l)) return;
      const urls = (Array.isArray(filter?.urls) ? filter!.urls : []).map(String);
      offs.set(
        l,
        WEBNAV.subscribeKind(
          kind,
          (info) => {
            if (!ext.permissions.includes("webNavigation")) return;
            try {
              l(info);
            } catch {
              /* a broken listener is the extension's own problem */
            }
          },
          urls.length > 0 ? urls : undefined,
        ),
      );
    },
    removeListener: (l) => {
      offs.get(l)?.();
      offs.delete(l);
    },
    hasListener: (l) => offs.has(l),
  };
}

function makeMenusEvent(extId: ExtensionId): EventNamespace<(info: unknown, tab: unknown) => void> {
  const offs = new Map<unknown, () => void>();
  return {
    addListener: (l) => {
      if (offs.has(l)) return;
      offs.set(l, MENUS.onClicked(extId, (info, tab) => {
        try {
          l(info, tab);
        } catch {
          /* a broken listener is the extension's own problem */
        }
      }));
    },
    removeListener: (l) => {
      offs.get(l)?.();
      offs.delete(l);
    },
    hasListener: (l) => offs.has(l),
  };
}

/* #44: downloads.onChanged receives the registry state reports the
   host sends back through zl:downloadState. */
function makeDownloadsEvent(extId: ExtensionId): EventNamespace<(delta: unknown) => void> {
  const offs = new Map<unknown, () => void>();
  return {
    addListener: (l) => {
      if (offs.has(l)) return;
      offs.set(l, DOWNLOADS.onChanged(extId, (delta) => {
        try {
          l(delta);
        } catch {
          /* a broken listener is the extension's own problem */
        }
      }));
    },
    removeListener: (l) => {
      offs.get(l)?.();
      offs.delete(l);
    },
    hasListener: (l) => offs.has(l),
  };
}

export function buildApi(
  ext: ExtensionRecord,
  sender: MessageSender,
  deps: ApiDeps
): { browser: Record<string, unknown>; chrome: Record<string, unknown> } {
  /* Bridge the messaging event namespaces into the messenger so
     listeners registered by any context of this extension are
     reachable from every other context. */
  const offs = new Map<unknown, () => void>();
  function bridged<L>(reg: (l: L) => () => void): EventNamespace<L> {
    return {
      addListener: (l: L) => {
        if (offs.has(l)) return;
        offs.set(l, reg(l));
      },
      removeListener: (l: L) => {
        offs.get(l)?.();
        offs.delete(l);
      },
      hasListener: (l: L) => offs.has(l),
    };
  }
  const runtime = {
    id: ext.id,
    getManifest: (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(ext.manifest)) as Record<string, unknown>,
    getURL: (path: string): string => extensionUrl(ext.id, path),
    sendMessage: (msg: unknown): Promise<unknown> =>
      deps.messenger.sendMessage(ext.id, sender, msg),
    onMessage: bridged<MessageListener>((l) => deps.messenger.onMessage(ext.id, l)),
    connect: (name: string) => deps.messenger.connect(ext.id, name, sender),
    onConnect: bridged<ConnectListener>((l) => deps.messenger.onConnect(ext.id, l)),
    get lastError(): null {
      return null;
    },
    /* Register-only until the background runtime phase fires them. */
    onInstalled: makeEvent<(details: unknown) => void>(),
    onStartup: makeEvent<() => void>(),
  };
  const storageNs = {
    local: wrapArea(deps.storage.local),
    sync: wrapArea(deps.storage.sync),
    session: wrapArea(deps.storage.session),
  };
  /* tabs: the engine-side mirror of the UI tab model (see ./tabs).
     The tabs permission (or a matching host permission) gates url and
     title visibility exactly as Firefox does; getCurrent has no tab
     context here and rejects honestly. */
  const tabsNs = {
    get: (id: number) => {
      const t = TABS.get(id);
      return t ? Promise.resolve(tabView(ext, t)) : Promise.reject(new Error("Invalid tab ID: " + id));
    },
    getCurrent: () =>
      Promise.reject(new Error("zeolite: tabs.getCurrent may only be called from a tab context")),
    query: (q: Record<string, unknown> = {}) => {
      if (!ext.permissions.includes("tabs") && (q.url !== undefined || q.title !== undefined)) {
        return Promise.reject(
          new Error("zeolite: tabs.query url/title matching requires the 'tabs' permission"),
        );
      }
      return Promise.resolve(TABS.query(q).map((t) => tabView(ext, t)));
    },
    create: (props: Record<string, unknown> = {}) =>
      TABS.create(props as { url?: string; active?: boolean; index?: number }),
    update: (id: number | undefined, props: Record<string, unknown> = {}) =>
      TABS.update(id ?? null, props as { active?: boolean; url?: string }),
    remove: (ids: number | number[]) => TABS.remove(Array.isArray(ids) ? ids : [ids]),
    sendMessage: (tabId: number, msg: unknown, options?: { frameId?: number }) =>
      TABS.sendMessage(ext, tabId, msg, options),
    onCreated: makeTabsEvent(ext, "created"),
    onUpdated: makeTabsEvent(ext, "updated"),
    onActivated: makeTabsEvent(ext, "activated"),
    onRemoved: makeTabsEvent(ext, "removed"),
  };
  /* windows: this engine is a single window; focus never changes. */
  const win = (populate: boolean) => ({
    id: 1,
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    state: "normal",
    ...(populate ? { tabs: TABS.list().map((t) => tabView(ext, t)) } : {}),
  });
  const windowsNs = {
    WINDOW_ID_CURRENT: -1,
    WINDOW_ID_NONE: -1,
    get: (id: number, opts?: { populate?: boolean }) =>
      id === 1 || id === -1
        ? Promise.resolve(win(!!opts?.populate))
        : Promise.reject(new Error("Invalid window ID: " + id)),
    getCurrent: (opts?: { populate?: boolean }) => Promise.resolve(win(!!opts?.populate)),
    getLastFocused: (opts?: { populate?: boolean }) => Promise.resolve(win(!!opts?.populate)),
    getAll: (opts?: { populate?: boolean }) => Promise.resolve([win(!!opts?.populate)]),
    onFocusChanged: makeEvent<(windowId: number) => void>(),
  };
  /* scripting: files are read from the package here and pushed to
     the target page; the page listener executes them with the
     content-script API surface. Permissions enforced inside. */
  const scriptingNs = {
    executeScript: (inj: ScriptingInjection) => SCRIPTING.executeScript(ext, inj),
    insertCSS: (inj: ScriptingInjection) => SCRIPTING.insertCSS(ext, inj),
  };
  /* webNavigation: events derived from the real interception
     lifecycle. beforeNavigate fires at navigation interception,
     committed when the document response is known (cache hits
     included), completed at document stream end; onDOMContentLoaded
     arrives from the page-world bridge (no bridge, no event). */
  const webNavigationNs = {
    onBeforeNavigate: makeWebNavEvent(ext, "beforeNavigate"),
    onCommitted: makeWebNavEvent(ext, "committed"),
    onCompleted: makeWebNavEvent(ext, "completed"),
    onDOMContentLoaded: makeWebNavEvent(ext, "domcontentloaded"),
  };
  /* contextMenus + Firefox's menus alias over one registry. */
  const contextMenusNs = {
    create: (props: Record<string, unknown> = {}) => MENUS.create(ext, props),
    update: () => undefined,
    remove: (id: string | number) => MENUS.remove(ext.id, String(id)),
    removeAll: () => MENUS.removeAll(ext.id),
    onClicked: makeMenusEvent(ext.id),
  };
  /* #44: search/onChanged answer from the host-report registry
     (zl:downloadState), keyed by the zl:downloadOp handoff ids. An
     extension sees only its own handoffs; the registry is in-memory
     and dies with the worker. */
  const downloadsNs = {
    download: (opts: Record<string, unknown>) =>
      DOWNLOADS.download(ext, opts as unknown as { url: string; filename?: string; saveAs?: boolean }),
    search: (query: Record<string, unknown> = {}) =>
      Promise.resolve(DOWNLOADS.search(ext, query as { id?: number })),
    onChanged: makeDownloadsEvent(ext.id),
  };
  /* #43: notifications hand off to the host UI (zl:notifyOp) and
     events come back through zl:notifyEvent. Mounted only with the
     permission, so feature detection answers honestly. */
  const notificationsNs = ext.permissions.includes("notifications")
    ? (() => {
        return {
          create: (idOrOpts: unknown, maybeOpts?: unknown) =>
            maybeOpts === undefined
              ? NOTIFY.create(ext, null, idOrOpts as Record<string, unknown>)
              : NOTIFY.create(ext, idOrOpts as string, maybeOpts as Record<string, unknown>),
          update: (id: string, opts: Record<string, unknown>) => NOTIFY.update(ext, id, opts),
          clear: (id: string) => NOTIFY.clear(ext, id),
          getAll: () => NOTIFY.getAll(ext),
          onClicked: bridged<NotificationClickedListener>((l) => NOTIFY.onClicked(ext.id, l)),
          onClosed: bridged<NotificationClosedListener>((l) => NOTIFY.onClosed(ext.id, l)),
          onButtonClicked: bridged<ButtonClickedListener>((l) => NOTIFY.onButtonClicked(ext.id, l)),
        };
      })()
    : undefined;
  /* permissions: advanced permission lifecycle. The engine has
     no user prompt, so request() auto-grants anything the manifest
     declared optional; anything else is refused. */
  const permissionsNs = {
    contains: (perms: ApiPermissions = {}) => Promise.resolve(PERMS.contains(ext, perms)),
    getAll: () => Promise.resolve(PERMS.getAll(ext)),
    request: (perms: ApiPermissions = {}) => PERMS.request(ext, perms),
    remove: (perms: ApiPermissions = {}) => PERMS.remove(ext, perms),
    onAdded: bridged<PermListener>((l) => PERMS.subscribeAdded(l)),
    onRemoved: bridged<PermListener>((l) => PERMS.subscribeRemoved(l)),
  };
  /* webRequest: mounted only when the extension holds the
     permission, so feature detection ("if (browser.webRequest)")
     answers honestly. Header-modifying kinds additionally require
     webRequestBlocking; listener url filters are honored at delivery
     time by the registry. */
  const webRequestNs = ext.permissions.includes("webRequest")
    ? (() => {
        const reg = (kind: WrKind) => {
          const offs = new Map<unknown, () => void>();
          return {
            addListener: (l: unknown, filter?: { urls?: unknown }) => {
              if (
                (kind === "beforeSendHeaders" || kind === "headersReceived") &&
                !ext.permissions.includes("webRequestBlocking")
              ) {
                throw new Error("zeolite: " + kind + " requires the 'webRequestBlocking' permission");
              }
              if (offs.has(l)) return;
              offs.set(
                l,
                WEBREQ.register(ext.id, kind, l as never, {
                  hostPatterns: [...ext.hostPermissions],
                  canBlock: ext.permissions.includes("webRequestBlocking"),
                  urls: (Array.isArray(filter?.urls) ? filter!.urls : []).map(String),
                }),
              );
            },
            removeListener: (l: unknown) => {
              offs.get(l)?.();
              offs.delete(l);
            },
            hasListener: (l: unknown) => offs.has(l),
          };
        };
        return {
          onBeforeRequest: reg("beforeRequest"),
          onBeforeSendHeaders: reg("beforeSendHeaders"),
          onHeadersReceived: reg("headersReceived"),
          onCompleted: reg("completed"),
          onErrorOccurred: reg("errorOccurred"),
        };
      })()
    : undefined;

  /* alarms: in-memory timers in the shared worker context (see
     ./alarms); mounted only with the "alarms" permission so feature
     detection answers honestly. */
  const alarmsNs = ext.permissions.includes("alarms")
    ? (() => {
        const offs = new Map<unknown, () => void>();
        const create = (name: string, info?: AlarmCreateInfo) => ALARMS.create(ext.id, name, info ?? {});
        return {
          create: (a: string | AlarmCreateInfo, b?: AlarmCreateInfo) => {
            if (typeof a === "string") create(a, b);
            else create("", a);
          },
          get: (name: string) => Promise.resolve(ALARMS.get(ext.id, name)),
          getAll: () => Promise.resolve(ALARMS.getAll(ext.id)),
          clear: (name?: string) => Promise.resolve(ALARMS.clear(ext.id, name)),
          clearAll: () => Promise.resolve(ALARMS.clearAll(ext.id)),
          onAlarm: {
            addListener: (l: (a: Alarm) => void) => {
              if (offs.has(l)) return;
              offs.set(l, ALARMS.onAlarm(ext.id, l));
            },
            removeListener: (l: (a: Alarm) => void) => {
              offs.get(l)?.();
              offs.delete(l);
            },
            hasListener: (l: (a: Alarm) => void) => offs.has(l),
          },
        };
      })()
    : undefined;
  /* management: self surface without a permission; the full surface
     requires "management" (see ./management). Events fire for every
     extension's lifecycle transitions. */
  const mgr = deps.manager ?? null;
  const mgmtPerm = () => {
    if (!ext.permissions.includes("management")) {
      throw new Error(
        "zeolite: management.get/getAll/setEnabled/uninstall require the 'management' permission",
      );
    }
  };
  const managementNs = {
    getSelf: async () => infoOf(mgr?.get(ext.id) ?? ext),
    get: async (id: string) => {
      mgmtPerm();
      const rec = mgr?.get(id);
      return rec ? infoOf(rec) : Promise.reject(new Error("no such extension: " + id));
    },
    getAll: async () => {
      mgmtPerm();
      return (mgr?.list() ?? []).map((r) => infoOf(r));
    },
    setEnabled: async (id: string, enabled: boolean) => {
      mgmtPerm();
      await (mgr?.setEnabled(id, enabled) ?? Promise.resolve());
      await bootEnabled();
    },
    uninstall: async (id: string) => {
      mgmtPerm();
      if (!mgr) throw new Error("zeolite: no manager attached to this engine");
      await mgr.uninstall(id);
    },
    uninstallSelf: async () => {
      if (!mgr) throw new Error("zeolite: no manager attached to this engine");
      await mgr.uninstall(ext.id);
    },
    onInstalled: bridged<MgmtListener>((l) => MGMT.on("installed", l)),
    onUninstalled: bridged<MgmtListener>((l) => MGMT.on("uninstalled", l)),
    onEnabled: bridged<MgmtListener>((l) => MGMT.on("enabled", l)),
    onDisabled: bridged<MgmtListener>((l) => MGMT.on("disabled", l)),
  };

  const browser: Record<string, unknown> = {
    runtime,
    storage: storageNs,
    tabs: tabsNs,
    windows: windowsNs,
    scripting: scriptingNs,
    webNavigation: webNavigationNs,
    contextMenus: contextMenusNs,
    menus: contextMenusNs,
    downloads: downloadsNs,
    permissions: permissionsNs,
    management: managementNs,
    ...(webRequestNs ? { webRequest: webRequestNs } : {}),
    ...(alarmsNs ? { alarms: alarmsNs } : {}),
    ...(notificationsNs ? { notifications: notificationsNs } : {}),
  };
  /* Firefox-style chrome.* alias over the same implementations. */
  return { browser, chrome: browser };
}

