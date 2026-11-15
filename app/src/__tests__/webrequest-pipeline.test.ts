import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #521: the webRequest observe lifecycle must report the requests that
   actually traverse the engine's fetch pipeline — the same wire events
   the hop chain produces, in the Firefox order. The transport module
   is mocked the way request.test.ts mocks it; the pipeline itself is
   the real handleFetch. */

const transportMock = vi.hoisted(() => ({
  urls: [] as string[],
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, _init?: unknown) => {
      transportMock.urls.push(url);
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { handleFetch } from "../request";
import { WEBREQ } from "../extensions/webrequest";
import type {
  WrCompletedDetails,
  WrDetails,
  WrReceiveDetails,
  WrRedirectDetails,
  WrResponseStartedDetails,
  WrSendDetails,
} from "../extensions/webrequest";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://w.example.org";

function mkGetEvent(target: string) {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: ORIGIN + encodeDestLegacy(target),
      method: "GET",
      mode: "navigate",
      destination: "document",
      credentials: "same-origin",
      referrer: "",
      headers: new Headers(),
    },
    clientId: "wr-1",
    resultingClientId: "wr-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
}

function opts() {
  return { perm: () => ({ hostPatterns: ["<all_urls>"], canBlock: false }), urls: [] };
}

/* One shared ordered log across all observe listeners: the assertions
   pin the Firefox delivery order, not only the payloads. */
let log: Array<{ ev: string; url?: string; redirectUrl?: string; status?: number }>;

beforeEach(() => {
  WEBREQ.resetForTests();
  transportMock.urls = [];
  transportMock.queue = [];
  log = [];
  WEBREQ.register("e-obs", "beforeRequest", (d: WrDetails) => void log.push({ ev: "beforeRequest", url: d.url }), opts());
  WEBREQ.register("e-obs", "sendHeaders", (d: WrSendDetails) => void log.push({ ev: "sendHeaders", url: d.url }), opts());
  WEBREQ.register("e-obs", "beforeRedirect", (d: WrRedirectDetails) => void log.push({ ev: "beforeRedirect", url: d.url, redirectUrl: d.redirectUrl, status: d.statusCode }), opts());
  WEBREQ.register("e-obs", "headersReceived", (d: WrReceiveDetails) => void log.push({ ev: "headersReceived", url: d.url, status: d.statusCode }), opts());
  WEBREQ.register("e-obs", "responseStarted", (d: WrResponseStartedDetails) => void log.push({ ev: "responseStarted", url: d.url, status: d.statusCode }), opts());
  WEBREQ.register("e-obs", "completed", (d: WrCompletedDetails) => void log.push({ ev: "completed", url: d.url, status: d.statusCode }), opts());
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
  WEBREQ.resetForTests();
});

describe("webRequest observe lifecycle over the real pipeline (#521)", () => {
  it("fires beforeRequest -> sendHeaders -> beforeRedirect (per hop) -> headersReceived -> responseStarted -> completed on a redirecting request", async () => {
    transportMock.queue = [
      new Response(null, { status: 301, headers: { location: "https://cdn.site.example/next" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkGetEvent("https://site.example/page");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    /* The hops the engine actually issued. */
    expect(transportMock.urls).toEqual(["https://site.example/page", "https://cdn.site.example/next"]);

    const names = log.map((l) => l.ev);
    const first = (a: string) => names.indexOf(a);
    /* The observe lifecycle order, pinned on first occurrences: the
       initial gates -> the final outgoing header set -> the followed
       hop (whose per-hop gate re-check, #186, fires a second
       onBeforeRequest for the hop URL FIRST) -> the response stages
       on the final hop. headersReceived is absent for a non-blocking
       extension on purpose: it is a blocking-kind event, so a
       webRequest-only extension observes the lifecycle without it. */
    expect(first("beforeRequest")).toBeLessThan(first("sendHeaders"));
    expect(first("sendHeaders")).toBeLessThan(first("beforeRedirect"));
    expect(first("beforeRedirect")).toBeLessThan(first("responseStarted"));
    expect(first("responseStarted")).toBeLessThan(first("completed"));
    expect(names).not.toContain("headersReceived");

    /* onBeforeRequest fires for the original URL and again for the
       hop (the #186 per-hop admission re-check); onSendHeaders
       describes the original URL only; onBeforeRedirect reports the
       3xx hop -> the target; the response stages describe the FINAL
       hop (#288). */
    expect(log.filter((l) => l.ev === "beforeRequest").map((l) => l.url)).toEqual([
      "https://site.example/page",
      "https://cdn.site.example/next",
    ]);
    expect(log.filter((l) => l.ev === "sendHeaders").map((l) => l.url)).toEqual(["https://site.example/page"]);
    expect(log.filter((l) => l.ev === "beforeRedirect")).toEqual([
      { ev: "beforeRedirect", url: "https://site.example/page", redirectUrl: "https://cdn.site.example/next", status: 301 },
    ]);
    expect(log.filter((l) => l.ev === "responseStarted").map((l) => [l.url, l.status])).toEqual([
      ["https://cdn.site.example/next", 200],
    ]);
    expect(log.filter((l) => l.ev === "completed").map((l) => [l.url, l.status])).toEqual([
      ["https://cdn.site.example/next", 200],
    ]);
  });

  it("never fires onBeforeRedirect for a 3xx surfaced without a followed hop", async () => {
    /* 3xx without a Location header: the loop breaks and the response
       is surfaced as-is — no hop was followed, so no redirect event. */
    transportMock.queue = [
      new Response(null, { status: 301, headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkGetEvent("https://site.example/page");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(301);

    expect(log.map((l) => l.ev)).not.toContain("beforeRedirect");
    /* The 3xx still reached the network and completed as a request. */
    expect(log.filter((l) => l.ev === "beforeRequest").map((l) => l.url)).toEqual(["https://site.example/page"]);
    expect(log.filter((l) => l.ev === "responseStarted").map((l) => [l.url, l.status])).toEqual([
      ["https://site.example/page", 301],
    ]);
    expect(log.filter((l) => l.ev === "completed").map((l) => [l.url, l.status])).toEqual([
      ["https://site.example/page", 301],
    ]);
  });
});
