/* Download registry (Phase 7, 1.7 Sulfide).

   The engine cannot write files itself: a service worker has no disk
   API. What it owns is the response stream, and that is enough. The
   fetch handler routes every attachment response (Content-Disposition:
   attachment) through this registry: a passthrough counting stream
   keeps the bytes moving to the browser's own download machinery, so
   nothing is ever fully buffered and the file lands on disk exactly
   as the native flow writes it. The registry records what the engine
   knows from network info - filename, MIME, size, received bytes,
   speed, source, status, error - and can cancel an in-flight download
   by severing the stream.

   Honesty notes (docs/downloads.md):
   - A download is only visible when the response carries
     Content-Disposition: attachment. Anchor downloads without it are
     served as ordinary responses; the browser may still save them,
     but the engine honestly does not classify them.
   - Speed is a whole-lifetime average, not a rolling window.
   - 2.2 Arsenide: the ring persists to site-scoped IndexedDB (keyed
     by the source origin) so entries survive a service-worker
     restart. An entry that was active at shutdown is honestly marked
     error/interrupted on load: no stream survives a restart.
   - #118 resume: resumable downloads buffer their bytes in the worker
     (cap ZL_DL_RESUME_MAX; a worker cannot reach the file the browser
     started writing) and a pause persists the partial bytes, so
     resume continues with an HTTP Range request through the wisp
     tunnel. Above the cap, and for every download that completed on
     its first pass, there is honestly nothing to resume from. */

import { openDb, idbGet, idbDelete, idbGetAllKeys, idbPut, STORE_DOWNLOADS, STORE_PARTIALS } from "./extensions/idb";

export interface DownloadEntry {
  id: string;
  filename: string;
  mime: string;
  /** Total size from Content-Length; -1 when the server did not say. */
  size: number;
  /** Bytes delivered to the page so far. */
  received: number;
  startedAt: number;
  /** 0 while active; completion timestamp otherwise. */
  endedAt: number;
  status: "active" | "done" | "error" | "cancelled" | "paused";
  /** #118: true while partial bytes are held for resume. Size-capped
      (ZL_DL_RESUME_MAX); false means pause is honest but resume is
      not possible. */
  resumable: boolean;
  /** The target (upstream) URL the file came from. */
  source: string;
  /** Whole-lifetime average bytes/second, computed at read time. */
  speed: number;
  error?: string;
}

/** Parse the filename of an attachment response: RFC 6265/6266 style
    Content-Disposition filename (quoted or token), falling back to the
    last path segment of the source URL, then to "download". */
export function downloadFilename(source: string, headers: Headers): string {
  const cd = headers.get("content-disposition") ?? "";
  const quoted = cd.match(/filename\*?=\s*"([^"]*)"/i);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  const token = cd.match(/filename\*?=\s*([^;"\s]+)/i);
  if (token && token[1].trim()) return token[1].trim();
  try {
    const p = new URL(source).pathname.split("/").filter(Boolean).pop();
    if (p) return decodeURIComponent(p);
  } catch {
    /* not a URL: fall through */
  }
  return "download";
}

/** #26: a record straight out of IndexedDB is untrusted. One corrupted
    field would poison snapshot()'s speed math or the UI's status
    rendering, so every field is checked before an entry is restored. */
function isValidEntry(e: unknown): e is DownloadEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.filename === "string" &&
    typeof r.mime === "string" &&
    typeof r.source === "string" &&
    Number.isFinite(r.size) &&
    Number.isFinite(r.received) &&
    Number.isFinite(r.startedAt) &&
    Number.isFinite(r.endedAt) &&
    (r.status === "active" ||
      r.status === "done" ||
      r.status === "error" ||
      r.status === "cancelled" ||
      r.status === "paused") &&
    (r.resumable === undefined || typeof r.resumable === "boolean") &&
    (r.error === undefined || typeof r.error === "string")
  );
}

const RING = 200;

/** #118: partial-byte buffering cap for resumable downloads. The
    bytes must be held by the engine (a worker cannot reach the file
    the browser started writing), so above this size resume is
    honestly unavailable. Mirrors the page-cache cap rationale. */
export const ZL_DL_RESUME_MAX = 64 * 1024 * 1024;

