/// <reference lib="webworker" />
/* #556: OPFS-backed bounded spool for replaying large streamed request
   bodies across redirect hops. The hop chain buffers a stream body
   once (32 MiB cap) so 307/308 POSTs follow like a real browser; an
   over-cap body rides Origin Private File System storage instead of
   memory (default since the #556 follow-up, zl:config spoolUploads
   false is the opt-out): the stream is written once to a per-request
   file and the File handle replays on every hop with no full in-memory
   copy (the vendored transport accepts Blob bodies).

   Hard budgets, fail-honest:
   - per request: REPLAY_SPOOL_CAP (256 MiB). Overflow deletes the
     partial file, cancels the reader, and throws: the stream is
     consumed at that point, so the caller must fail the request
     honestly instead of serving a truncated body.
   - across concurrent spools: TOTAL_SPOOL_BUDGET (512 MiB) enforced
     per chunk; a request that would push the live total over the
     budget fails the same honest way.
   - orphans: a worker killed mid-chain leaves a file behind; the
     next spool sweeps entries older than SPOOL_SWEEP_AGE_MS (best
     effort, bounded per sweep).

   Storage failure BEFORE the first byte is read surfaces as
   SpoolUnavailableError so the caller keeps the documented one-shot
   streaming behavior for a body it still owns intact; every failure
   after the first byte is fatal for the request. Upload bytes reach
   persistent storage only through this spool path; a deployment that
   refuses it turns it off worker-side (request.ts gates on
   spoolUploadsEnabled(), default on). Unit-gated in
   __tests__/bodyspool.test.ts through the injected root; the
   real-Chromium acceptance is suite/e2e/replay-spool.mjs. */

export const REPLAY_SPOOL_CAP = 256 * 1024 * 1024;
export const TOTAL_SPOOL_BUDGET = 512 * 1024 * 1024;
const SPOOL_DIR = "zl-replay-spool";
const SPOOL_SWEEP_AGE_MS = 10 * 60 * 1000;
const SPOOL_SWEEP_MAX = 64;

/* Storage root seam: production reads the OPFS entry point; tests
   inject an in-memory fake with the same handle shape. */
export interface SpoolRoot {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<SpoolDir>;
}
export interface SpoolDir {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<SpoolFileHandle>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, SpoolFileHandle]>;
}
export interface SpoolFileHandle {
  createWritable(): Promise<SpoolWritable>;
  getFile(): Promise<File>;
}
export interface SpoolWritable {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

let rootOverride: SpoolRoot | null = null;
export function setSpoolRootForTests(root: SpoolRoot | null): void {
  rootOverride = root;
}

async function spoolRoot(): Promise<SpoolRoot | null> {
  if (rootOverride) return rootOverride;
  try {
    const st = (globalThis as unknown as { navigator?: { storage?: { getDirectory?: () => Promise<SpoolRoot> } } }).navigator?.storage;
    if (typeof st?.getDirectory === "function") return await st.getDirectory();
  } catch {
    /* storage unavailable: the caller keeps the one-shot behavior */
  }
  return null;
}

export class SpoolUnavailableError extends Error {}
export class SpoolCapError extends Error {}

let liveSpooledBytes = 0;
let spoolSeq = 0;

/** Best-effort orphan sweep: a worker restart mid-chain leaves files
    behind; entries older than the sweep age are removed. Bounded per
    call so a large orphan set cannot stall a request. */
async function sweepOrphans(dir: SpoolDir): Promise<void> {
  const now = Date.now();
  const victims: string[] = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      const f = await handle.getFile().catch(() => null);
      if (f && now - f.lastModified > SPOOL_SWEEP_AGE_MS) victims.push(name);
      if (victims.length >= SPOOL_SWEEP_MAX) break;
    }
    for (const v of victims) await dir.removeEntry(v).catch(() => undefined);
  } catch {
    /* best effort only */
  }
}

export interface SpoolHandle {
  /** The spooled bytes as a File: replayable on every hop with no
      in-memory copy. */
  file: File;
  bytes: number;
  /** Remove the spool file and return its live budget. Idempotent. */
  release(): Promise<void>;
}

/** Write the whole stream to one OPFS file, bounded. Throws
    SpoolUnavailableError before consuming anything when storage is
    absent; throws after cleanup once the cap or the live budget is
    exceeded or a write fails, because the stream is then consumed
    and the caller must fail honestly. */
export async function spoolBody(
  stream: ReadableStream<Uint8Array>,
  opts: { cap?: number; totalBudget?: number } = {},
): Promise<SpoolHandle> {
  const cap = opts.cap ?? REPLAY_SPOOL_CAP;
  const budget = opts.totalBudget ?? TOTAL_SPOOL_BUDGET;
  const root = await spoolRoot();
  if (!root) throw new SpoolUnavailableError("no OPFS storage root for the replay spool");
  let dir: SpoolDir;
  let fh: SpoolFileHandle;
  let writable: SpoolWritable;
  let name = "";
  try {
    dir = await root.getDirectoryHandle(SPOOL_DIR, { create: true });
    await sweepOrphans(dir);
    name = "zl-" + Date.now() + "-" + (spoolSeq++) + ".body";
    fh = await dir.getFileHandle(name, { create: true });
    writable = await fh.createWritable();
  } catch (err) {
    /* Storage failed before a byte was read: the caller still owns
       an intact stream and keeps the documented one-shot behavior. */
    throw new SpoolUnavailableError("replay spool unavailable: " + String(err));
  }
  const reader = stream.getReader();
  let total = 0;
  const cleanup = async (): Promise<void> => {
    try {
      await writable.abort?.();
    } catch {
      /* already closed or gone */
    }
    try {
      await reader.cancel();
    } catch {
      /* already consumed or errored */
    }
    await dir.removeEntry(name).catch(() => undefined);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new SpoolCapError("replay spool cap exceeded at " + total + " of " + cap + " bytes");
      if (liveSpooledBytes + total > budget) throw new SpoolCapError("replay spool live budget exceeded at " + total + " bytes");
      await writable.write(value);
    }
    await writable.close();
  } catch (err) {
    await cleanup();
    throw err;
  }
  let file: File;
  try {
    file = await fh.getFile();
  } catch (err) {
    await cleanup();
    throw err;
  }
  liveSpooledBytes += total;
  let released = false;
  return {
    file,
    bytes: total,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      liveSpooledBytes -= total;
      await dir.removeEntry(name).catch(() => undefined);
    },
  };
}
