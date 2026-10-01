/* Zeolite extension subsystem: downloads.

   downloads.download() hands the URL to the UI host as a
   zl:downloadOp broadcast; the UI owns the actual save. The host
   reports the outcome back through zl:downloadState (#44): the
   registry here records per-id state so downloads.search and
   downloads.onChanged answer truthfully. A handoff the host never
   reports stays "active"; the registry is in-memory, so a worker
   restart drops it (the same honest-restart rule as zl:adblock). */

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

export class DownloadsHost {
  private seq = 0;
  private dispatch: ((op: DownloadOp) => void) | null = null;
  private readonly states = new Map<number, DownloadState>();
  private readonly changed = new Map<string, Set<DownloadsChangedListener>>();

  setDispatch(fn: ((op: DownloadOp) => void) | null): void {
    this.dispatch = fn;
  }

  download(ext: ExtensionRecord, opts: DownloadOptions): Promise<number> {
    if (!ext.permissions.includes("downloads")) {
      return Promise.reject(
        new Error("zeolite: permission 'downloads' not granted to this extension"),
      );
    }
    if (!opts || typeof opts.url !== "string") {
      return Promise.reject(new Error("zeolite: downloads.download requires a url"));
    }
    if (!this.dispatch) {
      return Promise.reject(
        new Error("zeolite: no download host attached to this engine"),
      );
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
    this.states.set(id, {
      id,
      extId: ext.id,
      status: "active",
      url: opts.url,
      filename: opts.filename,
      received: 0,
      started: Date.now(),
    });
    return Promise.resolve(id);
  }

  /** #44: apply one host state report. Returns the owner + the change
      to deliver to downloads.onChanged, or null when nothing applies
      (unknown id, bad status, or an id already in a terminal state:
      terminal is final). Does NOT fire listeners itself, so the SW
      can wake the owning background first, then notify(). */
  applyState(
    id: number,
    status: string,
    extra: { received?: unknown; size?: unknown; error?: unknown } = {},
  ): { extId: string; delta: DownloadChange } | null {
    const st = this.states.get(id);
    if (!st) return null;
    if (TERMINAL[st.status]) return null;
    if (status !== "active" && !TERMINAL[status]) return null;
    st.status = status as DownloadStatus;
    if (typeof extra.received === "number" && extra.received >= 0) st.received = extra.received;
    if (typeof extra.size === "number" && extra.size >= 0) st.size = extra.size;
    if (typeof extra.error === "string") st.error = extra.error;
    if (TERMINAL[status]) st.ended = Date.now();
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
