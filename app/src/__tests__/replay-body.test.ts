import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

/* #155: the upstreamFetch choke point buffers a POST body that
   arrives as a ReadableStream exactly once, so the relay can carry
   it (#137 accepts string/ArrayBuffer only) and the transport retry
   (#74) replays it instead of dying on a disturbed stream. */

import { replayCapTrips, replayableInit, spoolTransportCopy } from "../request";
import { setReplayCapMb } from "../swstate";
import { setSpoolRootForTests, type SpoolDir, type SpoolFileHandle, type SpoolRoot } from "../bodyspool";

const streamOf = (chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });

describe("replayableInit (#155 stream-body buffering)", () => {
  it("buffers a stream body once into the identical bytes", async () => {
    const out = await replayableInit({
      method: "POST",
      headers: new Headers({ "content-type": "application/json", "content-length": "7" }),
      body: streamOf(['{"a":', "1}"]),
    });
    expect(out.body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(out.body as ArrayBuffer)).toBe('{"a":1}');
    expect(out.method).toBe("POST");
    expect(out.headers.get("content-type")).toBe("application/json");
  });

  it("is idempotent on an already-buffered body (the retry shape)", async () => {
    const buf = new TextEncoder().encode("abc");
    const init = { method: "POST", headers: new Headers(), body: buf.buffer as BodyInit };
    const out = await replayableInit(init);
    expect(out).toBe(init);
  });

  it("passes string and empty bodies through untouched", async () => {
    const s = { method: "POST", headers: new Headers(), body: "x=1" };
    expect(await replayableInit(s)).toBe(s);
    const e = { method: "GET", headers: new Headers(), body: undefined };
    expect(await replayableInit(e)).toBe(e);
  });

  it("keeps an announced oversized body streaming (no buffering)", async () => {
    const init = {
      method: "POST",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      body: streamOf(["hello"]),
    };
    const out = await replayableInit(init);
    expect(out).toBe(init);
    const reader = (out.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value as Uint8Array)).toBe("hello");
  });

  /* 2026-10-14 report: buffer only when a replay path can fire. */
  it("unannounced stream with no relay: passes through untouched (chunked/duplex class)", async () => {
    const init = {
      method: "POST",
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: streamOf(["partial"]),
    };
    const out = await replayableInit(init, { relayPossible: false });
    expect(out).toBe(init);
  });

  it("unannounced stream with a relay rule: buffered (the relay carries string/ArrayBuffer only)", async () => {
    const out = await replayableInit(
      {
        method: "POST",
        headers: new Headers(),
        body: streamOf(["a", "b"]),
      },
      { relayPossible: true },
    );
    expect(out.body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(out.body as ArrayBuffer)).toBe("ab");
  });

  it("announced small body still buffers (the connect-class retry can replay it)", async () => {
    const out = await replayableInit({
      method: "POST",
      headers: new Headers({ "content-length": "2" }),
      body: streamOf(["hi"]),
    });
    expect(out.body).toBeInstanceOf(ArrayBuffer);
  });

  it("the cap is counted, not silent", async () => {
    const before = replayCapTrips();
    const big = {
      method: "POST",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      body: streamOf(["hello"]),
    };
    expect(await replayableInit(big)).toBe(big);
    expect(replayCapTrips()).toBe(before + 1);
    await expect(
      replayableInit(
        {
          method: "POST",
          headers: new Headers(),
          body: streamOf([new Uint8Array(33 * 1024 * 1024).fill(1)]),
        },
        { relayPossible: true },
      ),
    ).rejects.toThrow("replay buffer cap");
    expect(replayCapTrips()).toBe(before + 2);
  });
});

/* #556: the host-authorized OPFS spool branch of replayableInit.
   Only the hop path spools (the relay keeps its string/ArrayBuffer
   contract); the fake root mirrors the real handle surface. */
