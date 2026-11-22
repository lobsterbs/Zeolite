/* Zeolite extension subsystem: runtime API surface.

   The centralized registry. buildApi() produces the browser.* object a
   given extension context sees, plus a callback-compatible chrome.*
   surface over the same permission-gated implementations.
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
import { WEBNAV, navigationFilterPredicate } from "./webnavigation";
import type { NavigationCommitted, NavigationKind, NavigationUrlFilter } from "./webnavigation";
import { WEBREQ } from "./webrequest";
import type { WrKind } from "./webrequest";
import { MENUS } from "./contextmenus";
import { ACTION } from "./action";
import type { ActionKind, ActionClickedListener } from "./action";
import { DOWNLOADS } from "./downloads";
import { NOTIFY } from "./notifications";
import type {
  NotificationClickedListener,
  NotificationClosedListener,
  ButtonClickedListener,
} from "./notifications";
import { cookiesGet, cookiesGetAll, cookiesSet, cookiesRemove, onCookieChanged } from "./cookies";
import type { CookieChangeListener } from "./cookies";
import { hostPatternsMatch } from "./permissions";
import { isApiDetached } from "./apis";
import { installArgValidation } from "./arg-schemas";
import { PERMS } from "./advanced-permissions";
import type { ApiPermissions, PermListener } from "./advanced-permissions";
import { makeManagedArea, setSessionAccessLevel, SYNC_MAX_ITEMS, SYNC_MAX_WRITE_OPERATIONS_PER_HOUR, SYNC_MAX_WRITE_OPERATIONS_PER_MINUTE, SYNC_QUOTA_BYTES, SYNC_QUOTA_BYTES_PER_ITEM } from "./storage";
import { setUninstallUrlOf } from "./uninstall-url";
import type { ExtensionStorageArea, StorageValue } from "./storage";
import type { ExtensionMessenger, MessageListener, ConnectListener, MessageSender, ExtensionPort } from "./messaging";
import { ALARMS } from "./alarms";
import type { Alarm, AlarmCreateInfo } from "./alarms";
import { BOOKMARKS } from "./bookmarks";
import type {
  BookmarkChangedListener,
  BookmarkCreateDetails,
  BookmarkCreatedListener,
  BookmarkMoveDestination,
  BookmarkMovedListener,
  BookmarkRemovedListener,
  BookmarkSearchQuery,
  BookmarkUpdateChanges,
} from "./bookmarks";
import {
  DNR,
  DYNAMIC_RULESET_ID,
  GUARANTEED_MINIMUM_STATIC_RULES,
  MAX_NUMBER_OF_DISABLED_STATIC_RULES,
  MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES,
  MAX_NUMBER_OF_DYNAMIC_RULES,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
  MAX_NUMBER_OF_REGEX_RULES,
  MAX_NUMBER_OF_SESSION_RULES,
  MAX_NUMBER_OF_STATIC_RULESETS,
  SESSION_RULESET_ID,
  type DnrMatchedRule,
} from "./dnr";
import { MGMT, infoOf } from "./management";
import type { MgmtListener } from "./management";
import type { ExtensionManager } from "./manager";
import { bootEnabled, bootExtension, idleTerminate, backgroundIsServiceWorker, registerSuspendEvent } from "./background";
import { browsingDataRemoveCache, browsingDataRemoveCookies, browsingDataRemoveDownloads, browsingDataRemoveIndexedDB, browsingDataRemoveServiceWorkers, browsingDataSettings, browsingDataUnreachable, type BrowsingDataOptions } from "./browsingdata";
import { chromeApi } from "./chrome";
import { extPageOpenUrl, pageClientsOf } from "./serve";
import { makeI18nNs, substituteManifestStrings } from "./i18n";
import type { I18nResolved } from "./i18n";

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
  /** #560: the package _locales resolved once per context;
      getMessage answers "" like Chrome answers a missing name. */
  i18n?: I18nResolved;
  manager?: ExtensionManager;
}

/* #560: Chrome Port shape over the raw ExtensionPort. Chrome
   delivers connected ports with onMessage/onDisconnect as event
   objects (addListener/removeListener/hasListener); the raw
   ExtensionPort exposes them as subscribe methods, which TM-class
   extension code cannot drive. */
