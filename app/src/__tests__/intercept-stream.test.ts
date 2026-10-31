import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Issue #552: the interception response kind gains a streaming
   transform arm next to the buffered one. The engine pipes the raw
   body through the handler-declared TransformStream with native
   backpressure and enforces the declared bounds with its own guards.
   These tests pin the pure contracts (precedence, guards) and the
   full fetch path: unknown content-length, oversized bodies, slow
   consumers, cancellation, upstream errors, chunk boundaries, and
   every fail-open rule. The transport is mocked like
   script-honesty.test.ts. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      transportMock.calls++;
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

vi.mock("../transform", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    scriptPinsOrigins: async () => false,
    rewriteJsBody: async (src: string) => src,
    cssRewriteStream: (body: ReadableStream<Uint8Array>) => body,
    rewriteStream: (body: ReadableStream<Uint8Array>) => body,
    workerPrelude: async () => "/* prelude stub */",
  };
});

import { handleFetch, routeReady, zlStreamGuards } from "../request";
import {
  intercept,
  resetInterceptorsForTests,
  runResponseInterception,
  type InterceptStreamTransform,
} from "../intercept";
import { cookiesResetForTests } from "../cookies";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://sh.test";
const enc = new TextEncoder();
const te = (s: string) => enc.encode(s);

const mkEvent = (routeUrl: string, destination: string) => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "GET",
      mode: "cors",
      destination,
      credentials: "same-origin",
      referrer: "",
      body: null,
      headers: new Headers(),
    },
    clientId: "c-1",
    resultingClientId: "c-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const stubSelf = () =>
  vi.stubGlobal("self", {
    location: { origin: ORIGIN, href: ORIGIN + "/" },
    registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });

const noCache = () =>
  vi.stubGlobal("caches", {
    open: async (name: string) => {
      if (name === "zeolite-jar-profile-v1")
        return { match: async () => undefined, put: async () => {} };
      throw new Error("no cache storage");
    },
  });

/* An upstream Response whose body is a controllable stream, so it
   carries NO content-length (the exact case the buffered arm could
   never transform). */
const streamResp = (opts: {
  chunks?: string[];
  onStart?: (c: ReadableStreamDefaultController<Uint8Array>) => void;
  cancelled?: { v: boolean };
  headers?: Record<string, string>;
  keepOpen?: boolean;
}) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of opts.chunks ?? []) c.enqueue(te(s));
        opts.onStart?.(c);
        if (!opts.keepOpen) c.close();
      },
      cancel() {
        if (opts.cancelled) opts.cancelled.v = true;
      },
    }),
    { headers: opts.headers ?? { "content-type": "text/plain" } },
  );

const route = (path: string, destination = "") =>
  mkEvent(ORIGIN + encodeDestLegacy("https://site.example/" + path), destination);

/* handler-declared plugin pipes */
const passthrough = (sizes: number[]) =>
  new TransformStream<Uint8Array, Uint8Array>({
    transform(c, ctl) {
      sizes.push(c.byteLength);
      ctl.enqueue(c);
    },
  });
const appending = (suffix: string) =>
  new TransformStream<Uint8Array, Uint8Array>({
    transform(c, ctl) {
      ctl.enqueue(c);
    },
    flush(ctl) {
      ctl.enqueue(te(suffix));
    },
  });
const stuck = () =>
  new TransformStream<Uint8Array, Uint8Array>({
    transform() {
      /* never enqueues and never settles: the deadline must fire */
      return new Promise<void>(() => {});
    },
  });

describe("runResponseInterception stream precedence (#552 pure)", () => {
  beforeEach(() => {
    resetInterceptorsForTests();
  });
  it("a stream outranks a buffered body in the same result", () => {
    const st: InterceptStreamTransform = {
      stream: new TransformStream<Uint8Array, Uint8Array>(),
      maxInputBytes: 1024,
    };
    intercept("response", () => ({ stream: st, body: (t: string) => t + "X" }));
    const out = runResponseInterception({
      url: "https://u.example/",
      status: 200,
      rtype: "fetch",
      headers: {},
    });
    expect(out.stream).toBe(st);
    expect(out.body).toBeUndefined();
  });
  it("the first declared transform wins across handlers, stream or body", () => {
    intercept("response", () => ({ body: (t: string) => t + "1" }));
    intercept("response", () => ({
      stream: { stream: new TransformStream<Uint8Array, Uint8Array>(), maxInputBytes: 1 },
    }));
    const out = runResponseInterception({
      url: "https://u.example/",
      status: 200,
      rtype: "fetch",
      headers: {},
    });
    expect(out.body).toBeTypeOf("function");
    expect(out.stream).toBeUndefined();
  });
});

