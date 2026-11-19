import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Issue #682: worker main-thread starvation during rewrite storms stalls
   same-origin passthrough fetches (/build, relay renewals). The rewrite
   pumps in transform.ts loop on `await reader.read()`; when the upstream
   body is already buffered (transport spool, page cache, a Response the
   transport handed over whole) every read resolves in a MICROtask, so the
   whole document rewrite runs inside ONE macrotask and the worker never
   dispatches another fetch event until the storm drain finishes. The
   browser queues the /build FetchEvent behind that giant task - the
   observed "status 0, ms -1 forever" rows.

   These tests pin the contract: the pump must hand the event loop back
   (macrotask turns) between rewrite chunks, so a passthrough fetch event
   dispatched mid-storm is answered before the storm drains. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  gate: undefined as undefined | Promise<void>,
  urls: [] as string[],
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      if (transportMock.gate) await transportMock.gate;
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

/* Identity rewriter: the tests pin orchestration (event-loop yields), not
   wasm output - same mock shape as transform.test.ts. */
vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
    take_base() {
      return undefined;
    }
    add_injection(_p: string) {}
    set_blocked_hosts(_h: string[]) {}
    set_lazy_images() {}
    set_trace(_on: boolean) {}
    take_trace() {
      return "[]";
    }
  }
  class JsCssRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
  }
  return {
    JsRewriter,
    JsCssRewriter,
    rewriteCss: (css: string) => css,
    rewriteJsBody: (js: string) => js,
    globalsStats: () => "0,0,0",
    default: async () => {},
  };
});

import { handleFetch } from "../request";
import { initTransform, rewriteStream } from "../transform";
import { encodeDestLegacy } from "../codec";
import { VCTX } from "../swstate";
import type { TransformDeps } from "../transform";

const ORIGIN = "https://w.example.org";
const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  const r = s.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deps(): TransformDeps {
  return {
    routeReady: () => Promise.resolve(),
    routeKey: () => "a2V5",
    fpScript: () => null,
    siteScript: async () => null,
    setDegraded: () => {},
    lazyImages: () => false,
  };
}

describe("rewrite pump event-loop yields (#682)", () => {
  beforeEach(() => {
    initTransform(deps());
    transportMock.calls = 0;
    transportMock.gate = undefined;
    transportMock.urls = [];
    transportMock.queue = [];
    vi.stubGlobal("self", {
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
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
  });

  it("rewriteStream hands the event loop back between chunks of a buffered body", async () => {
    /* A fully-buffered document (transport spool / cache shape): every
       upstream read resolves in a microtask. Count macrotask turns while
       the pump drains; a pump that never yields completes with zero. */
    const chunks: string[] = ["<!DOCTYPE html><html><head></head><body>"];
    for (let i = 0; i < 600; i++) chunks.push("<div>" + "x".repeat(512) + "</div>");
    let turns = 0;
    let turnsWhenDrained = -1;
    const tick = () => {
      turns++;
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    const out = await readAll(rewriteStream(streamOf(chunks), "https://site.example/", {} as never, [], "text/html"));
    turnsWhenDrained = turns;
    await sleep(20);
    expect(out.length).toBeGreaterThan(0);
    /* The regression: before the #682 fix the whole buffered drain ran in
       one macrotask, so not a single timer turn happened mid-pump. */
    expect(turnsWhenDrained).toBeGreaterThan(0);
  });

  it("a same-origin passthrough fetch dispatched mid-storm is answered before the storm drains", async () => {
    /* The issue's exact symptom: the embedder's GET /build (and the
       /zlrelay renewals) sit pending while rewrite work runs. The browser
       dispatches that FetchEvent as a task queued behind the storm task;
       simulate it with a setTimeout, the way the event loop would. */
    const fetchCalls: string[] = [];
    let buildIssuedBeforeStormDrained = false;
    let stormDone = false;
    vi.stubGlobal("fetch", async (input: unknown) => {
      const u =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : typeof input === "object" && input !== null && "url" in input
              ? String((input as { url: unknown }).url)
              : String(input);
      fetchCalls.push(u);
      /* The escape branch calls fetch(e.request): the moment the browser
         would actually issue the network request (the netlog row starts
         moving instead of sitting at status 0, ms -1). */
      if (u.includes("/build") && !stormDone) buildIssuedBeforeStormDrained = true;
      return new Response("build-ok", { headers: { "content-type": "text/plain" } });
    });

    const chunks: string[] = ["<!DOCTYPE html><html><head></head><body>"];
    for (let i = 0; i < 600; i++) chunks.push("<div>" + "y".repeat(512) + "</div>");
    transportMock.queue = [
      new Response(streamOf(chunks), { headers: { "content-type": "text/html" } }),
    ];

    const mkEvent = (routeUrl: string, clientId: string, mode: string, destination: string) => {
      const armed: Promise<Response>[] = [];
      const ev = {
        request: {
          url: routeUrl,
          method: "GET",
          mode,
          destination,
          credentials: "same-origin",
          referrer: "",
          body: null,
          headers: new Headers(),
        },
        clientId,
        resultingClientId: clientId + "-new",
        respondWith: (p: Promise<Response>) => void armed.push(p),
        waitUntil: () => {},
      } as unknown as FetchEvent;
      return { ev, armed };
    };

    /* The proxied document navigation: the rewrite storm. */
    const nav = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "nav-storm", "navigate", "document");
    handleFetch(nav.ev);
    expect(nav.armed.length).toBe(1);

    /* The embedder's same-origin passthrough fetch, dispatched as a later
       task while the storm is draining. */
    const buildArmed: Promise<Response>[] = [];
    setTimeout(() => {
      const build = mkEvent(ORIGIN + "/build", "shell-1", "cors", "fetch");
      handleFetch(build.ev);
      buildArmed.push(...build.armed);
    }, 0);

    const served = await nav.armed[0]!;
    expect(served.status).toBe(200);
    await readAll(served.body!);
    stormDone = true;

    expect(buildArmed.length).toBe(1);
    const buildResp = await buildArmed[0]!;
    expect(buildResp.status).toBe(200);
    expect(fetchCalls.some((u) => u.includes("/build"))).toBe(true);
    /* Before the #682 fix the /build event was dispatched only after the
       whole document drained in one macrotask: the netlog row stayed
       pending for the full storm (status 0, ms -1). */
    expect(buildIssuedBeforeStormDrained).toBe(true);
  });
});
