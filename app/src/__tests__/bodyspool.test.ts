import { afterEach, describe, expect, it } from "vitest";
import {
  setSpoolRootForTests,
  spoolBody,
  SpoolCapError,
  SpoolUnavailableError,
  type SpoolDir,
  type SpoolFileHandle,
  type SpoolRoot,
} from "../bodyspool";

/* #556: the OPFS replay spool, unit-gated against an in-memory fake
   of the handle surface bodyspool consumes. The real-Chromium
   acceptance (below-cap, over-cap, every redirect kind, hashes) is
   suite/e2e/replay-spool.mjs. */

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
};

/* openEnded keeps the source unclosed so a spool cleanup cancel is
   observable (a closed source never sees cancel). */
const streamOf = (
  chunks: Uint8Array[],
  record?: { cancelled?: boolean },
  openEnded = false,
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      if (!openEnded) c.close();
    },
    cancel() {
      if (record) record.cancelled = true;
    },
  });

/** Minimal in-memory OPFS fake: the same root/dir/file/writable shape
    bodyspool reads, plus test knobs (stale entries for the sweeper,
    a write failure after N writes). */
function fakeRoot(opts: { stale?: string[]; failWritesAfter?: number } = {}) {
  const files = new Map<string, Uint8Array[]>();
  const removed: string[] = [];
  const stale = new Set(opts.stale ?? []);
  for (const n of [...(opts.stale ?? []), "zl-fresh.body"]) files.set(n, []);
  const mkHandle = (name: string): SpoolFileHandle => ({
    async createWritable() {
      let parts: Uint8Array[] = [];
      let writes = 0;
      return {
        async write(c: Uint8Array) {
          writes++;
          if (opts.failWritesAfter !== undefined && writes > opts.failWritesAfter) {
            throw new Error("disk full");
          }
          parts.push(c);
        },
        async close() {
          files.set(name, parts);
          parts = [];
        },
        async abort() {
          parts = [];
        },
      };
    },
    async getFile() {
      const parts = files.get(name) ?? [];
      return new File(parts as unknown as BlobPart[], name, { lastModified: stale.has(name) ? Date.now() - 20 * 60 * 1000 : Date.now() });
    },
  });
  const dir: SpoolDir = {
    async getFileHandle(name: string) {
      if (!files.has(name)) files.set(name, []);
      return mkHandle(name);
    },
    async removeEntry(name: string) {
      files.delete(name);
      removed.push(name);
    },
    entries() {
      const names = [...files.keys()];
      return (async function* () {
        for (const n of names) yield [n, mkHandle(n)] as [string, SpoolFileHandle];
      })();
    },
  };
  const root: SpoolRoot = {
    async getDirectoryHandle() {
      return dir;
    },
  };
  return { root, files, removed };
}

afterEach(() => {
  setSpoolRootForTests(null);
});

describe("spoolBody (#556 replay spool)", () => {
  it("spools a stream to a replayable File with identical bytes, then release removes it", async () => {
    const fake = fakeRoot();
    setSpoolRootForTests(fake.root);
    const chunks = [enc("hello "), enc("zl-spool "), enc("bytes")];
    const h = await spoolBody(streamOf(chunks));
    expect(h.bytes).toBe(20);
    expect(h.file).toBeInstanceOf(File);
    const round = new Uint8Array(await h.file.arrayBuffer());
    expect(Array.from(round)).toEqual(Array.from(enc("hello zl-spool bytes")));
    expect(fake.files.size).toBeGreaterThan(0);
    await h.release();
    expect(fake.removed.length).toBe(1);
    await h.release();
    expect(fake.removed.length).toBe(1);
  });

  it("throws SpoolCapError over the cap, cancels the reader and deletes the partial file", async () => {
    const fake = fakeRoot();
    setSpoolRootForTests(fake.root);
    const rec = { cancelled: false };
    const big = [enc("0123456789"), enc("abcdefghij")];
    await expect(spoolBody(streamOf(big, rec, true), { cap: 10 })).rejects.toBeInstanceOf(SpoolCapError);
    expect(rec.cancelled).toBe(true);
    expect(fake.removed.length).toBe(1);
  });

  it("enforces the live budget across spools and returns it on release", async () => {
    const fake = fakeRoot();
    setSpoolRootForTests(fake.root);
    const first = await spoolBody(streamOf([enc("0123456789abcdef")]), { cap: 100, totalBudget: 20 });
    await expect(spoolBody(streamOf([enc("0123456789abcdef")]), { cap: 100, totalBudget: 20 })).rejects.toBeInstanceOf(SpoolCapError);
    await first.release();
    const second = await spoolBody(streamOf([enc("0123456789abcdef")]), { cap: 100, totalBudget: 20 });
    await second.release();
  });

  it("sweeps stale orphans but keeps fresh entries", async () => {
    const fake = fakeRoot({ stale: ["zl-old.body"] });
    setSpoolRootForTests(fake.root);
    const h = await spoolBody(streamOf([enc("x")]));
    expect(fake.removed).toContain("zl-old.body");
    expect(fake.removed).not.toContain("zl-fresh.body");
    await h.release();
  });

  it("surfaces SpoolUnavailableError before the first byte and leaves the stream intact", async () => {
    setSpoolRootForTests({
      async getDirectoryHandle() {
        throw new Error("quota denied");
      },
    });
    const stream = streamOf([enc("still-readable")]);
    await expect(spoolBody(stream)).rejects.toBeInstanceOf(SpoolUnavailableError);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value as Uint8Array)).toBe("still-readable");
  });

  it("fails honestly and cleans up when a write fails mid-spool", async () => {
    const fake = fakeRoot({ failWritesAfter: 1 });
    setSpoolRootForTests(fake.root);
    const rec = { cancelled: false };
    await expect(spoolBody(streamOf([enc("one"), enc("two")], rec, true))).rejects.toThrow("disk full");
    expect(rec.cancelled).toBe(true);
    expect(fake.removed.length).toBe(1);
  });

  it("a source dying mid-spool cleans up and frees the live budget", async () => {
    /* #556: cancellation/bounded-failure check - the partial file never
       outlives the failed request and the live budget is returned, so
       the failure cannot wedge later spools. (The reader cancel is a
       no-op on an already-errored stream, so only the file and budget
       bounds are observable here.) */
    const fake = fakeRoot();
    setSpoolRootForTests(fake.root);
    const dying = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc("first"));
        setTimeout(() => c.error(new Error("source died")), 0);
      },
    });
    await expect(spoolBody(dying, { cap: 100, totalBudget: 20 })).rejects.toThrow("source died");
    expect(fake.removed.length).toBe(1);
    /* the budget came back: an equal spool fits again immediately */
    const h = await spoolBody(streamOf([enc("0123456789abcdef")]), { cap: 100, totalBudget: 20 });
    await h.release();
  });

  it("rejects cleanly when no storage root exists at all", async () => {
    setSpoolRootForTests(null);
    await expect(spoolBody(streamOf([enc("x")]))).rejects.toBeInstanceOf(SpoolUnavailableError);
  });
});