describe("zlStreamGuards (#552 pure)", () => {
  it("passes chunks through untouched under the cap", async () => {
    const g = zlStreamGuards(100);
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(te("aa"));
        c.enqueue(te("bbbb"));
        c.close();
      },
    });
    const out = src.pipeThrough(g.upstream)
      .pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
      .pipeThrough(g.downstream);
    expect(await new Response(out).text()).toBe("aabbbb");
  });
  it("errors the pipe past the declared cap", async () => {
    const g = zlStreamGuards(3);
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(te("aaaa"));
        c.close();
      },
    });
    const out = src.pipeThrough(g.upstream)
      .pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
      .pipeThrough(g.downstream);
    await expect(new Response(out).text()).rejects.toThrow();
  });
  it("errors a transform that misses its first-output deadline", async () => {
    const g = zlStreamGuards(1000, 15);
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(te("aa"));
        c.close();
      },
    });
    const out = src.pipeThrough(g.upstream).pipeThrough(stuck()).pipeThrough(g.downstream);
    await expect(new Response(out).text()).rejects.toThrow();
  });
  it("clears the deadline once the first output flows", async () => {
    const g = zlStreamGuards(1000, 200);
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(te("aa"));
        c.close();
      },
    });
    const out = src.pipeThrough(g.upstream)
      .pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
      .pipeThrough(g.downstream);
    expect(await new Response(out).text()).toBe("aa");
  });
});

