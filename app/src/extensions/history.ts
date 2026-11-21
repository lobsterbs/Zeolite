/* Zeolite extension subsystem: browser.history (#520 wave).

   Firefox keeps per-profile browsing history; this engine owns the
   proxied browsing sessions, so it owns their history honestly: the
   store below records one visit per committed main-frame navigation
   through the engine (the same seam the webNavigation bridge feeds,
   request.ts), persisted to the subsystem's IndexedDB, and answers
   the Firefox history surface from it.

   Honesty notes (compat.ts carries the same):
   - A visit is a main-frame navigation the engine committed; cached
     document serves answer the same as fresh loads (the rewrite seam
     feeds both), and title is NOT recorded - a service worker never
     sees the document's title, so search answers title-less items
     rather than inventing one.
   - Bounded, not unbounded: at most ZL_HISTORY_URLS distinct URLs and
     ZL_HISTORY_VISITS visits per URL, overwrite-oldest. The oldest
     entries are evicted (whole-URL) when the URL ring overflows.
   - Storage failures degrade to an in-memory ring, never a failed
     navigation: persistence is write-through per mutation.
   - topSites ranks this same store (visitCount then recency);
     with the history store empty it answers honestly empty. */

import { openDb, idbGetAll, idbDelete, idbPut, idbClear, STORE_HISTORY } from "./idb";

export interface VisitItem {
  /** Milliseconds since epoch, Firefox's visitTime. */
  visitTime: number;
}

export interface HistoryItem {
  id: number;
  url: string;
  visitCount: number;
  lastVisitTime: number;
}

export interface HistoryQuery {
  startTime?: number;
  endTime?: number;
  text?: string;
  /** Upper bound on results; Firefox caps at 100 too. */
  maxResults?: number;
}

export interface HistoryChange {
  allHistory: boolean;
  urls: string[];
}

export type VisitedListener = (item: HistoryItem) => void;
export type VisitsDeletedListener = (change: HistoryChange) => void;

interface HistoryRecord {
  id: number;
  url: string;
  visits: number[];
}

/* Firefox caps search itself (maxResults defaults to 100); past that
   the caller paginates with endTime. The store rings are the engine's
   own bounds. */
const ZL_HISTORY_URLS = 10_000;
const ZL_HISTORY_VISITS = 100;
const RING_WARN = "zeolite: history store degraded to memory-only";

export class HistoryStore {
  private readonly byUrl = new Map<string, HistoryRecord>();
  private readonly visited = new Set<VisitedListener>();
  private readonly deleted = new Set<VisitsDeletedListener>();
  /* sequential ids start past every restored record's id. */
  private seq = 0;
  private hydrated = false;