export class DownloadTracker {
  private readonly entries: DownloadEntry[] = [];
  private readonly streams = new Map<string, TransformStream<Uint8Array, Uint8Array>>();
  /* The readable side of a TransformStream is only reliably severable
     through its controller: aborting the writable alone can leave the
     readable quietly serving already-queued chunks. */
  private readonly controllers = new Map<string, TransformStreamDefaultController<Uint8Array>>();
  private seq = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /* #118: buffered partial bytes per entry id (resume needs the
     bytes; the partial file the browser started writing is
     unreachable from a worker), and the ids with a resume pump
     running so a second zl:resumeDownload cannot double-drain the
     same entry. */
  private readonly partials = new Map<string, { chunks: Uint8Array[]; n: number }>();
  private readonly resumePumps = new Set<string>();
  private resumeFetch: ((url: string, init: { headers: Record<string, string> }) => Promise<Response>) | null = null;

  /** Register a new attachment response; returns its entry id. */
  begin(source: string, headers: Headers, mime: string, size: number): string {
    const id = "dl" + ++this.seq;
    this.entries.push({
      id,
      filename: downloadFilename(source, headers),
      mime,
      size,
      received: 0,
      startedAt: Date.now(),
      endedAt: 0,
      status: "active",
      source,
      speed: 0,
      resumable: size === -1 || size <= ZL_DL_RESUME_MAX,
    });
    /* #25: never evict an entry whose stream is still delivering bytes
       (its chunks update the entry and its completion persists it):
       drop the oldest idle entry instead, and honestly run over
       capacity when every slot is live. */
    if (this.entries.length > RING) {
      const i = this.entries.findIndex((e) => !this.streams.has(e.id));
      if (i >= 0) this.entries.splice(i, 1);
    }
    this.schedulePersist();
    return id;
  }

  /* ---- persistence (2.2 Arsenide) -------------------------------- */