describe("streaming transforms through the fetch path (#552)", () => {
  beforeEach(() => {
    resetInterceptorsForTests();
    cookiesResetForTests();
    transportMock.calls = 0;
    transportMock.queue = [];
    stubSelf();
    noCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetInterceptorsForTests();
  });

  it("transforms an unknown-length body and drops the stale content-length", async () => {
    const sizes: number[] = [];
    intercept("response", () => ({
      stream: { stream: appending("|END"), maxInputBytes: 1024 },
    }));
    transportMock.queue = [
      streamResp({
        chunks: ["hello ", "world"],
        headers: { "content-type": "text/plain", "content-length": "12" },
      }),
    ];
    const { ev, armed } = route("data.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    /* a transform changes the body length: the stale upstream
       content-length must never reach the page */
    expect(served.headers.get("content-length")).toBeNull();
    expect(await served.text()).toBe("hello world|END");
  });

  it("streams a body larger than BODY_LIMIT (the buffered arm could never)", async () => {
    intercept("response", () => ({
      stream: { stream: appending("+"), maxInputBytes: 2 * 1024 * 1024 },
    }));
    const big = "x".repeat(300_000);
    transportMock.queue = [
      streamResp({ chunks: [big, big], headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = route("big.bin");
    handleFetch(ev);
    const served = await armed[0]!;
    const text = await served.text();
    expect(text.length).toBe(600_001);
    expect(text.endsWith("+")).toBe(true);
  });

  it("fails open when the known content-length exceeds the declared cap", async () => {
    const sizes: number[] = [];
    intercept("response", () => ({
      stream: { stream: passthrough(sizes), maxInputBytes: 5 },
    }));
    transportMock.queue = [
      new Response("0123456789", {
        headers: { "content-type": "text/plain", "content-length": "10" },
      }),
    ];
    const { ev, armed } = route("over.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    /* raw passthrough: the pipe never touched the body */
    expect(await served.text()).toBe("0123456789");
    expect(sizes).toEqual([]);
  });

  it("delivers the first chunk while the upstream is still open (no buffering)", async () => {
    const sizes: number[] = [];
    intercept("response", () => ({
      stream: { stream: passthrough(sizes), maxInputBytes: 4096 },
    }));
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    transportMock.queue = [
      streamResp({ chunks: ["first|"], onStart: (c) => { ctl = c; }, keepOpen: true }),
    ];
    const { ev, armed } = route("slow.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    const reader = served.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first|");
    /* the upstream controller is still live: the engine did not
       buffer the whole body before responding */
    expect(ctl).toBeTypeOf("object");
    ctl!.enqueue(te("second|"));
    ctl!.close();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second|");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("propagates a page-side cancel back to the upstream", async () => {
    const cancelled = { v: false };
    const sizes: number[] = [];
    intercept("response", () => ({
      stream: { stream: passthrough(sizes), maxInputBytes: 4096 },
    }));
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    transportMock.queue = [
      streamResp({ chunks: ["aa"], onStart: (c) => { ctl = c; }, cancelled, keepOpen: true }),
    ];
    const { ev, armed } = route("cancel.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    const reader = served.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled.v).toBe(true);
  });

  it("propagates an upstream error to the page", async () => {
    intercept("response", () => ({
      stream: { stream: new TransformStream<Uint8Array, Uint8Array>(), maxInputBytes: 4096 },
    }));
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    transportMock.queue = [
      streamResp({ chunks: ["aa"], onStart: (c) => { ctl = c; }, keepOpen: true }),
    ];
    const { ev, armed } = route("err.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    const reader = served.body!.getReader();
    await reader.read();
    ctl!.error(new Error("upstream died"));
    await expect(reader.read()).rejects.toThrow();
  });

  it("preserves chunk boundaries through the pipe", async () => {
    const sizes: number[] = [];
    intercept("response", () => ({
      stream: { stream: passthrough(sizes), maxInputBytes: 4096 },
    }));
    transportMock.queue = [
      streamResp({ chunks: ["aaa", "bb"], headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = route("chunks.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(await served.text()).toBe("aaabb");
    expect(sizes).toEqual([3, 2]);
  });

  it("never applies a stream to a stylesheet body", async () => {
    const sizes: number[] = [];
    intercept("response", () => ({
      stream: { stream: passthrough(sizes), maxInputBytes: 4096 },
    }));
    transportMock.queue = [
      new Response("body{color:red}", {
        headers: { "content-type": "text/css", "content-length": "15" },
      }),
    ];
    const { ev, armed } = route("style.css");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(await served.text()).toBe("body{color:red}");
    expect(sizes).toEqual([]);
  });

  it("never applies a stream to a document destination", async () => {
    const sizes: number[] = [];
    intercept("response", () => ({
      stream: { stream: passthrough(sizes), maxInputBytes: 4096 },
    }));
    transportMock.queue = [
      new Response("<html><body>doc</body></html>", {
        headers: { "content-type": "text/html", "content-length": "30" },
      }),
    ];
    await routeReady;
    const { ev, armed } = route("page.html", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(await served.text()).toBe("<html><body>doc</body></html>");
    expect(sizes).toEqual([]);
  });

  it("drops a stale content-length from the buffered arm too (#552 regression)", async () => {
    intercept("response", () => ({
      body: (t: string) => t + "TAIL",
    }));
    transportMock.queue = [
      new Response("hello!", {
        headers: { "content-type": "text/plain", "content-length": "6" },
      }),
    ];
    const { ev, armed } = route("buf.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(await served.text()).toBe("hello!TAIL");
    expect(served.headers.get("content-length")).toBeNull();
  });

  it("skips a throwing handler entirely (fail open)", async () => {
    intercept("response", () => {
      throw new Error("handler bug");
    });
    transportMock.queue = [
      new Response("raw", {
        headers: { "content-type": "text/plain", "content-length": "3" },
      }),
    ];
    const { ev, armed } = route("throw.txt");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(await served.text()).toBe("raw");
  });

  it("never reaches response interception for the engine-owned blob-worker route", async () => {
    const seen: string[] = [];
    intercept("response", (ctx: { url: string }) => {
      seen.push(ctx.url);
      return {};
    });
    const tok = encodeURIComponent(
      JSON.stringify({ s: "tok", b: "https://v.example/dir/page.html" }),
    );
    const { ev, armed } = mkEvent(ORIGIN + "/zl-bw/?c=" + tok, "script");
    handleFetch(ev);
    /* the route returns from the fetch handler long before the
       interception seam: the handler list stays empty of it */
    expect(seen.filter((u) => u.includes("/zl-bw/"))).toEqual([]);
  });
});
