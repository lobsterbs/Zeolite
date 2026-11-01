/* Zeolite extension subsystem: downloads.

   downloads.download() hands the URL to the UI host as a
   zl:downloadOp broadcast; the UI owns the actual save. The host
   reports the outcome back through zl:downloadState (#44): the
   registry here records per-id state so downloads.search and
   downloads.onChanged answer truthfully. A handoff the host never
   reports stays "active" - honestly so, the engine cannot know
   whether the host finished, cancelled or died and does not guess.

   #541: the registry persists (write-through on every transition) to
   the extension DB's download-handoffs store and rehydrates on
   background boot. Non-terminal records recover as their last known
   non-terminal state with a recoveredAt marker; terminal states are
   final and never resurrected (a re-report is a bounded diagnostic,
   not a state change). Records older than HANDOFF_RETENTION_MS are
   dropped on load. Only state is persisted - never file bytes, and
   no URL beyond the one the extension itself supplied. */

import { DIAG } from "../diag";
import { openDb, idbDelete, idbGetAll, idbPut, STORE_HANDOFFS } from "./idb";
import type { ExtensionRecord } from "./types";

export interface DownloadOptions {
  url: string;
  filename?: string;
  saveAs?: boolean;
}

export interface DownloadOp {
  op: "download";
  id: number;
  /** #44: owning extension, so the host's state reports can route
      downloads.onChanged back to it. */
  extId: string;
  url: string;
  filename?: string;
  saveAs?: boolean;
}

export type DownloadStatus = "active" | "done" | "error" | "cancelled";

export interface DownloadState {
  id: number;
  extId: string;
  status: DownloadStatus;
  url: string;
  filename?: string;
  received: number;
  size?: number;
  error?: string;
  started: number;
  ended?: number;
  /** #541: set on rehydration for a record whose host never reported
      a terminal state before the worker restarted. The record keeps
      its last known non-terminal status - no fake completion. */
  recoveredAt?: number;
}

/** What downloads.onChanged listeners receive: the new state of one
    handoff download. */
export interface DownloadChange {
  id: number;
  status: DownloadStatus;
  received: number;
  size?: number;
  error?: string;
  ended?: number;
}

export type DownloadsChangedListener = (delta: DownloadChange) => void;

const TERMINAL: Record<string, boolean> = { done: true, error: true, cancelled: true };

/** #541: handoff records older than this are dropped on load (and
    deleted from the store). The store holds state only - the url and
    filename the extension itself supplied - so the retention window
    bounds exactly that. */
export const HANDOFF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isValidHandoff(v: unknown): v is DownloadState {
  const st = v as DownloadState | undefined;
  return (
    !!st &&
    typeof st.id === "number" &&
    typeof st.extId === "string" &&
    typeof st.status === "string" &&
    typeof st.url === "string" &&
    typeof st.started === "number"
  );
}

export class DownloadsHost {
  private seq = 0;
  private dispatch: ((op: DownloadOp) => void) | null = null;
  private readonly states = new Map<number, DownloadState>();
  private readonly changed = new Map<string, Set<DownloadsChangedListener>>();
  /* #541: at most ONE terminal-re-report diagnostic per id; the diag
     ring bounds the total. */
  private readonly terminalWarned = new Set<number>();

  setDispatch(fn: ((op: DownloadOp) => void) | null): void {
    this.dispatch = fn;
  }

  /* #541: write-through. A storage failure is a bounded diagnostic
     and an in-memory registry, never a failed handoff (the host
     already owns the actual save). */
  private async persistState(st: DownloadState): Promise<void> {
    try {
      const db = await openDb();
      await idbPut(db, STORE_HANDOFFS, String(st.id), st);
    } catch (err) {
      DIAG.failure({
        category: "EXTENSION",
        cause: "extension",
        severity: "warning",
        message: "download handoff persistence failed",
        technicalReason: String(err),
      });
    }
  }

  async download(ext: ExtensionRecord, opts: DownloadOptions): Promise<number> {
    if (!ext.permissions.includes("downloads")) {
      throw new Error("zeolite: permission 'downloads' not granted to this extension");
    }
    if (!opts || typeof opts.url !== "string") {
      throw new Error("zeolite: downloads.download requires a url");
    }
    if (!this.dispatch) {
      throw new Error("zeolite: no download host attached to this engine");
    }
    const id = ++this.seq;
    this.dispatch({
      op: "download",
      id,
      extId: ext.id,
      url: opts.url,
      filename: opts.filename,
      saveAs: opts.saveAs,
    });
    const st: DownloadState = {
      id,
      extId: ext.id,
      status: "active",
      url: opts.url,
      filename: opts.filename,
      received: 0,
      started: Date.now(),
    };
    this.states.set(id, st);
    /* #541: the record is durable before the id resolves, so a
       restart right after the call cannot lose the handoff. */
    await this.persistState(st);
    return id;
  }