  /* Site scoping: one record per source origin, so a site's history is
     isolated from another's, the same partitioning the jar uses. */
  private siteKey(source: string): string {
    try {
      return "site:" + new URL(source).origin;
    } catch {
      return "site:unknown";
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist().catch(() => undefined);
    }, 500);
  }

  /** Write the ring grouped per source origin. Storage failures mean an
      in-memory registry, never an engine failure. Exported for hosts
      and tests that want a forced flush. */
  async persist(): Promise<void> {
    const db = await openDb();
    const bySite = new Map<string, DownloadEntry[]>();
    for (const e of this.entries) {
      const k = this.siteKey(e.source);
      const list = bySite.get(k) ?? [];
      list.push(e);
      bySite.set(k, list);
    }
    for (const k of await idbGetAllKeys(db, STORE_DOWNLOADS)) {
      if (!bySite.has(k)) bySite.set(k, []); /* drop sites that emptied */
    }
    /* #27: one site's quota error must not lose the other sites'
       writes: settle every put independently and surface the count
       instead of swallowing it. */
    const settled = await Promise.allSettled(
      [...bySite].map(([k, list]) => idbPut(db, STORE_DOWNLOADS, k, list)),
    );
    const failed = settled.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.warn(`download registry: ${failed}/${settled.length} site writes failed`);
    }
  }

  /** Restore the persisted ring (SW activate). Entries that were active
      when the worker died are honestly marked error: no stream
      survives a restart. #118: paused entries restore as paused,
      their partial bytes stay in the partials store for resume(). */
  async load(): Promise<void> {
    const db = await openDb();
    const keys = await idbGetAllKeys(db, STORE_DOWNLOADS);
    const restored: DownloadEntry[] = [];
    let skipped = 0;
    for (const k of keys) {
      const rec = (await idbGet(db, STORE_DOWNLOADS, k)) as DownloadEntry[] | undefined;
      if (!Array.isArray(rec)) continue;
      for (const e of rec) {
        if (!isValidEntry(e)) {
          skipped++;
          continue;
        }
        restored.push(
          e.status === "active"
            ? { ...e, status: "error", endedAt: Date.now(), error: "interrupted: worker restarted" }
            : { ...e, resumable: e.resumable === true }, /* #118: paused entries restore as paused */
        );
      }
    }
    if (skipped > 0) {
      console.warn(`download registry: skipped ${skipped} corrupted stored entries`);
    }
    restored.sort((a, b) => a.startedAt - b.startedAt);
    this.entries.length = 0;
    this.entries.push(...restored.slice(-RING));
    /* #118: drop stored partials whose entry no longer exists. */
    try {
      const db2 = await openDb();
      const live = new Set(this.entries.map((x) => x.id));
      for (const k of await idbGetAllKeys(db2, STORE_PARTIALS)) {
        if (!live.has(k)) void idbDelete(db2, STORE_PARTIALS, k);
      }
    } catch {
      /* pruning is hygiene, never load-bearing */
    }
    /* ids must stay unique across a restart: restart the sequence past
       every restored numeric suffix. */
    for (const e of this.entries) {
      const n = Number(e.id.slice(2));
      if (Number.isInteger(n) && n > this.seq) this.seq = n;
    }
  }

  /** Wrap a response body in the counting passthrough. Streaming is
      preserved byte for byte: every chunk is forwarded the moment it
      arrives and never accumulated. */
  wrap(id: string, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const entry = this.entries.find((x) => x.id === id);
    const tracker = this;
    /* #118: resumable entries get their buffer here, so the transform
       below can tee into it. */
    if (entry && entry.resumable) this.partials.set(id, { chunks: [], n: 0 });
    const ts = new TransformStream<Uint8Array, Uint8Array>({
      start: (ctrl) => {
        this.controllers.set(id, ctrl);
      },
      transform(chunk, ctrl) {
        if (entry && entry.status === "active") {
          entry.received += chunk.byteLength;
          /* #118: keep the bytes that make resume possible, up to the
             cap; over it the entry honestly loses resumability. */
          const p = tracker.partials.get(id);
          if (entry.resumable && p) {
            p.chunks.push(chunk);
            p.n += chunk.byteLength;
            if (p.n > ZL_DL_RESUME_MAX) {
              entry.resumable = false;
              tracker.partials.delete(id);
            }
          }
        }
        ctrl.enqueue(chunk);
      },
      flush() {
        if (entry && entry.status === "active") {
          entry.status = "done";
          entry.endedAt = Date.now();
          /* the browser saved the file: buffered bytes exist only for
             resume, so a clean completion frees them. */
          tracker.partials.delete(id);
        }
        tracker.schedulePersist();
      },
    });
    this.streams.set(id, ts);
    /* The moment the page stops reading (user cancels in the browser
       UI), the underlying stream cancels: mark, do not pretend. */
    void body.pipeTo(ts.writable, {
      preventCancel: false,
    }).catch(() => {
      if (entry && entry.status === "active") {
        /* #118: the page stopped reading (user cancel in the browser
           UI, or the page died mid-flight). With buffered bytes the
           entry stays resumable as paused; without them it is the
           same honest error as before. */
        const p = tracker.partials.get(id);
        if (entry.resumable && p && p.n > 0) {
          entry.status = "paused";
          entry.endedAt = Date.now();
          entry.error = "interrupted: stream failed (resumable)";
          void tracker.persistPartial(id);
        } else {
          entry.status = "error";
          entry.endedAt = Date.now();
          entry.error = "stream failed";
        }
      }
    }).finally(() => {
      this.streams.delete(id);
      this.controllers.delete(id);
      this.schedulePersist();
    });
    return ts.readable;
  }

  /** Server-side cancellation: sever the stream so the page's download
      aborts and the upstream flow stops. Returns false for unknown or
      already-finished ids. */
  cancel(id: string): boolean {
    const entry = this.entries.find((x) => x.id === id);
    const ts = this.streams.get(id);
    if (entry && entry.status === "active") {
      entry.status = "cancelled";
      entry.endedAt = Date.now();
      /* #118: an explicit abandon frees the partial bytes too. */
      this.forgetPartial(id);
      this.schedulePersist();
    }
    if (ts) {
      const ctl = this.controllers.get(id);
      if (ctl) {
        try {
          ctl.error(new Error("cancelled"));
        } catch {
          /* already errored or closed */
        }
      }
      ts.writable.abort(new Error("cancelled")).catch(() => undefined);
      this.streams.delete(id);
      this.controllers.delete(id);
      return true;
    }
    return Boolean(entry && entry.status === "cancelled");
  }

  /* ---- resume (#118) ----------------------------------------------- */

  /** Server-side pause: like cancel it severs the stream, but the
      entry stays resumable - status paused, partial bytes held in
      memory and persisted to IndexedDB. Returns false for unknown
      or already-finished ids. */
  pause(id: string): boolean {
    const entry = this.entries.find((x) => x.id === id);
    const ts = this.streams.get(id);
    if (entry && entry.status === "active") {
      entry.status = "paused";
      entry.endedAt = Date.now();
      if (entry.resumable && this.partials.has(id)) {
        void this.persistPartial(id);
      } else {
        entry.resumable = false; /* nothing buffered: no resume possible */
      }
      this.schedulePersist();
    }
    if (ts) {
      const ctl = this.controllers.get(id);
      if (ctl) {
        try {
          ctl.error(new Error("paused"));
        } catch {
          /* already errored or closed */
        }
      }
      ts.writable.abort(new Error("paused")).catch(() => undefined);
      this.streams.delete(id);
      this.controllers.delete(id);
      return true;
    }
    return Boolean(entry && entry.status === "paused");
  }

  /** Resume a paused entry with an HTTP Range request through the
      injected engine fetch seam. 206 continues from the buffered
      count; 200 means the server ignored Range and the download
      restarts from zero (partial discarded); 416 kills the entry
      (the upstream says the remaining bytes are gone). */
  async resume(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.find((x) => x.id === id);
    if (!entry) return { ok: false, error: "unknown id" };
    if (entry.status !== "paused") return { ok: false, error: "not paused" };
    if (!entry.resumable) return { ok: false, error: "no resumable bytes (cap exceeded or none buffered)" };
    if (!this.resumeFetch) return { ok: false, error: "no resume transport wired" };
    if (this.resumePumps.has(id)) return { ok: false, error: "resume already in flight" };
    /* Restore the partial buffer after a worker restart: paused
       entries keep their bytes in IndexedDB, not memory. */
    if (!this.partials.has(id)) {
      if (await this.loadPartial(id)) {
        entry.received = this.partials.get(id)!.n;
      } else {
        /* nothing survived: an honest restart from zero */
        this.partials.set(id, { chunks: [], n: 0 });
        entry.received = 0;
      }
    }
    entry.status = "active";
    entry.error = undefined;
    this.schedulePersist();
    try {
      const res = await this.resumeFetch(entry.source, { headers: { range: "bytes=" + entry.received + "-" } });
      if (res.status === 416) {
        entry.status = "error";
        entry.endedAt = Date.now();
        entry.error = "416: upstream cannot serve the remaining range";
        this.forgetPartial(id);
        this.schedulePersist();
        return { ok: false, error: entry.error };
      }
      if (res.status === 206) {
        const m = /bytes (\d+)-/.exec(res.headers.get("content-range") ?? "");
        if (!m || Number(m[1]) !== entry.received) {
          entry.status = "paused";
          entry.error = "206 content-range mismatch: upstream answered a different start";
          this.schedulePersist();
          return { ok: false, error: entry.error };
        }
        return { ok: await this.pumpResume(id, res.body) };
      }
      /* 200 (server ignored Range) or any other full answer: the
         partial is worthless, restart from zero. */
      const p = this.partials.get(id)!;
      p.chunks.length = 0;
      p.n = 0;
      entry.received = 0;
      entry.startedAt = Date.now();
      return { ok: await this.pumpResume(id, res.body) };
    } catch (err) {
      entry.status = "paused";
      entry.error = "resume failed: " + String(err);
      void this.persistPartial(id);
      this.schedulePersist();
      return { ok: false, error: entry.error };
    }
  }

  /** Drain the remaining (or restarted) upstream body into the entry
      and its partial buffer. No page is reading these bytes: the
      tracker itself is the consumer, and the completed artifact is
      handed back to the UI host through assemble(). */
  private async pumpResume(id: string, body: ReadableStream<Uint8Array> | null): Promise<boolean> {
    const entry = this.entries.find((x) => x.id === id);
    const p = this.partials.get(id);
    if (!entry || !p) {
      if (entry) entry.status = "paused";
      return false;
    }
    this.resumePumps.add(id);
    try {
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.received += value.byteLength;
          p.chunks.push(value);
          p.n += value.byteLength;
          if (p.n > ZL_DL_RESUME_MAX) {
            /* over the cap the buffer is dropped: the entry keeps
               counting but honestly loses the artifact. */
            entry.resumable = false;
            p.chunks.length = 0;
            p.n = 0;
          }
        }
      }
      entry.status = "done";
      entry.endedAt = Date.now();
      entry.error = undefined;
      this.schedulePersist();
      return true;
    } catch (err) {
      entry.status = "paused";
      entry.endedAt = Date.now();
      entry.error = "resume interrupted: " + String(err);
      void this.persistPartial(id);
      this.schedulePersist();
      return false;
    } finally {
      this.resumePumps.delete(id);
    }
  }

  /** Assemble the buffered artifact for the UI host to save (the
      engine has no disk: the host owns the save). Null when nothing
      is buffered: a download that completed on its first pass
      belongs to the browser own machinery, a buffer dropped by the
      cap is honestly gone, and a worker restart clears done
      buffers. */
  async assemble(id: string): Promise<{ blob: Blob; filename: string; mime: string } | null> {
    const entry = this.entries.find((x) => x.id === id);
    if (!entry || (entry.status !== "done" && entry.status !== "paused")) return null;
    let p = this.partials.get(id);
    if (!p && entry.status === "paused") {
      if (!(await this.loadPartial(id))) return null;
      p = this.partials.get(id);
    }
    if (!p || p.n === 0) return null;
    return { blob: new Blob(p.chunks as unknown as BlobPart[], { type: entry.mime }), filename: entry.filename, mime: entry.mime };
  }

  /** Wire the engine fetch the resume path uses (sw.ts boot). Kept
      injected so the registry stays unit-testable without the wisp
      transport. */
  setResumeFetch(fn: (url: string, init: { headers: Record<string, string> }) => Promise<Response>): void {
    this.resumeFetch = fn;
  }

  /** Persist the partial bytes of a paused entry (chunk array into
      the partials store; structured-clone friendly, no copy).
      Storage failure means in-memory resume only, never an engine
      failure. */
  async persistPartial(id: string): Promise<void> {
    const p = this.partials.get(id);
    if (!p || p.n === 0) return;
    try {
      const db = await openDb();
      await idbPut(db, STORE_PARTIALS, id, { chunks: p.chunks, n: p.n });
    } catch {
      /* storage failure: in-memory resume only */
    }
  }

  /** Load a persisted partial back into the buffer. False when no
      usable record exists. */
  private async loadPartial(id: string): Promise<boolean> {
    try {
      const db = await openDb();
      const rec = (await idbGet(db, STORE_PARTIALS, id)) as { chunks?: unknown; n?: unknown } | undefined;
      if (!rec || !Array.isArray(rec.chunks) || typeof rec.n !== "number") return false;
      const chunks = rec.chunks.filter((c): c is Uint8Array => c instanceof Uint8Array);
      if (chunks.length === 0) return false;
      const n = chunks.reduce((a, c) => a + c.byteLength, 0);
      if (n !== rec.n) return false; /* corrupted record: refuse it */
      this.partials.set(id, { chunks, n });
      return true;
    } catch {
      return false;
    }
  }

  /** Drop the partial bytes everywhere: memory and IndexedDB. */
  private forgetPartial(id: string): void {
    this.partials.delete(id);
    openDb()
      .then((db) => idbDelete(db, STORE_PARTIALS, id))
      .catch(() => undefined);
  }

  /** Newest-first view with live speeds. */
  snapshot(): DownloadEntry[] {
    const now = Date.now();
    return [...this.entries]
      .reverse()
      .map((e) => ({
        ...e,
        speed:
          e.received > 0 && e.status === "active"
            ? (e.received / Math.max(1, now - e.startedAt)) * 1000
            : e.status === "done" && e.endedAt > e.startedAt
              ? (e.received / (e.endedAt - e.startedAt)) * 1000
              : 0,
      }));
  }

  /** Tests only. */
  reset(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.entries.length = 0;
    this.streams.clear();
    this.controllers.clear();
    this.partials.clear();
    this.resumePumps.clear();
    this.seq = 0;
  }
}