function spoolTestRoot(): SpoolRoot {
  const files = new Map<string, Uint8Array[]>();
  const mkHandle = (name: string): SpoolFileHandle => ({
    async createWritable() {
      let parts: Uint8Array[] = [];
      return {
        async write(c: Uint8Array) {
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
      return new File(parts as unknown as BlobPart[], name, { lastModified: Date.now() });
    },
  });
  const dir: SpoolDir = {
    async getFileHandle(name: string) {
      if (!files.has(name)) files.set(name, []);
      return mkHandle(name);
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
    entries() {
      const names = [...files.keys()];
      return (async function* () {
        for (const n of names) yield [n, mkHandle(n)] as [string, SpoolFileHandle];
      })();
    },
  };
  return {
    async getDirectoryHandle() {
      return dir;
    },
  };
}

describe("replayableInit spool branch (#556 hop replay)", () => {
  afterEach(() => {
    setSpoolRootForTests(null);
  });

  it("spools an announced over-cap body for an authorized hop replay and corrects the length", async () => {
    setSpoolRootForTests(spoolTestRoot());
    const out = await replayableInit(
      {
        method: "POST",
        headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
        body: streamOf(["hello"]),
      },
      { hopReplay: true, spoolAuthorized: true },
    );
    expect(out.body).toBeInstanceOf(File);
    expect(out.spool).toBeDefined();
    /* the announced length is replaced by the spooled truth */
    expect(out.headers.get("content-length")).toBe("5");
    const bytes = new Uint8Array(await (out.body as File).arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    await out.spool!.release();
  });

  it("keeps the documented one-shot streaming when the spool is not authorized", async () => {
    const init = {
      method: "POST",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      body: streamOf(["hello"]),
    };
    const out = await replayableInit(init, { hopReplay: true });
    expect(out).toBe(init);
  });

  it("falls back to one-shot streaming when storage is unavailable", async () => {
    setSpoolRootForTests(null);
    const init = {
      method: "POST",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      body: streamOf(["hello"]),
    };
    const out = await replayableInit(init, { hopReplay: true, spoolAuthorized: true });
    expect(out).toBe(init);
  });

  it("spools an unannounced hop-replay body without adding a content-length", async () => {
    setSpoolRootForTests(spoolTestRoot());
    const out = await replayableInit(
      { method: "POST", headers: new Headers(), body: streamOf(["chunked"]) },
      { hopReplay: true, spoolAuthorized: true },
    );
    expect(out.body).toBeInstanceOf(File);
    expect(out.headers.get("content-length")).toBeNull();
    const bytes = new Uint8Array(await (out.body as File).arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("chunked");
    await out.spool!.release();
  });

  it("relay-only unannounced body still buffers in memory (no spool)", async () => {
    setSpoolRootForTests(spoolTestRoot());
    const out = await replayableInit(
      { method: "POST", headers: new Headers(), body: streamOf(["ab"]) },
      { relayPossible: true, spoolAuthorized: true },
    );
    expect(out.body).toBeInstanceOf(ArrayBuffer);
    expect(out.spool).toBeUndefined();
  });
});

describe("replayableInit configured cap (zl:config replayCapMb, #556)", () => {
  afterEach(() => {
    setReplayCapMb(32);
    setSpoolRootForTests(null);
  });

  it("fails honestly on an over-cap unannounced body at the tightened cap instead of buffering", async () => {
    setReplayCapMb(1);
    await expect(
      replayableInit(
        {
          method: "POST",
          headers: new Headers(),
          body: streamOf(["a".repeat(512 * 1024), "b".repeat(512 * 1024 + 1)]),
        },
        { hopReplay: true },
      ),
    ).rejects.toThrow("request body exceeds the replay buffer cap");
  });

  it("spools an over-cap body at the tightened cap when the host authorized the spool", async () => {
    setReplayCapMb(1);
    setSpoolRootForTests(spoolTestRoot());
    const out = await replayableInit(
      { method: "POST", headers: new Headers(), body: streamOf(["a".repeat(700 * 1024)]) },
      { hopReplay: true, spoolAuthorized: true },
    );
    expect(out.body).toBeInstanceOf(File);
    expect(out.spool).toBeDefined();
    expect(out.spool!.bytes).toBe(700 * 1024);
    await out.spool!.release();
  });
});

describe("spoolTransportCopy (#556 hop transport body)", () => {
  afterEach(() => {
    setSpoolRootForTests(null);
  });

  it("materializes the spooled replay source as a byte-exact ArrayBuffer", async () => {
    setSpoolRootForTests(spoolTestRoot());
    const out = await replayableInit(
      { method: "POST", headers: new Headers(), body: streamOf(["hello", "-" , "spool"]) },
      { hopReplay: true, spoolAuthorized: true },
    );
    expect(out.spool).toBeDefined();
    const buf = await spoolTransportCopy(out.spool!);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe("hello-spool".length);
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe("hello-spool");
    await out.spool!.release();
  });

  it("throws the honest error before reading when the spooled body exceeds the transport bound", async () => {
    const before = replayCapTrips();
    const handle = {
      file: new File(["x"], "x.body"),
      bytes: 8 * 1024 * 1024 + 1,
      release: async () => {},
    };
    await expect(spoolTransportCopy(handle)).rejects.toThrow(
      "spooled body exceeds the transport body bound"
    );
    expect(replayCapTrips()).toBe(before + 1);
  });
});