  /** #44: apply one host state report. Returns the owner + the change
      to deliver to downloads.onChanged, or null when nothing applies
      (unknown id, bad status, or an id already in a terminal state:
      terminal is final - #541 adds one bounded diagnostic for the
      re-report and never resurrects). Does NOT fire listeners itself,
      so the SW can wake the owning background first, then notify().
      The state change is written through to the store fire-and-forget:
      callers get their synchronous answer, storage follows. */
  applyState(
    id: number,
    status: string,
    extra: { received?: unknown; size?: unknown; error?: unknown } = {},
  ): { extId: string; delta: DownloadChange } | null {
    const st = this.states.get(id);
    if (!st) return null;
    if (TERMINAL[st.status]) {
      if (!this.terminalWarned.has(id)) {
        this.terminalWarned.add(id);
        DIAG.failure({
          category: "EXTENSION",
          cause: "extension",
          severity: "warning",
          message: "terminal download state re-reported for handoff " + id + " (terminal is final)",
        });
      }
      return null;
    }
    if (status !== "active" && !TERMINAL[status]) return null;
    st.status = status as DownloadStatus;
    if (typeof extra.received === "number" && extra.received >= 0) st.received = extra.received;
    if (typeof extra.size === "number" && extra.size >= 0) st.size = extra.size;
    if (typeof extra.error === "string") st.error = extra.error;
    if (TERMINAL[status]) st.ended = Date.now();
    void this.persistState(st);
    return { extId: st.extId, delta: this.changeOf(st) };
  }

  changeOf(st: DownloadState): DownloadChange {
    return {
      id: st.id,
      status: st.status,
      received: st.received,
      size: st.size,
      error: st.error,
      ended: st.ended,
    };
  }

  /** #541: rehydrate the persisted handoff registry (background boot,
      the wireDispatchers path). Records older than the retention
      window are dropped and deleted. A record whose host never
      reported a terminal state recovers as its last known
      non-terminal state with a recoveredAt marker - the engine cannot
      distinguish "host finished", "user cancelled the download", and
      "tab closed before the report", so it does not guess. Terminal
      records restore as terminal and stay final. */
  async load(): Promise<void> {
    let db: IDBDatabase;
    try {
      db = await openDb();
    } catch {
      return; /* storage unavailable: in-memory registry only */
    }
    let rows: unknown[];
    try {
      rows = await idbGetAll(db, STORE_HANDOFFS);
    } catch (err) {
      DIAG.failure({
        category: "EXTENSION",
        cause: "extension",
        severity: "warning",
        message: "download handoff restore failed",
        technicalReason: String(err),
      });
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      if (!isValidHandoff(row)) continue;
      const st = row as DownloadState;
      if (now - st.started > HANDOFF_RETENTION_MS) {
        void idbDelete(db, STORE_HANDOFFS, String(st.id));
        continue;
      }
      this.states.set(st.id, TERMINAL[st.status] ? st : { ...st, recoveredAt: now });
      /* ids must stay unique across a restart: the sequence restarts
         past every restored id. */
      if (st.id > this.seq) this.seq = st.id;
    }
  }

  /** An extension sees only its own handoffs, newest first. */
  search(ext: ExtensionRecord, query: { id?: number } = {}): DownloadState[] {
    if (!ext.permissions.includes("downloads")) {
      throw new Error("zeolite: permission 'downloads' not granted to this extension");
    }
    const own = [...this.states.values()].filter((s) => s.extId === ext.id);
    const rows = typeof query.id === "number" ? own.filter((s) => s.id === query.id) : own;
    return rows.sort((a, b) => b.started - a.started).map((s) => ({ ...s }));
  }

  onChanged(extId: string, l: DownloadsChangedListener): () => void {
    let set = this.changed.get(extId);
    if (!set) {
      set = new Set();
      this.changed.set(extId, set);
    }
    set.add(l);
    return () => set?.delete(l);
  }

  /** Fire the extension's onChanged listeners; the SW calls this
      after wakeExtension so an idle background hears it too. */
  notify(extId: string, delta: DownloadChange): void {
    const set = this.changed.get(extId);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(delta);
      } catch {
        /* a broken listener is the extension's own problem */
      }
    }
  }
}

export const DOWNLOADS = new DownloadsHost();
