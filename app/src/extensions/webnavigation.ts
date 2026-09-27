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

export class NavigationRegistry {
  private readonly listeners = new Map<NavigationKind, Map<NavigationListener, string[] | null>>();

  /** Subscribe to one navigation lifecycle kind, optionally with a
      url filter (webRequest-style host patterns). */
  subscribeKind(kind: NavigationKind, l: NavigationListener, urls?: string[]): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Map();
      this.listeners.set(kind, set);
    }
    set.set(l, urls && urls.length > 0 ? urls : null);
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
    for (const [l, urls] of [...set]) {
      if (urls && !hostPatternsMatch(urls, url)) continue;
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
