import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { DL, DownloadTracker, adoptResponse, downloadFilename } from "../downloads";
import { openDb, idbClear, idbGetAllKeys, idbPut, STORE_DOWNLOADS } from "../extensions/idb";

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

  it("ring overflow keeps live streams registered and drops idle entries instead (#25)", async () => {
    const t = new DownloadTracker();
    const live = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(4));
      },
    });
    const liveId = t.begin("https://x.test/live", headers({ "content-disposition": "attachment" }), "a", -1);
    const reader = t.wrap(liveId, live).getReader();
    await reader.read(); /* one chunk in, stream still open */
    for (let i = 1; i < 200; i++) {
      t.begin("https://x.test/idle" + i, headers({ "content-disposition": "attachment" }), "a", -1);
    }
    const lastId = t.begin("https://x.test/last", headers({ "content-disposition": "attachment" }), "a", -1);
    const snap = t.snapshot();
    expect(snap).toHaveLength(200);
    expect(snap.some((e) => e.id === liveId)).toBe(true);
    expect(snap.some((e) => e.id === "dl2")).toBe(false); /* oldest idle evicted */
    expect(snap.some((e) => e.id === lastId)).toBe(true);
    t.cancel(liveId); /* sever so pipeTo settles */
    await new Promise((r) => setTimeout(r, 0));
    t.reset();
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

  it("skips corrupted stored entries instead of poisoning the registry (#26)", async () => {
    const db = await openDb();
    await idbPut(db, STORE_DOWNLOADS, "site:https://bad.test", [
      { id: "dl1", source: "https://bad.test/x", startedAt: "not-a-number", status: "invalid" },
      { id: 42, source: "https://bad.test/y", status: "done" },
    ]);
    await idbPut(db, STORE_DOWNLOADS, "site:https://good.test", [
      { id: "dl2", filename: "g.bin", mime: "application/octet-stream", size: 5, received: 5, startedAt: Date.now(), endedAt: Date.now(), status: "done", source: "https://good.test/g", speed: 0 },
    ]);
    const t = new DownloadTracker();
    await t.load();
    const snap = t.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe("dl2");
    expect(Number.isFinite(snap[0].speed)).toBe(true);
    t.reset();
  });
});

describe("adoptResponse seam (#90)", () => {
  it("adopts attachment responses into the shared registry", async () => {
    DL.reset();
    const resp = new Response(streamOf([new Uint8Array(10), new Uint8Array(15)]), {
      status: 200,
      headers: headers({ "content-disposition": 'attachment; filename="big.bin"', "content-length": "25" }),
    });
    const outHeaders = new Headers({
      "content-disposition": 'attachment; filename="big.bin"',
      "content-type": "application/octet-stream",
    });
    const adopted = adoptResponse("https://x.test/big.bin", resp, outHeaders, 200);
    expect(adopted).not.toBeNull();
    expect(adopted!.status).toBe(200);
    expect(adopted!.headers.get("content-type")).toBe("application/octet-stream");
    expect(await drain(adopted!.body as ReadableStream<Uint8Array>)).toBe(25);
    const snap = DL.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].filename).toBe("big.bin");
    expect(snap[0].size).toBe(25);
    expect(snap[0].received).toBe(25);
    expect(snap[0].status).toBe("done");
    DL.reset();
  });

  it("leaves non-attachment and bodyless responses on the normal path", () => {
    DL.reset();
    const inline = new Response("hello", { status: 200, headers: headers({ "content-disposition": "inline" }) });
    expect(adoptResponse("https://x.test/a", inline, new Headers({ "content-disposition": "inline" }), 200)).toBeNull();
    const attachNoBody = new Response(null, { status: 200, headers: headers({ "content-disposition": "attachment" }) });
    expect(adoptResponse("https://x.test/b", attachNoBody, new Headers({ "content-disposition": "attachment" }), 200)).toBeNull();
    expect(DL.snapshot()).toHaveLength(0);
    DL.reset();
  });

  it("streams a large download chunk-by-chunk with live progress and headers intact", async () => {
    DL.reset();
    /* 4 MiB in 64 KiB chunks: many chunks, each forwarded the moment
       it arrives - nothing buffered whole. Progress stays live and
       the engine's outgoing headers (cookies included) are served
       untouched (#90 acceptance: large downloads, progress, cookies). */
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 64; i++) chunks.push(chunk);
    const total = 64 * 1024 * 64;
    const resp = new Response(streamOf(chunks), {
      status: 200,
      headers: headers({ "content-disposition": "attachment", "content-length": String(total) }),
    });
    const outHeaders = new Headers({
      "content-disposition": "attachment",
      "content-type": "application/octet-stream",
      "set-cookie": "sid=abc; Path=/; Secure",
    });
    const adopted = adoptResponse("https://x.test/huge.bin", resp, outHeaders, 200);
    expect(adopted).not.toBeNull();
    expect(adopted!.headers.get("set-cookie")).toBe("sid=abc; Path=/; Secure");
    const reader = (adopted!.body as ReadableStream<Uint8Array>).getReader();
    let n = 0;
    let sawActive = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      const snap = DL.snapshot();
      /* chunk-forwarded: the counter is at or past what the page read */
      expect(snap[0].received).toBeGreaterThanOrEqual(n);
      if (snap[0].status === "active") sawActive = true;
    }
    expect(n).toBe(total);
    expect(sawActive).toBe(true);
    const snap = DL.snapshot();
    expect(snap[0].status).toBe("done");
    expect(snap[0].received).toBe(total);
    DL.reset();
  });

  it("cancels a seam-adopted download through the registry", async () => {
    DL.reset();
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new Uint8Array(4));
      },
    });
    const resp = new Response(body, { status: 200, headers: headers({ "content-disposition": "attachment" }) });
    const adopted = adoptResponse(
      "https://x.test/cancel.bin",
      resp,
      new Headers({ "content-disposition": "attachment", "content-type": "application/octet-stream" }),
      200,
    )!;
    const reader = (adopted.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const id = DL.snapshot()[0].id;
    expect(DL.cancel(id)).toBe(true);
    /* queued chunks may still resolve first; a bounded number of reads
       must reach the rejection, same contract as the tracker tests. */
    let severed = false;
    for (let i = 0; i < 4 && !severed; i++) {
      try {
        if ((await reader.read()).done) break;
      } catch {
        severed = true;
      }
    }
    expect(severed).toBe(true);
    expect(DL.snapshot()[0].status).toBe("cancelled");
    DL.reset();
  });
});
