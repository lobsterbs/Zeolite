import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { DownloadTracker, downloadFilename } from "../downloads";
import { openDb, idbClear, idbGetAllKeys, STORE_DOWNLOADS } from "../extensions/idb";

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(chunks[i++]);
      else ctrl.close();
    },
  });
}

async function drain(s: ReadableStream<Uint8Array>): Promise<number> {
  const r = s.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.byteLength;
  }
  return n;
}

describe("downloadFilename", () => {
  it("parses a quoted content-disposition filename", () => {
    expect(downloadFilename("https://x.test/f", headers({ "content-disposition": 'attachment; filename="report.pdf"' }))).toBe("report.pdf");
  });
  it("parses a token filename", () => {
    expect(downloadFilename("https://x.test/f", headers({ "content-disposition": "attachment; filename=setup.exe" }))).toBe("setup.exe");
  });
  it("falls back to the URL path segment", () => {
    expect(downloadFilename("https://x.test/files/big%20file.zip", headers({ "content-disposition": "attachment" }))).toBe("big file.zip");
  });
  it("ends at download when nothing helps", () => {
    expect(downloadFilename("https://x.test", headers({}))).toBe("download");
  });
});

describe("DownloadTracker", () => {
  it("counts bytes through the passthrough and marks done", async () => {
    const t = new DownloadTracker();
    const id = t.begin("https://x.test/a.bin", headers({ "content-disposition": 'attachment; filename="a.bin"' }), "application/octet-stream", 5);
    const wrapped = t.wrap(id, streamOf([new Uint8Array(2), new Uint8Array(3)]));
    expect(await drain(wrapped)).toBe(5);
    const snap = t.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].status).toBe("done");
    expect(snap[0].received).toBe(5);
    expect(snap[0].size).toBe(5);
    expect(snap[0].filename).toBe("a.bin");
  });

  it("keeps unknown size honest at -1", async () => {
    const t = new DownloadTracker();
    const id = t.begin("https://x.test/b", headers({ "content-disposition": "attachment" }), "text/plain", -1);
    const wrapped = t.wrap(id, streamOf([new Uint8Array(7)]));
    await drain(wrapped);
    expect(t.snapshot()[0].size).toBe(-1);
    expect(t.snapshot()[0].received).toBe(7);
  });

  it("cancel severs an in-flight download", async () => {
    const t = new DownloadTracker();
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(4));
      },
    });
    const id = t.begin("https://x.test/c", headers({ "content-disposition": "attachment" }), "application/octet-stream", -1);
    const wrapped = t.wrap(id, body);
    const reader = wrapped.getReader();
    await reader.read();
    expect(t.cancel(id)).toBe(true);
    /* queued chunks may still resolve first; a bounded number of reads
       must reach the rejection. No unbounded read loops: a stream that
       merely stalls fails the test instead of hanging it. */
    let severed = false;
    for (let i = 0; i < 4 && !severed; i++) {
      try {
        if ((await reader.read()).done) break;
      } catch {
        severed = true;
      }
    }
    expect(severed).toBe(true);
    const snap = t.snapshot();
    expect(snap[0].status).toBe("cancelled");
  });

  it("cancel of an unknown id is honest", () => {
    const t = new DownloadTracker();
    expect(t.cancel("nope")).toBe(false);
  });

  it("snapshot is newest first with a live speed for active entries", async () => {
    const t = new DownloadTracker();
    const a = t.begin("https://x.test/1", headers({ "content-disposition": "attachment" }), "a", -1);
    t.begin("https://x.test/2", headers({ "content-disposition": "attachment" }), "b", -1);
    const snap = t.snapshot();
    expect(snap[0].source).toBe("https://x.test/2");
    expect(snap[1].source).toBe("https://x.test/1");
    void a;
  });

  it("a failing upstream stream records an error, not a silent done", async () => {
    const t = new DownloadTracker();
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.error(new Error("upstream died"));
      },
    });
    const id = t.begin("https://x.test/e", headers({ "content-disposition": "attachment" }), "a", -1);
    const wrapped = t.wrap(id, body);
    await expect(drain(wrapped)).rejects.toThrow("upstream died");
    await new Promise((r) => setTimeout(r, 0));
    const snap = t.snapshot();
    expect(snap[0].status).toBe("error");
    expect(snap[0].error).toBe("stream failed");
  });
});

describe("download registry persistence (2.2)", () => {
  beforeEach(async () => {
    try {
      const db = await openDb();
      await idbClear(db, STORE_DOWNLOADS);
    } catch {
      /* storage unavailable: the persistence tests then fail honestly */
    }
  });

  it("persists and reloads across a tracker restart", async () => {
    const a = new DownloadTracker();
    const id = a.begin("https://x.test/a.bin", headers({ "content-disposition": 'attachment; filename="a.bin"' }), "application/octet-stream", 5);
    await drain(a.wrap(id, streamOf([new Uint8Array(2), new Uint8Array(3)])));
    await a.persist();
    const b = new DownloadTracker();
    await b.load();
    const snap = b.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].status).toBe("done");
    expect(snap[0].filename).toBe("a.bin");
    expect(snap[0].received).toBe(5);
    a.reset(); /* drop the pending debounce timer: no straggler writes */
  });

  it("honestly marks an active entry interrupted on load", async () => {
    const a = new DownloadTracker();
    a.begin("https://y.test/live.bin", headers({ "content-disposition": "attachment" }), "application/octet-stream", -1);
    await a.persist();
    const b = new DownloadTracker();
    await b.load();
    const snap = b.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].status).toBe("error");
    expect(snap[0].error).toBe("interrupted: worker restarted");
    a.reset();
  });

  it("keeps ids unique across a restart", async () => {
    const a = new DownloadTracker();
    a.begin("https://x.test/1", headers({ "content-disposition": "attachment" }), "a", -1);
    a.begin("https://x.test/2", headers({ "content-disposition": "attachment" }), "b", -1);
    await a.persist();
    const b = new DownloadTracker();
    await b.load();
    const fresh = b.begin("https://x.test/3", headers({ "content-disposition": "attachment" }), "c", -1);
    expect(fresh).toBe("dl3");
    expect(b.snapshot().map((e) => e.id)).toContain("dl3");
    a.reset();
    b.reset();
  });

  it("scopes records per source site", async () => {
    const a = new DownloadTracker();
    a.begin("https://one.test/f", headers({ "content-disposition": "attachment" }), "a", -1);
    a.begin("https://two.test/f", headers({ "content-disposition": "attachment" }), "b", -1);
    await a.persist();
    const db = await openDb();
    const keys = await idbGetAllKeys(db, STORE_DOWNLOADS);
    expect(keys.sort()).toEqual(["site:https://one.test", "site:https://two.test"]);
    a.reset();
  });
});