  /** Rehydrate the persisted ring (worker boot, control plane). A
      broken store degrades honestly to an empty memory ring. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    let rows: unknown[];
    try {
      const db = await openDb();
      rows = await idbGetAll(db, STORE_HISTORY);
    } catch {
      console.warn(RING_WARN);
      return;
    }
    const restored: HistoryRecord[] = [];
    for (const row of rows) {
      const r = row as HistoryRecord | null;
      if (!r || typeof r.url !== "string" || !Array.isArray(r.visits)) continue;
      const visits = r.visits.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      if (visits.length === 0 || typeof r.id !== "number") continue;
      restored.push({ id: r.id, url: r.url, visits });
    }
    restored.sort((a, b) => a.visits[a.visits.length - 1]! - b.visits[b.visits.length - 1]!);
    for (const r of restored) this.byUrl.set(r.url, r);
    /* ids stay unique across a restart: past every restored record. */
    this.seq = restored.reduce((m, r) => Math.max(m, r.id), 0);
  }

  /** Record one committed main-frame navigation (the request engine's
      rewrite seam is the single call site). */
  noteVisit(url: string, ts = Date.now()): void {
    if (typeof url !== "string" || url === "" || url.length > 8192) return;
    const rec = this.byUrl.get(url);
    if (rec) {
      rec.visits.push(ts);
      if (rec.visits.length > ZL_HISTORY_VISITS) {
        const cut = rec.visits.length - ZL_HISTORY_VISITS;
        rec.visits.splice(0, cut);
      }
    } else {
      this.byUrl.set(url, { id: ++this.seq, url, visits: [ts] });
      if (this.byUrl.size > ZL_HISTORY_URLS) {
        /* overwrite-oldest by oldest surviving visit; the #25 lesson:
           never shuffle the whole Map for one eviction. */
        let oldest: string | null = null;
        let oldestTs = Infinity;
        for (const [u, r] of this.byUrl) {
          const t = r.visits[0] ?? Infinity;
          if (t < oldestTs) {
            oldestTs = t;
            oldest = u;
          }
        }
        if (oldest !== null) this.byUrl.delete(oldest);
      }
    }
    const item = this.itemView(this.byUrl.get(url)!);
    for (const l of [...this.visited]) {
      try {
        l(item);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
    /* Write-through: one record per navigation, not a debounced ring. */
    void this.persistOne(url).catch(() => console.warn(RING_WARN));
  }

  private itemView(r: HistoryRecord): HistoryItem {
    const visits = r.visits;
    return { id: r.id, url: r.url, visitCount: visits.length, lastVisitTime: visits[visits.length - 1] ?? 0 };
  }

  private async persistOne(url: string): Promise<void> {
    const rec = this.byUrl.get(url);
    const db = await openDb();
    if (!rec) {
      await idbDelete(db, STORE_HISTORY, url);
      return;
    }
    await idbPut(db, STORE_HISTORY, url, rec);
  }

  private async forgetMany(urls: string[]): Promise<void> {
    try {
      const db = await openDb();
      await Promise.all(urls.map((u) => idbDelete(db, STORE_HISTORY, u)));
    } catch {
      /* memory-only degradation: the ring is still the truth */
      console.warn(RING_WARN);
    }
  }

  search(query: HistoryQuery = {}): HistoryItem[] {
    const start = typeof query.startTime === "number" ? query.startTime : -Infinity;
    const end = typeof query.endTime === "number" ? query.endTime : Infinity;
    const text = typeof query.text === "string" ? query.text.toLowerCase() : "";
    const max = typeof query.maxResults === "number" && query.maxResults > 0 ? Math.min(query.maxResults, 100) : 100;
    const out: HistoryItem[] = [];
    for (const r of this.byUrl.values()) {
      /* A URL belongs to the window when its LAST visit is inside it
         (Firefox queries by recency windows); text matches the URL
         (a title is not part of this store, honestly). */
      const last = r.visits[r.visits.length - 1] ?? 0;
      if (last < start || last > end) continue;
      const inWindow = r.visits.filter((t) => t >= start && t <= end).length;
      if (inWindow === 0) continue;
      if (text && !r.url.toLowerCase().includes(text)) continue;
      out.push({ id: r.id, url: r.url, visitCount: inWindow, lastVisitTime: last });
    }
    out.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
    return out.slice(0, max).map((x) => ({ ...x }));
  }

  getVisits(url: string): VisitItem[] {
    const r = this.byUrl.get(url);
    if (!r) return [];
    return r.visits.map((t) => ({ visitTime: t }));
  }

  deleteUrl(url: string): boolean {
    const r = this.byUrl.get(url);
    if (!r) return false;
    this.byUrl.delete(url);
    void this.forgetMany([url]);
    this.fireDeleted({ allHistory: false, urls: [url] });
    return true;
  }

  /** Firefox's deleteRange: every visit inside the window goes; URLs
      whose whole history fell inside the window disappear entirely,
      URLs with older surviving visits stay with those visits. */
  deleteRange(startTime: number, endTime: number): void {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
      throw new Error("zeolite: history.deleteRange requires startTime <= endTime");
    }
    const gone: string[] = [];
    for (const [u, r] of [...this.byUrl]) {
      const kept = r.visits.filter((t) => t < startTime || t > endTime);
      if (kept.length === r.visits.length) continue;
      if (kept.length === 0) {
        this.byUrl.delete(u);
        gone.push(u);
      } else {
        r.visits = kept;
        void this.persistOne(u).catch(() => console.warn(RING_WARN));
      }
    }
    if (gone.length > 0) {
      void this.forgetMany(gone);
      this.fireDeleted({ allHistory: false, urls: gone });
    }
  }

  deleteAll(): void {
    const had = this.byUrl.size > 0;
    this.byUrl.clear();
    try {
      void openDb().then((db) => idbClear(db, STORE_HISTORY)).catch(() => console.warn(RING_WARN));
    } catch {
      console.warn(RING_WARN);
    }
    if (had) this.fireDeleted({ allHistory: true, urls: [] });
  }

  /** The browsingData.removeHistory clear: honors Firefox's since
      (epoch ms) and origins filters against this store. Returns how
      many URLs were removed so honest logs can assert the effect. */
  removeHistory(filter: { since?: number; origins?: string[] }): number {
    const since = typeof filter.since === "number" ? filter.since : -Infinity;
    const origins = Array.isArray(filter.origins) ? new Set(filter.origins) : null;
    const gone: string[] = [];
    for (const [u, r] of [...this.byUrl]) {
      /* Browsers delete entries visited since that timestamp, so the
         filter is on the visit times, per-URL whole-record. */
      const relevant = r.visits.filter((t) => t >= since);
      if (relevant.length === 0) continue;
      if (origins !== null) {
        let o: string;
        try {
          o = new URL(u).origin;
        } catch {
          continue;
        }
        if (!origins.has(o)) continue;
      }
      this.byUrl.delete(u);
      gone.push(u);
    }
    if (gone.length > 0) {
      void this.forgetMany(gone);
      this.fireDeleted({ allHistory: false, urls: gone });
    }
    return gone.length;
  }

  /** topSites.get over the same ring: ranked by visitCount, recency
      breaking ties, newest-first; bounded (Firefox answers ~12). */
  topSites(limit = 12): HistoryItem[] {
    const rows = [...this.byUrl.values()]
      .map((r) => this.itemView(r))
      .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitTime - a.lastVisitTime);
    return rows.slice(0, Math.max(1, Math.min(limit, 100))).map((x) => ({ ...x }));
  }

  onVisited(l: VisitedListener): () => void {
    this.visited.add(l);
    return () => this.visited.delete(l);
  }

  onVisitRemoved(l: VisitsDeletedListener): () => void {
    this.deleted.add(l);
    return () => this.deleted.delete(l);
  }

  private fireDeleted(change: HistoryChange): void {
    for (const l of [...this.deleted]) {
      try {
        l(change);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }

  /** Tests only. */
  resetForTests(): void {
    this.byUrl.clear();
    this.visited.clear();
    this.deleted.clear();
    this.seq = 0;
    this.hydrated = false;
  }
}

export const HISTORY = new HistoryStore();