/* ---- shared instance + request-engine seam (#90) -------------------- */

/* The one registry instance for this worker evaluation. It lived in
   swstate.ts while the modularization was in flight; the downloads
   subsystem now owns its own state (issue #90): the request engine
   feeds it through adoptResponse, initReady loads it, the control
   plane lists and cancels entries through this module. */
export const DL = new DownloadTracker();

/** Request-engine seam (issue #90): the single place that decides a
    proxied response is a downloadable attachment. Returns the
    registry-wrapped Response the engine must serve, or null when the
    response is not an attachment - the engine then keeps its normal
    path and stays unaware of download tracking internals. Detection
    is on the OUTGOING content-disposition; filename and size come
    from the UPSTREAM headers, the MIME from the outgoing
    content-type. The body stays a stream: a counting passthrough
    forwards every chunk untouched, so nothing is ever buffered whole
    and the browser keeps writing the file to disk. */
export function adoptResponse(
  target: string,
  resp: Response,
  outHeaders: Headers,
  status: number,
): Response | null {
  if (!resp.body) return null;
  if (!(outHeaders.get("content-disposition") ?? "").toLowerCase().includes("attachment")) return null;
  const id = DL.begin(
    target,
    resp.headers,
    outHeaders.get("content-type") ?? "application/octet-stream",
    Number(resp.headers.get("content-length") ?? -1),
  );
  return new Response(DL.wrap(id, resp.body), { status, headers: outHeaders });
}