function chromePortShape(p: ExtensionPort): {
  name: string;
  sender: MessageSender;
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(l: (m: unknown) => void): void; removeListener(l: (m: unknown) => void): void; hasListener(l: (m: unknown) => void): boolean };
  onDisconnect: { addListener(l: () => void): void; removeListener(l: () => void): void; hasListener(l: () => void): boolean };
} {
  const msg: ((m: unknown) => void)[] = [];
  const disc: (() => void)[] = [];
  p.onMessage((m) => {
    for (const l of msg) l(m);
  });
  p.onDisconnect(() => {
    for (const l of disc) l();
  });
  return {
    name: p.name,
    sender: p.sender,
    postMessage: (m: unknown) => p.postMessage(m),
    disconnect: () => p.disconnect(),
    onMessage: {
      addListener: (l) => msg.push(l),
      removeListener: (l) => {
        const i = msg.indexOf(l);
        if (i >= 0) msg.splice(i, 1);
      },
      hasListener: (l) => msg.includes(l),
    },
    onDisconnect: {
      addListener: (l) => disc.push(l),
      removeListener: (l) => {
        const i = disc.indexOf(l);
        if (i >= 0) disc.splice(i, 1);
      },
      hasListener: (l) => disc.includes(l),
    },
  };
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
      return kind === "updated" ? [ev.tabId, changeView(ext, ev.change, ev.tab.url), tabView(ext, ev.tab)] : null;
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
        /* #271: if permission gating stripped every changeInfo field,
           the extension must not see the event at all. */
        if (kind === "updated" && args[1] && typeof args[1] === "object" && Object.keys(args[1]).length === 0) return;
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
   as Firefox delivers them. Listener filters accept the webRequest
   pattern grammar ({ urls: [...] }) and Firefox's richer UrlFilter
   object (urlMatches, hostEquals, queryEquals, ports, ...) (#560
   residual); an invalid regex throws at addListener, as Firefox
   throws at the call. */
function makeWebNavEvent(
  ext: ExtensionRecord,
  kind: NavigationKind,
): {
  addListener: (l: (info: NavigationCommitted) => void, filter?: { urls?: unknown } & NavigationUrlFilter) => void;
  removeListener: (l: (info: NavigationCommitted) => void) => void;
  hasListener: (l: (info: NavigationCommitted) => void) => boolean;
} {
  const offs = new Map<unknown, () => void>();
  return {
    addListener: (l, filter) => {
      if (offs.has(l)) return;
      const wrapped = (info: NavigationCommitted): void => {
        if (!ext.permissions.includes("webNavigation")) return;
        try {
          l(info);
        } catch {
          /* a broken listener is the extension's own problem */
        }
      };
      const urls = (Array.isArray(filter?.urls) ? filter!.urls : []).map(String);
      const rich: NavigationUrlFilter = {};
      let hasRich = false;
      for (const k of [
        "urlMatches",
        "originAndPathMatches",
        "urlPrefix",
        "urlSuffix",
        "urlContains",
        "hostEquals",
        "queryEquals",
        "ports",
      ] as const) {
        const v = filter?.[k];
        if (v !== undefined) {
          rich[k] = v as never;
          hasRich = true;
        }
      }
      if (hasRich && urls.length > 0) {
        offs.set(l, WEBNAV.subscribeKindAnd(kind, wrapped, urls, navigationFilterPredicate(rich)));
      } else if (hasRich) {
        offs.set(l, WEBNAV.subscribeKind(kind, wrapped, rich));
      } else {
        offs.set(l, WEBNAV.subscribeKind(kind, wrapped, urls.length > 0 ? urls : undefined));
      }
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

/* #560: host platform facts in the PlatformInfo vocabulary Chrome
   and Firefox share, derived from the navigator this worker actually
   runs under. Unknown stays the honest "unknown". */
function hostOs(ua: string): string {
  if (/Android/i.test(ua)) return "android";
  if (/CrOS/i.test(ua)) return "cros";
  if (/OpenBSD|FreeBSD/i.test(ua)) return "openbsd";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "win";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

function hostPlatformInfo(): { os: string; arch: string } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const arch = /arm|aarch/i.test(ua) ? "arm" : /x86_64|x64|WOW64/i.test(ua) ? "x86-64" : "x86-32";
  return { os: hostOs(ua), arch };
}

function hostBrowserInfo(): { name: string; version: string } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const brand = ua.includes("Firefox")
    ? "Firefox"
    : ua.includes("Edg/")
      ? "Edge"
      : ua.includes("OPR/")
        ? "Opera"
        : ua.includes("Chrome/")
          ? "Chrome"
          : "unknown";
  const m = /(Firefox|Edg|OPR|Chrome)[/]([0-9.]+)/.exec(ua);
  return { name: brand, version: m ? m[1] : "" };
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
  /* runtime.onSuspend: dispatched by idleTerminate just before a
     service-worker background is torn down. The event object is
     handed to the background runtime here so the termination path can
     reach the listeners the scripts registered; only service-worker
     backgrounds are ever terminated, so only they register. */
  const onSuspendEvent = makeEvent<() => void>();
  if (sender.context === "background" && backgroundIsServiceWorker(ext)) {
    registerSuspendEvent(ext.id, onSuspendEvent);
  }
  /* The context's locale resolution: deps.i18n when the context
     resolved the package (context.ts), else an empty-catalog default
     that keeps getMessage at Chrome's "" answer (the w572 TM lesson:
     a missing namespace there is fatal, an empty one is honest). */
  const i18nRes: I18nResolved =
    deps.i18n ?? {
      locale: typeof ext.manifest.default_locale === "string" ? ext.manifest.default_locale : "en",
      messages: {},
    };
  const runtime = {
    id: ext.id,
    /* #523: getManifest localizes the manifest's __MSG_*__ string
       fields against the context-resolved locales, like Chrome;
       without deps.i18n the empty map keeps every literal token (an
       honest no-locale env, not a fabricated one). */
    getManifest: (): Record<string, unknown> =>
      substituteManifestStrings(JSON.parse(JSON.stringify(ext.manifest)) as Record<string, unknown>, i18nRes),
    getURL: (path: string): string => extensionUrl(ext.id, path),
    /* #560: platform identity. TM-class background init awaits both
       methods through callback-only Promises; when one is missing the
       TypeError aborts that await, the init never completes, and every
       later page message queues forever. The values are the host
       navigator's honest facts, no guesses. */
    getPlatformInfo: (): Promise<{ os: string; arch: string }> =>
      Promise.resolve(hostPlatformInfo()),
    getBrowserInfo: (): Promise<{ name: string; version: string }> =>
      Promise.resolve(hostBrowserInfo()),
    /* #518: live extension contexts. The background answers, so it
       exists; registered page clients of this extension are live
       extension pages served as tabs. Ids are not derivable yet and
       Firefox makes them optional. */
    getContexts: async (): Promise<Array<{ contextType: string }>> => [
      { contextType: "BACKGROUND" },
      ...pageClientsOf(ext.id).map(() => ({ contextType: "TAB" })),
    ],
    /* #518: the engine has no update server, so the check answers
       Firefox's no_update honestly - never a fabricated update. */
    requestUpdateCheck: (): Promise<{ status: "no_update" }> => Promise.resolve({ status: "no_update" }),
    /* #518: the URL persists per extension and opens through the real
       tabs bridge when the extension uninstalls (manager.uninstall);
       only http(s) URLs are accepted (uninstall-url.ts). */
    setUninstallURL: (url?: unknown) => {
      setUninstallUrlOf(ext.id, url);
      return Promise.resolve();
    },
    /* #518: Firefox-shaped overloads. runtime.sendMessage(message)
     sends internally; runtime.sendMessage(targetId, message) sends
     cross-extension (delivered to the target's onMessageExternal when
     its externally_connectable.ids admit this extension). A single
     string argument stays a message payload - the id overload needs
     the second argument, exactly as in Firefox. The same overloads
     exist on connect: connect(name) keeps the legacy name form, and
     connect(otherId, { name }) opens an external port. */
    /* #518: openOptionsPage walks the same granted-navigation flow the
       host's zl:openExtPage uses: a rooted page URL with a 5-minute
       page token, opened through the real tabs bridge. Firefox's
       open_in_tab=false embedding has no host surface here, so the
       page always opens as a tab (compat.ts documents it). */
    openOptionsPage: (): Promise<void> => {
      const url = extPageOpenUrl(ext, "options");
      if (!url) return Promise.reject(new Error("zeolite: no options page declared"));
      return TABS.create({ url, active: true }).then(() => undefined);
    },
    /* #518: runtime.reload re-parses the stored package (same
       identity), drops the messenger listeners so stale closures
       cannot answer, and re-boots the background. The boot marker
       persists, so the re-boot fires onStartup and never onInstalled,
       exactly like Firefox. ponytail: the re-boot is async by
       necessity (package re-parse), but the caller's runtime object
       must not die mid-call, so the reload is fired, not awaited. */
    reload: (): void => {
      if (!mgr) throw new Error("zeolite: no manager attached to this engine");
      void (async () => {
        await mgr.reload(ext.id);
        deps.messenger.clear(ext.id);
        const live = mgr.get(ext.id);
        if (!live || !live.enabled || !live.background) return;
        if (backgroundIsServiceWorker(live)) {
          idleTerminate(ext.id); /* the next event wakes the fresh code */
          return;
        }
        await bootExtension(live);
      })().catch(() => {
        /* a failed reload keeps the record's lastError; the engine
           must not propagate an extension failure */
      });
    },
    sendMessage: (...args: unknown[]): Promise<unknown> => {
      const [a, b] = args;
      if (typeof a === "string" && a.length > 0 && args.length > 1) {
        if (a === ext.id) return deps.messenger.sendMessage(ext.id, sender, b);
        return deps.messenger.sendMessageExternal(a, sender, b);
      }
      return deps.messenger.sendMessage(ext.id, sender, a);
    },
    onMessage: bridged<MessageListener>((l) => deps.messenger.onMessage(ext.id, l)),
    /* #560: both port surfaces are Chrome-shaped: onMessage and
       onDisconnect are event objects, matching how TM-class
       extension code drives a connected port. */
    connect: (...args: unknown[]): ExtensionPort => {
      const [a, b] = args;
      const nameOf = (v: unknown): string =>
        v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string"
          ? (v as { name: string }).name
          : "";
      /* Two string-ish args name a target extension id (Chrome/Firefox
         external form); a single string stays the legacy port name. */
      if (typeof a === "string" && args.length > 1) {
        const name = nameOf(b);
        if (a === ext.id) return chromePortShape(deps.messenger.connect(ext.id, name, sender)) as unknown as ExtensionPort;
        return chromePortShape(deps.messenger.connectExternal(a, name, sender)) as unknown as ExtensionPort;
      }
      const name = typeof a === "string" ? a : nameOf(a);
      return chromePortShape(deps.messenger.connect(ext.id, name, sender)) as unknown as ExtensionPort;
    },
    onConnect: bridged<ConnectListener>((l) =>
      deps.messenger.onConnect(ext.id, (raw) => l(chromePortShape(raw) as unknown as ExtensionPort)),
    ),
    get lastError(): null {
      return null;
    },
    /* Register-only until the background runtime phase fires them;
       onSuspend is dispatched by idleTerminate at teardown. */
    onInstalled: makeEvent<(details: unknown) => void>(),
    onStartup: makeEvent<() => void>(),
    /* TM-class background boot registers runtime.onUpdateAvailable
       during init; an undefined event member aborts the whole
       bootstrap with a TypeError inside the init chain (the same
       #573 failure class that once left options pages pinging into
       a deaf background). No engine update channel exists to ever
       fire it, so the surface mounts inert like the register-only
       lifecycle events above. */
    onUpdateAvailable: makeEvent<(details: unknown) => void>(),
    onSuspend: onSuspendEvent,
    /* #573: Chrome exposes the external messaging event surfaces on
       runtime. TM-class background boot registers every listener
       surface (onMessage, onConnect, onConnectExternal) during
       startup; an undefined namespace aborts the whole bootstrap
       with a TypeError inside the init chain, leaving the
       extension deaf: options pages ping forever and never render.
       #518: the surfaces are now live for extension-to-extension
       traffic - a cross-extension send reaches onMessageExternal
       when the target's externally_connectable.ids admit the sender,
       with the real sender id/origin. Web-page sends (the matches
       key) stay refused: a page-world sender carries no trusted
       cross-extension identity (compat matrix records it). */
    onMessageExternal: bridged<MessageListener>((l) => deps.messenger.onMessageExternal(ext.id, l)),
    onConnectExternal: bridged<ConnectListener>((l) =>
      deps.messenger.onConnectExternal(ext.id, (raw) => l(chromePortShape(raw) as unknown as ExtensionPort)),
    ),
  };
  /* MV2 chrome.extension: Chrome keeps this namespace on every MV2
     context and removed it in MV3, so it mounts for MV2 records only.
     inIncognitoContext is false (the engine has no incognito
     browsing); getBackgroundPage/getViews answer like a context with
     no live page; getURL shares the runtime implementation. */
  const extensionNs =
    ext.manifestVersion === 2
      ? {
          inIncognitoContext: false,
          getURL: runtime.getURL,
          getBackgroundPage: (): null => null,
          getViews: (): unknown[] => [],
          /* #523: Firefox gates. The engine serves no file: scheme and
             has no incognito browsing, so both answers are the honest
             constants; lastError is the runtime alias (null when no
             send error is pending). */
          isAllowedFileSchemeAccess: (): Promise<boolean> => Promise.resolve(false),
          isAllowedIncognitoAccess: (): Promise<boolean> => Promise.resolve(false),
          get lastError(): null {
            return null;
          },
        }
      : undefined;
  /* #560: chrome.i18n from the package own _locales, resolved once
     per context by context.ts (serve.ts embeds the same data for
     page worlds); i18nRes above carries the missing-deps fallback. */
  const i18nNs = makeI18nNs(i18nRes);
  /* #50: Firefox gates browser.storage on the "storage" permission;
     mounted only when granted - like cookies/notifications/webRequest -
     so feature detection answers honestly and the background/page
     surface agrees with the content-script storage gate in the SW.
     #520: storage.onChanged is the top-level Firefox event - every
     area of this extension's own storage reports (changes, areaName)
     here, in every background context (one context per extension
     shares the area instances, so cross-surface changes arrive).
     storage.session gains Firefox's setAccessLevel, enforced at the
     SW content-script gate from the same registry. The sync surface
     reports Firefox's real quota constants, and the engine enforces
     them (102400 total, 8192 per item, 512 items, write-op rates). */
  const storageNs = ext.permissions.includes("storage")
    ? (() => {
        const areas = [deps.storage.local, deps.storage.sync, deps.storage.session];
        const onChanged = {
          addListener: (l: (changes: Record<string, unknown>, area: string) => void) => {
            if (offs.has(l)) return;
            const wrap = (changes: Record<string, unknown>, area: string) => {
              try {
                l(changes, area);
              } catch {
                /* a broken listener is the extension's own problem */
              }
            };
            for (const a of areas) a.addListener(wrap);
            offs.set(l, () => {
              for (const a of areas) a.removeListener(wrap);
            });
          },
          removeListener: (l: unknown) => {
            offs.get(l)?.();
            offs.delete(l);
          },
          hasListener: (l: unknown) => offs.has(l),
        };
        return {
          local: wrapArea(deps.storage.local),
          sync: {
            ...wrapArea(deps.storage.sync),
            QUOTA_BYTES: SYNC_QUOTA_BYTES,
            QUOTA_BYTES_PER_ITEM: SYNC_QUOTA_BYTES_PER_ITEM,
            MAX_ITEMS: SYNC_MAX_ITEMS,
            MAX_WRITE_OPERATIONS_PER_HOUR: SYNC_MAX_WRITE_OPERATIONS_PER_HOUR,
            MAX_WRITE_OPERATIONS_PER_MINUTE: SYNC_MAX_WRITE_OPERATIONS_PER_MINUTE,
          },
          session: {
            ...wrapArea(deps.storage.session),
            /* #520: Firefox documents the plain-string form; Chrome's
               {accessLevel} object form is accepted too. The level is
               enforced at the SW content-script gate immediately. */
            setAccessLevel: (arg: unknown) => setSessionAccessLevel(ext.id, arg),
          },
          /* #520: the enterprise-policy area. No policy source exists,
             so it answers honestly empty and writes reject read-only
             (storage.ts makeManagedArea). */
          managed: makeManagedArea(),
          onChanged,
        };
      })()
    : undefined;
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
      /* #278: url/title filtering needs the "tabs" permission OR a
         host permission covering the tab. Without the broad permission
         the result set is limited to host-visible tabs, so a filtered
         query can neither leak nor confirm URLs outside the grants. */
      if (!ext.permissions.includes("tabs") && (q.url !== undefined || q.title !== undefined)) {
        return Promise.resolve(
          TABS.query(q)
            .filter((t) => hostPatternsMatch(ext.hostPermissions, t.url))
            .map((t) => tabView(ext, t)),
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
    /* #519: Firefox's TAB_ID_NONE (-1) for no-browser-window states. */
    TAB_ID_NONE: -1,
    /* #519: duplicate rides the real create seam - same url, a fresh
       tab with its own id, onCreated through the registry. Firefox's
       duplicate carries the pinned state; the create seam has no
       pinned property, so the copy lands unpinned (compat.ts). */
    duplicate: (tabId: number, props?: { index?: number; active?: boolean }) => {
      const t = TABS.get(tabId);
      if (!t) return Promise.reject(new Error("Invalid tab ID: " + tabId));
      return TABS.create({
        url: t.url,
        ...(props?.active !== undefined ? { active: props.active } : {}),
        ...(props?.index !== undefined ? { index: props.index } : {}),
      });
    },
    /* #519: highlight without a highlighted-set concept - the
       single-window model activates the LAST tab in the list, exactly
       the one Firefox activates, and the others are a no-op here;
       unknown ids reject. onHighlighted is not mounted (compat.ts). */
    highlight: async (info: { tabs?: unknown }) => {
      const ids = info && typeof info === "object" && Array.isArray(info.tabs) ? info.tabs : null;
      if (!ids || ids.length === 0) {
        throw new Error("zeolite: tabs.highlight requires a non-empty tabs array");
      }
      for (const id of ids) {
        if (typeof id !== "number" || !TABS.get(id)) {
          throw new Error("Invalid tab ID: " + String(id));
        }
      }
      await TABS.update(ids[ids.length - 1] as number, { active: true });
    },
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
  /* contextMenus + Firefox's menus alias over one registry. #519:
     update/remove follow Firefox's Promise semantics - an unknown id
     or bad property rejects instead of a silent no-op, update merges
     properties (parent checks included), and clicks carry Firefox's
     checkbox/radio state transitions. */
  const contextMenusNs = {
    create: (props: Record<string, unknown> = {}) => MENUS.create(ext, props),
    update: async (id: string | number, props: Record<string, unknown> = {}) => {
      MENUS.update(ext.id, String(id), props);
    },
    remove: async (id: string | number) => {
      MENUS.remove(ext.id, String(id));
    },
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
  /* #519: the toolbar action family over one per-tab registry (see
     ./action). Mounted per manifest kind exactly as Firefox mounts
     them: browser.action for an MV3 action key, browserAction or
     pageAction for the MV2 keys. State changes hand off to the host UI
     via zl:actionOp; clicks come back through zl:actionEvent. Firefox
     shape per kind: action.onClicked fires the listener as
     (tab, clickInfo) — two arguments, not one merged object — while
     browserAction/pageAction deliver the Tab. All mutators are async
     like Firefox: invalid details reject instead of throwing. */
  const actionNsFor = (kind: ActionKind) => {
    /* Seeding at mount: the host gets the manifest-default state op
       before any setter runs, and get* answers exist immediately. */
    ACTION.touch(ext, kind);
    return {
    isEnabled: async (details?: { tabId?: number | null }) => ACTION.isEnabled(ext, kind, details),
    enable: async (tabId?: number | null) => {
      ACTION.enable(ext, kind, tabId);
    },
    disable: async (tabId?: number | null) => {
      ACTION.disable(ext, kind, tabId);
    },
    setTitle: async (details: Record<string, unknown> = {}) =>
      ACTION.setTitle(ext, kind, details as { title?: unknown; tabId?: number | null }),
    getTitle: async (details?: { tabId?: number | null }) => ACTION.getTitle(ext, kind, details),
    setBadgeText: async (details: Record<string, unknown> = {}) =>
      ACTION.setBadgeText(ext, kind, details as { text?: unknown; tabId?: number | null }),
    getBadgeText: async (details?: { tabId?: number | null }) => ACTION.getBadgeText(ext, kind, details),
    setBadgeBackgroundColor: async (details: Record<string, unknown> = {}) =>
      ACTION.setBadgeBackgroundColor(ext, kind, details as { color?: unknown; tabId?: number | null }),
    getBadgeBackgroundColor: async (details?: { tabId?: number | null }) =>
      ACTION.getBadgeBackgroundColor(ext, kind, details),
    setBadgeTextColor: async (details: Record<string, unknown> = {}) =>
      ACTION.setBadgeTextColor(ext, kind, details as { color?: unknown; tabId?: number | null }),
    getBadgeTextColor: async (details?: { tabId?: number | null }) =>
      ACTION.getBadgeTextColor(ext, kind, details),
    setPopup: async (details: Record<string, unknown> = {}) =>
      ACTION.setPopup(ext, kind, details as { popup?: unknown; tabId?: number | null }),
    getPopup: async (details?: { tabId?: number | null }) => ACTION.getPopup(ext, kind, details),
    setIcon: async (details: Record<string, unknown> = {}) =>
      ACTION.setIcon(ext, kind, details as { path?: unknown; tabId?: number | null }),
    onClicked: bridged<(tab: unknown, info?: unknown) => void>((l) =>
      ACTION.onClicked(ext.id, kind, (c) => {
        try {
          if (kind === "action") {
            /* Firefox: action.onClicked delivers (tab, clickInfo).
               clickInfo carries only the keys the host reported
               (button for non-primary clicks, modifiers). */
            const { tab, button, modifiers } = c;
            l(
              tab,
              {
                ...(button !== undefined ? { button } : {}),
                ...(modifiers ? { modifiers } : {}),
              },
            );
          } else {
            l(c.tab);
          }
        } catch {
          /* a broken listener is the extension's own problem */
        }
      }),
    ),
    };
  };
  const actionNs = ext.action?.kind === "action" ? actionNsFor("action") : undefined;
  const browserActionNs = ext.action?.kind === "browser_action" ? actionNsFor("browser_action") : undefined;
  /* pageAction: Firefox mounts no badge surface and no enable/disable
     on it; visibility is per-tab via show/hide and starts hidden. */
  const pageActionNs = ext.action?.kind === "page_action"
    ? (() => {
        ACTION.touch(ext, "page_action");
        return {
        isShown: async (details?: { tabId?: number | null }) => ACTION.isShown(ext, details),
        show: async (tabId: number) => {
          ACTION.show(ext, tabId);
        },
        hide: async (tabId: number) => {
          ACTION.hide(ext, tabId);
        },
        setTitle: async (details: Record<string, unknown> = {}) =>
          ACTION.setTitle(ext, "page_action", details as { title?: unknown; tabId?: number | null }),
        getTitle: async (details?: { tabId?: number | null }) =>
          ACTION.getTitle(ext, "page_action", details),
        setPopup: async (details: Record<string, unknown> = {}) =>
          ACTION.setPopup(ext, "page_action", details as { popup?: unknown; tabId?: number | null }),
        getPopup: async (details?: { tabId?: number | null }) =>
          ACTION.getPopup(ext, "page_action", details),
        setIcon: async (details: Record<string, unknown> = {}) =>
          ACTION.setIcon(ext, "page_action", details as { path?: unknown; tabId?: number | null }),
        onClicked: bridged<(info: unknown) => void>((l) =>
          ACTION.onClicked(ext.id, "page_action", (c) => {
            try {
              l(c.tab);
            } catch {
              /* a broken listener is the extension's own problem */
            }
          }),
        ),
        };
      })()
    : undefined;
  /* #42: cookies over the virtual jar (see ./cookies), mounted only
     with the "cookies" permission; every call also host-permission
     gates the target URL. */
  const cookiesNs = ext.permissions.includes("cookies")
    ? (() => {
        return {
          get: (d: Record<string, unknown> = {}) => cookiesGet(ext, d),
          getAll: (d?: Record<string, unknown>) => cookiesGetAll(ext, d),
          set: (d: Record<string, unknown> = {}) => cookiesSet(ext, d),
          remove: (d: Record<string, unknown> = {}) => cookiesRemove(ext, d),
          /* #281: the listener travels with its owning extension so
             delivery can re-check the cookies permission and a host
             permission for the changed cookie. */
          onChanged: bridged<CookieChangeListener>((l) => onCookieChanged(ext, l)),
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
        /* #521: Firefox extraInfoSpec — validated at addListener
           (unknown strings fail) and ENFORCED per listener in the
           registry (#521 slice 2): "blocking" opts a listener into
           cancel/header-replacement (still requiring
           webRequestBlocking), "requestHeaders"/"responseHeaders"
           gate the header fields, and a spec'd listener that asks for
           no blocking capability may register on the header-modifying
           events observe-only without the permission. "asyncBlocking"
           is in the accepted set for Chrome-shaped callers and
           behaves as observation-only, which is documented. */
        const SPEC_KEYS = new Set([
          "blocking",
          "requestHeaders",
          "responseHeaders",
          "requestBody",
          "asyncBlocking",
        ]);
        const reg = (kind: WrKind) => {
          const offs = new Map<unknown, () => void>();
          return {
            addListener: (l: unknown, filter?: { urls?: unknown }, extraInfoSpec?: unknown) => {
              let spec: string[] | undefined;
              if (extraInfoSpec !== undefined) {
                if (!Array.isArray(extraInfoSpec)) {
                  throw new Error("zeolite: extraInfoSpec must be an array of strings");
                }
                spec = extraInfoSpec.map(String);
                for (const s of spec) {
                  if (!SPEC_KEYS.has(s)) {
                    throw new Error("zeolite: unknown extraInfoSpec '" + s + "'");
                  }
                }
              }
              if (
                (kind === "beforeSendHeaders" || kind === "headersReceived") &&
                !ext.permissions.includes("webRequestBlocking")
              ) {
                /* #521 slice 2: Firefox per-listener model — a spec'd
                   listener that asks for NO blocking capability
                   ("requestHeaders"/"responseHeaders" only) registers
                   observe-only without webRequestBlocking. A "blocking"
                   spec or a legacy no-spec registration on a
                   header-modifying kind still requires the permission. */
                const wantsBlocking = spec === undefined || spec.includes("blocking");
                if (wantsBlocking) {
                  throw new Error("zeolite: " + kind + " requires the 'webRequestBlocking' permission");
                }
              }
              if (offs.has(l)) return;
              offs.set(
                l,
                WEBREQ.register(ext.id, kind, l as never, {
                  /* #282: live permission view over the record the
                     backend mutates on grant/revoke; the registry
                     re-reads it on every delivery and blocking
                     decision, so a revoke takes effect without a
                     reload. */
                  perm: () => ({
                    hostPatterns: [...ext.hostPermissions],
                    canBlock: ext.permissions.includes("webRequestBlocking"),
                  }),
                  urls: (Array.isArray(filter?.urls) ? filter!.urls : []).map(String),
                  spec,
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
        /* #521: no webRequest evaluation result is cached between
           requests in this engine, so the flush handlerBehaviorChanged
           asks for is a no-op by construction; the call still counts
           against the Firefox 10-minute cap and rejects once it is
           exhausted. */
        const behaviorCalls: number[] = [];
        return {
          onBeforeRequest: reg("beforeRequest"),
          onBeforeSendHeaders: reg("beforeSendHeaders"),
          onSendHeaders: reg("sendHeaders"),
          onHeadersReceived: reg("headersReceived"),
          onBeforeRedirect: reg("beforeRedirect"),
          onResponseStarted: reg("responseStarted"),
          onCompleted: reg("completed"),
          onErrorOccurred: reg("errorOccurred"),
          MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
          handlerBehaviorChanged: (): Promise<void> => {
            const now = Date.now();
            while (behaviorCalls.length > 0 && now - behaviorCalls[0]! >= 600_000) {
              behaviorCalls.shift();
            }
            if (behaviorCalls.length >= 20) {
              return Promise.reject(
                new Error("zeolite: MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES exceeded"),
              );
            }
            behaviorCalls.push(now);
            return Promise.resolve();
          },
        };
      })()
    : undefined;

  /* #521: declarativeNetRequest over the engine's own fetch
     pipeline. Mounted with "declarativeNetRequest" or
     "declarativeNetRequestWithHostAccess" so feature detection
     answers honestly. The live per-extension view (enabled state,
     host permissions, declared static rulesets) comes from the
     provider control.ts wires over the manager singleton, so rules
     registered in one context apply to the whole tunnel and persisted
     dynamic rules hydrate at worker boot even before any background
     runs. */
  const dnrNs =
    ext.permissions.includes("declarativeNetRequest") ||
    ext.permissions.includes("declarativeNetRequestWithHostAccess")
      ? {
          MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES,
          GUARANTEED_MINIMUM_STATIC_RULES: GUARANTEED_MINIMUM_STATIC_RULES,
          MAX_NUMBER_OF_STATIC_RULESETS: MAX_NUMBER_OF_STATIC_RULESETS,
          MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
          updateDynamicRules: (u: unknown) => DNR.updateDynamicRules(ext.id, u),
          getDynamicRules: () => Promise.resolve(DNR.getDynamicRules(ext.id)),
          updateSessionRules: (u: unknown) => Promise.resolve(DNR.updateSessionRules(ext.id, u)),
          getSessionRules: () => Promise.resolve(DNR.getSessionRules(ext.id)),
          updateEnabledRulesets: (u: unknown) => DNR.updateEnabledRulesets(ext.id, u),
          getEnabledRulesets: () => Promise.resolve(DNR.getEnabledRulesets(ext.id)),
          getAvailableStaticRuleCount: () => DNR.getAvailableStaticRuleCount(ext.id),
          /* #521 slice 4: the typed surface remainder - the reserved
             ruleset ids, the remaining quota constants, the regex
             support probe, per-ruleset static rule enable/disable and
             the read-only match dry run. */
          DYNAMIC_RULESET_ID,
          SESSION_RULESET_ID,
          MAX_NUMBER_OF_DYNAMIC_RULES,
          MAX_NUMBER_OF_SESSION_RULES,
          MAX_NUMBER_OF_REGEX_RULES,
          MAX_NUMBER_OF_DISABLED_STATIC_RULES,
          isRegexSupported: (re: unknown, caseSensitive?: unknown) => DNR.isRegexSupported(re, caseSensitive),
          updateStaticRules: (u: unknown) => DNR.updateStaticRules(ext.id, u),
          getDisabledRuleIds: (o: unknown) => DNR.getDisabledRuleIds(ext.id, o),
          testMatchOutcome: (req: unknown, opts?: unknown) => DNR.testMatchOutcome(ext.id, req, opts),
          /* #521 slice 3: the debugging surface requires the
             declarativeNetRequestFeedback permission (Chrome's
             documented gate); absent otherwise so feature detection
             answers honestly. */
          ...(ext.permissions.includes("declarativeNetRequestFeedback")
            ? {
                getMatchedRules: () => DNR.getMatchedRules(),
                onRuleMatchedDebug: {
                  addListener: (l: (m: DnrMatchedRule) => void) => DNR.onRuleMatchedDebug.addListener(l),
                  removeListener: (l: (m: DnrMatchedRule) => void) => DNR.onRuleMatchedDebug.removeListener(l),
                  hasListener: (l: (m: DnrMatchedRule) => void) => DNR.onRuleMatchedDebug.hasListener(l),
                },
              }
            : {}),
        }
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

  /* #520/#593: browsingData over the engine-owned stores (cache,
     cookie jar, download history, the virtual IndexedDB partition,
     the guest service-worker realms). The host-browser-owned types
     mount and reject honestly - see ./browsingdata. Mounted only with
     the permission, so feature detection answers honestly. */
  /* #520: remove(options, dataToRemove) is Firefox's compose arm over
     the same per-type removers the named methods expose; a host-
     browser-owned type requested here rejects exactly like its named
     method, never silently clearing an absent store. */
  const browsingDataRemoveTypes: Record<string, (o: BrowsingDataOptions) => Promise<void>> = {
    cache: (o) => browsingDataRemoveCache(o),
    cookies: (o) => browsingDataRemoveCookies(o),
    downloads: (o) => browsingDataRemoveDownloads(o),
    formData: () => browsingDataUnreachable("removeFormData")(),
    history: () => browsingDataUnreachable("removeHistory")(),
    indexedDB: (o) => browsingDataRemoveIndexedDB(o),
    localStorage: () => browsingDataUnreachable("removeLocalStorage")(),
    passwords: () => browsingDataUnreachable("removePasswords")(),
    pluginData: () => browsingDataUnreachable("removePluginData")(),
    serviceWorkers: () => browsingDataRemoveServiceWorkers(),
  };
  const browsingDataNs = ext.permissions.includes("browsingData")
    ? {
        remove: async (options: BrowsingDataOptions = {}, dataToRemove: Record<string, unknown> = {}) => {
          for (const [kind, want] of Object.entries(dataToRemove)) {
            if (!want) continue;
            const fn = browsingDataRemoveTypes[kind];
            if (!fn) throw new Error("zeolite: unknown data type: " + kind);
            await fn(options);
          }
        },
        settings: browsingDataSettings,
        removeCache: (options: BrowsingDataOptions = {}) => browsingDataRemoveCache(options),
        removeCookies: (options: BrowsingDataOptions = {}) => browsingDataRemoveCookies(options),
        removeDownloads: (options: BrowsingDataOptions = {}) => browsingDataRemoveDownloads(options),
        removeFormData: browsingDataUnreachable("removeFormData"),
        removeHistory: browsingDataUnreachable("removeHistory"),
        removeIndexedDB: (options: BrowsingDataOptions = {}) => browsingDataRemoveIndexedDB(options),
        removeLocalStorage: browsingDataUnreachable("removeLocalStorage"),
        removePasswords: browsingDataUnreachable("removePasswords"),
        removePluginData: browsingDataUnreachable("removePluginData"),
        removeServiceWorkers: () => browsingDataRemoveServiceWorkers(),
      }
    : undefined;

  /* #520: bookmarks over a real per-extension tree persisted to the
     subsystem's IndexedDB (see ./bookmarks). Mounted only with the
     "bookmarks" permission so feature detection answers honestly. */
  const bookmarksNs = ext.permissions.includes("bookmarks")
    ? (() => {
        return {
          create: (details: BookmarkCreateDetails) => BOOKMARKS.create(ext.id, details),
          get: (idOrIdList: string | string[]) => BOOKMARKS.get(ext.id, idOrIdList),
          getChildren: (id: string) => BOOKMARKS.getChildren(ext.id, id),
          getRecent: (numberOfItems: number) => BOOKMARKS.getRecent(ext.id, numberOfItems),
          getTree: () => BOOKMARKS.getTree(ext.id),
          getSubTree: (id: string) => BOOKMARKS.getSubTree(ext.id, id),
          search: (query: BookmarkSearchQuery) => BOOKMARKS.search(ext.id, query),
          move: (id: string, destination: BookmarkMoveDestination) => BOOKMARKS.move(ext.id, id, destination),
          update: (id: string, changes: BookmarkUpdateChanges) => BOOKMARKS.update(ext.id, id, changes),
          remove: (id: string) => BOOKMARKS.remove(ext.id, id),
          removeTree: (id: string) => BOOKMARKS.removeTree(ext.id, id),
          onCreated: bridged<BookmarkCreatedListener>((l) => BOOKMARKS.onCreated(ext.id, l)),
          onRemoved: bridged<BookmarkRemovedListener>((l) => BOOKMARKS.onRemoved(ext.id, l)),
          onChanged: bridged<BookmarkChangedListener>((l) => BOOKMARKS.onChanged(ext.id, l)),
          onMoved: bridged<BookmarkMovedListener>((l) => BOOKMARKS.onMoved(ext.id, l)),
        };
      })()
    : undefined;

  const browser: Record<string, unknown> = {
    runtime,
    ...(extensionNs ? { extension: extensionNs } : {}),
    i18n: i18nNs,
    ...(storageNs && !isApiDetached("storage") ? { storage: storageNs } : {}),
    tabs: tabsNs,
    windows: windowsNs,
    scripting: scriptingNs,
    ...(isApiDetached("webNavigation") ? {} : { webNavigation: webNavigationNs }),
    ...(isApiDetached("menus") ? {} : { contextMenus: contextMenusNs, menus: contextMenusNs }),
    ...(isApiDetached("downloads") ? {} : { downloads: downloadsNs }),
    permissions: permissionsNs,
    ...(isApiDetached("management") ? {} : { management: managementNs }),
    ...(webRequestNs && !isApiDetached("webRequest") ? { webRequest: webRequestNs } : {}),
    ...(dnrNs && !isApiDetached("declarativeNetRequest") ? { declarativeNetRequest: dnrNs } : {}),
    ...(alarmsNs && !isApiDetached("alarms") ? { alarms: alarmsNs } : {}),
    ...(actionNs ? { action: actionNs } : {}),
    ...(browserActionNs ? { browserAction: browserActionNs } : {}),
    ...(pageActionNs ? { pageAction: pageActionNs } : {}),
    ...(notificationsNs && !isApiDetached("notifications") ? { notifications: notificationsNs } : {}),
    ...(cookiesNs && !isApiDetached("cookies") ? { cookies: cookiesNs } : {}),
    ...(browsingDataNs && !isApiDetached("browsingData") ? { browsingData: browsingDataNs } : {}),
    ...(bookmarksNs && !isApiDetached("bookmarks") ? { bookmarks: bookmarksNs } : {}),
  };
  /* #516 slice 3: the mounted surface validates its argument contract
     (arg-schemas.ts) before any engine work runs. chromeApi wraps the
     already-validated methods and pops its trailing callback first,
     so chrome callers see the same rejections with callback-shaped
     lastError delivery. */
  installArgValidation(browser);
  /* Share implementations while honoring Chrome callbacks. */
  return { browser, chrome: chromeApi(browser) };
}


