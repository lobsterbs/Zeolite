/* Zeolite extension subsystem: webNavigation bridge.

   The engine's fetch handler observes the real navigation lifecycle
   for main-frame document loads: beforeNavigate at interception,
   committed once the HTML response is known (including cache hits),
   completed when the document stream ends. Tab identity is resolved
   from the UI tab registry by exact destination match; loads that
   belong to no known tab are not reported rather than reported with a
   fabricated tab id. Firefox permission semantics (the
   "webNavigation" permission gates event delivery) are enforced at
   the API layer in ./runtime. onDOMContentLoaded is honestly absent:
   the fetch pipeline sees response bytes, not the page's DOM
   readiness. */

import { TABS } from "./tabs";

export type NavigationKind = "beforeNavigate" | "committed" | "completed";

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
  private readonly listeners = new Map<NavigationKind, Set<NavigationListener>>();

  /** Subscribe to one navigation lifecycle kind. */
  subscribeKind(kind: NavigationKind, l: NavigationListener): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(l);
    return () => {
      set?.delete(l);
    };
  }

  /** Backcompat: subscribe to committed only. */
  subscribe(l: NavigationListener): () => void {
    return this.subscribeKind("committed", l);
  }

  /** Fire one lifecycle kind for url. Fires nothing when the
      destination belongs to no tab in the UI model. */
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
    for (const l of [...set]) {
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
}

export const WEBNAV = new NavigationRegistry();
