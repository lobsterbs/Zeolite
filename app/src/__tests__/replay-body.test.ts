import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #155: the upstreamFetch choke point buffers a POST body that
   arrives as a ReadableStream exactly once, so the relay can carry
   it (#137 accepts string/ArrayBuffer only) and the transport retry
   (#74) replays it instead of dying on a disturbed stream.

   The hop-level #556 cases below drive the real handleFetch loop, so
   the two browser-bound modules request.ts pulls are mocked the same
   way request.test.ts mocks the transport: the vendored bundle is a
   browser/wasm artifact (its absence is exactly why this file could
   not collect before), and the wasm rewriter is irrelevant to the
   redirect-replay contract under test - the stubs pass bodies through
   untouched. */

const hopMock = vi.hoisted(() => ({
  urls: [] as string[],
  inits: [] as Array<{ method?: string; headers?: Headers; body?: unknown } | undefined>,
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init?: { method?: string; headers?: Headers; body?: unknown }) => {
      hopMock.urls.push(url);
      /* snapshot: the hop loop mutates one shared Headers object */
      hopMock.inits.push(init ? { method: init.method, headers: new Headers(init.headers), body: init.body } : undefined);
      const queued = hopMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

vi.mock("../transform", () => ({
  isHtml: () => false,
  isCss: () => false,
  isJs: () => false,
  boundedBody: async () => ({ head: new Uint8Array(0), rest: null }),
  passthroughStream: () => new ReadableStream({ start: (c) => c.close() }),
  rawFrom: () => new ReadableStream({ start: (c) => c.close() }),
  rewriteStream: (body: unknown) => body,
  cssRewriteStream: (body: unknown) => body,
  rewriteJsBody: async (src: string) => src,
  scriptPinsOrigins: async () => null,
  workerPrelude: async () => "",
}));

import { handleFetch, replayCapTrips, replayableInit, spoolTransportCopy } from "../request";
import { DIAG } from "../diag";
import { encodeDestLegacy } from "../codec";
import { setReplayCapMb, setSpoolUploads, spoolUploadsEnabled } from "../swstate";
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

  it("falls back to one-shot streaming with an explicit DIAG event when storage is unavailable", async () => {
    setSpoolRootForTests(null);
    const init = {
      method: "POST",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      body: streamOf(["hello"]),
    };
    const before = DIAG.snapshot(0).events.length;
    const out = await replayableInit(init, { hopReplay: true, spoolAuthorized: true });
    expect(out).toBe(init);
    const events = DIAG.snapshot(0).events.slice(before);
    /* the fallback is recorded, never silent (#556 honesty layer) */
    expect(events.some((e) => /replay spool unavailable/.test(e.message))).toBe(true);
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

/* #556 follow-up: the spool is the default upload-replay path, so the
   hop LOOP (not only replayableInit) must follow over-cap redirects
   with byte-identical replay. These cases drive the real handleFetch
   hop chain against the in-memory spool root; the cap is tightened so
   the unit stays fast (the 32 MiB default is covered by the e2e
   suite). */
describe("hop loop replays over-cap spooled bodies (#556 follow-up)", () => {
  const ORIGIN = "https://w.example.org";
  const HALF = 512 * 1024;

  /* deterministic 1.5 MiB pattern: an announced content-length over the
     tightened 1 MiB cap, which is also the real page-traffic shape
     once Chromium's missing Content-Length is taken into account */
  const pattern = (n: number): Uint8Array => {
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = (i * 7 + 13) & 255;
    return u8;
  };
  const N = HALF * 3;

  const sha256 = async (b: unknown): Promise<string> => {
    const bytes = b instanceof ArrayBuffer ? new Uint8Array(b) : (b as Uint8Array);
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, "0")).join("");
  };

  const mkPostEvent = (target: string, body: unknown, headers: Headers) => {
    const armed: Promise<Response>[] = [];
    const awaited: Promise<unknown>[] = [];
    const ev = {
      request: {
        url: ORIGIN + encodeDestLegacy(target),
        method: "POST",
        mode: "navigate",
        destination: "document",
        credentials: "same-origin",
        referrer: "",
        body,
        headers,
      },
      clientId: "spool-hop",
      resultingClientId: "spool-hop-new",
      respondWith: (p: Promise<Response>) => void armed.push(p),
      waitUntil: (p: Promise<unknown>) => void awaited.push(p),
    } as unknown as FetchEvent;
    return { ev, armed, awaited };
  };

  beforeEach(() => {
    hopMock.urls = [];
    hopMock.inits = [];
    hopMock.queue = [];
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
    });
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("no cache storage");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setReplayCapMb(32);
    setSpoolRootForTests(null);
    setSpoolUploads(true);
  });

  const runTwoHops = async (code: 307 | 308) => {
    setReplayCapMb(1);
    setSpoolUploads(true);
    setSpoolRootForTests(spoolTestRoot());
    const expected = await sha256(pattern(N));
    hopMock.queue = [
      new Response(null, { status: code, headers: { location: "https://site.example/next" } }),
      new Response(null, { status: code, headers: { location: "https://site.example/final" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed, awaited } = mkPostEvent(
      "https://site.example/upload",
      streamOf([pattern(HALF), pattern(HALF), pattern(HALF)]),
      new Headers({ "content-length": String(N), "content-type": "application/octet-stream" }),
    );
    handleFetch(ev);
    const served = await armed[0]!;
    /* settle the fetch-event lifetime: the spool release rides waitUntil */
    await Promise.allSettled(awaited);
    expect(served.status).toBe(200);
    expect(hopMock.urls).toEqual([
      "https://site.example/upload",
      "https://site.example/next",
      "https://site.example/final",
    ]);
    expect(hopMock.inits.map((i) => i?.method)).toEqual(["POST", "POST", "POST"]);
    /* every re-issue carried the full spooled body, byte-identical:
       the announced length was replaced by the spooled truth */
    for (const init of hopMock.inits) {
      expect(init?.body).toBeInstanceOf(ArrayBuffer);
      expect(await sha256(init?.body)).toBe(expected);
      expect((init?.body as ArrayBuffer).byteLength).toBe(N);
    }
  };

  it("follows an over-cap announced 307 through two hops with body-hash equality", async () => {
    await runTwoHops(307);
  });

  it("follows an over-cap announced 308 through two hops with body-hash equality", async () => {
    await runTwoHops(308);
  });

  it("the spool authorization is on by default (the opt-out is the zl:config false)", () => {
    expect(spoolUploadsEnabled()).toBe(true);
  });
});
