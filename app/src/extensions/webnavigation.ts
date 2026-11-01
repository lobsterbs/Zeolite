/* Zeolite extension subsystem: webNavigation bridge.

   The engine's fetch handler observes the real navigation lifecycle
   for main-frame document loads: beforeNavigate at interception,
   committed once the HTML response is known (including cache hits),
   completed when the document stream ends. onDOMContentLoaded comes
   from the page-world content-script bridge (see ./bridge): it fires
   only on pages where a bridge exists, because the fetch pipeline
   sees response bytes, not the page's DOM readiness. Tab identity is
   resolved from the UI tab registry by exact destination match; loads
   that belong to no known tab are not reported rather than reported
   with a fabricated tab id. Listener url filters use the webRequest
   pattern grammar. Firefox permission semantics (the
   "webNavigation" permission gates event delivery) are enforced at
   the API layer in ./runtime. */

import { TABS } from "./tabs";
import { hostPatternsMatch } from "./permissions";

export type NavigationKind =
  | "beforeNavigate"
  | "committed"
  | "completed"
  | "domcontentloaded";

export interface NavigationCommitted {
  tabId: number;
  url: string;
  frameId: number;
  timeStamp: number;
}

/** Alias: every navigation event carries the same info shape. */
export type NavigationInfo = NavigationCommitted;

export type NavigationListener = (info: NavigationInfo) => void;

/** #560 residual: Firefox's webNavigation UrlFilter. The engine now
    accepts the full documented object (alongside the legacy webRequest
    pattern-array form); every key present must match, as in Firefox. */
export interface NavigationUrlFilter {
  urlMatches?: string;
  originAndPathMatches?: string;
  urlPrefix?: string;
  urlSuffix?: string;
  urlContains?: string;
  hostEquals?: string;
  queryEquals?: string;
  /** Ports of the URL: numbers or [min, max] pairs. An empty port
      means the scheme default (80 http/ws, 443 https/wss). */
  ports?: Array<number | [number, number]>;
}

type NavFilter = string[] | NavigationUrlFilter;

function defaultPortFor(scheme: string): number | null {
  if (scheme === "http:" || scheme === "ws:") return 80;
  if (scheme === "https:" || scheme === "wss:") return 443;
  if (scheme === "ftp:") return 21;
  return null;
}

function portMatches(filter: NonNullable<NavigationUrlFilter["ports"]>, u: URL): boolean {
  const explicit = u.port !== "" ? Number(u.port) : defaultPortFor(u.protocol);
  if (explicit === null) return false;
  return filter.some((p) => (Array.isArray(p) ? explicit >= p[0] && explicit <= p[1] : explicit === p));
}

/** Compile a Firefox UrlFilter into a predicate. Invalid regexes
    throw here, at addListener time, like Firefox throws at the call. */
export function navigationFilterPredicate(f: NavigationUrlFilter): (url: string) => boolean {
  const urlRe = f.urlMatches !== undefined ? new RegExp(f.urlMatches) : null;
  const opRe = f.originAndPathMatches !== undefined ? new RegExp(f.originAndPathMatches) : null;
  return (url: string): boolean => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (f.hostEquals !== undefined && u.hostname !== f.hostEquals) return false;
    if (f.urlContains !== undefined && !url.includes(f.urlContains)) return false;
    if (f.urlPrefix !== undefined && !url.startsWith(f.urlPrefix)) return false;
    if (f.urlSuffix !== undefined && !url.endsWith(f.urlSuffix)) return false;
    if (f.queryEquals !== undefined && u.search.replace(/^\?/, "") !== f.queryEquals) return false;
    if (f.ports !== undefined && !portMatches(f.ports, u)) return false;
    if (urlRe !== null && !urlRe.test(url)) return false;
    if (opRe !== null && !opRe.test(u.origin + u.pathname)) return false;
    return true;
  };
}

interface StoredFilter {
  urls: string[] | null;
  pred: ((url: string) => boolean) | null;
}

function storedFilterOf(filter: NavFilter | undefined): StoredFilter | null {
  if (filter === undefined) return null;
  if (Array.isArray(filter)) {
    return { urls: filter.length > 0 ? filter : null, pred: null };
  }
  if (Object.keys(filter).length === 0) return null;
  return { urls: null, pred: navigationFilterPredicate(filter) };
}

export class NavigationRegistry {
  private readonly listeners = new Map<NavigationKind, Map<NavigationListener, StoredFilter | null>>();

  /** Subscribe to one navigation lifecycle kind, optionally with a
      url filter: webRequest-style host patterns (string[]) or a
      Firefox UrlFilter object (#560 residual). */
  subscribeKind(kind: NavigationKind, l: NavigationListener, filter?: NavFilter): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Map();
      this.listeners.set(kind, set);
    }
    set.set(l, storedFilterOf(filter));
    return () => {
      set?.delete(l);
    };
  }

  /** Subscribe with BOTH filter shapes at once: every pattern and the
      compiled UrlFilter predicate must pass (AND). */
  subscribeKindAnd(
    kind: NavigationKind,
    l: NavigationListener,
    urls: string[],
    pred: (url: string) => boolean,
  ): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Map();
      this.listeners.set(kind, set);
    }
    set.set(l, { urls: urls.length > 0 ? urls : null, pred });
    return () => {
      set?.delete(l);
    };
  }

  /** Backcompat: subscribe to committed only. */
  subscribe(l: NavigationListener): () => void {
    return this.subscribeKind("committed", l);
  }

  /** Fire one lifecycle kind for url. Fires nothing when the
      destination belongs to no tab in the UI model or a listener's
      url filter does not match. */
  fire(kind: NavigationKind, url: string): void {
    const tab = TABS.list().find((t) => t.url === url);
    if (!tab) return;
    const set = this.listeners.get(kind);
    if (!set || set.size === 0) return;
    const info: NavigationInfo = {
      tabId: tab.id,
      url,
      frameId: 0,
      timeStamp: Date.now(),
    };
    for (const [l, filter] of [...set]) {
      if (filter) {
        if (filter.urls && !hostPatternsMatch(filter.urls, url)) continue;
        if (filter.pred && !filter.pred(url)) continue;
      }
      try {
        l(info);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }

  /** Navigation-mode request intercepted for url. */
  beforeNavigate(url: string): void {
    this.fire("beforeNavigate", url);
  }

  /** Main-frame document load observed for url (fresh or cached). */
  committed(url: string): void {
    this.fire("committed", url);
  }

  /** Document stream finished delivering for url. */
  completed(url: string): void {
    this.fire("completed", url);
  }

  /** The page-world bridge reported DOM readiness for url. */
  domContentLoaded(url: string): void {
    this.fire("domcontentloaded", url);
  }
}

export const WEBNAV = new NavigationRegistry();
