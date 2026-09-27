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
   - The registry is in-memory: it does not survive a service-worker
     restart, and finished entries are kept in a bounded ring. */

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
  status: "active" | "done" | "error" | "cancelled";
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

const RING = 200;

export class DownloadTracker {
  private readonly entries: DownloadEntry[] = [];
  private readonly streams = new Map<string, TransformStream<Uint8Array, Uint8Array>>();
  private seq = 0;

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
    });
    if (this.entries.length > RING) this.entries.shift();
    return id;
  }

  /** Wrap a response body in the counting passthrough. Streaming is
      preserved byte for byte: every chunk is forwarded the moment it
      arrives and never accumulated. */
  wrap(id: string, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const entry = this.entries.find((x) => x.id === id);
    const ts = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        if (entry && entry.status === "active") entry.received += chunk.byteLength;
        ctrl.enqueue(chunk);
      },
      flush() {
        if (entry && entry.status === "active") {
          entry.status = "done";
          entry.endedAt = Date.now();
        }
      },
    });
    this.streams.set(id, ts);
    /* The moment the page stops reading (user cancels in the browser
       UI), the underlying stream cancels: mark, do not pretend. */
    void body.pipeTo(ts.writable, {
      preventCancel: false,
    }).catch(() => {
      if (entry && entry.status === "active") {
        entry.status = "error";
        entry.endedAt = Date.now();
        entry.error = "stream failed";
      }
    }).finally(() => {
      this.streams.delete(id);
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
    }
    if (ts) {
      ts.writable.abort(new Error("cancelled")).catch(() => undefined);
      this.streams.delete(id);
      return true;
    }
    return Boolean(entry && entry.status === "cancelled");
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
    this.entries.length = 0;
    this.streams.clear();
    this.seq = 0;
  }
}
