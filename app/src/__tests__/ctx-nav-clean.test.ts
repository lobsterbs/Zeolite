import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* #511 (the cyber.blooket join class): a same-virtual-origin
   navigation the page performed through a NATIVE location write
   (window.location.href in bundled JS; the #235 rename cannot reach
   it) lands on the bare same-origin path. The #33 context recovery
   resolves it, but serving the document at the bare tokenless path
   leaves no handle in its URL, so the page's own history writes
   re-anchor through the vloc navq-less prel mint and park the
   document on the opaque pathname, and a pathname-routed SPA
   reading the native location misses every route (Blooket's
   literal "Game not found." catch-all). The SW answers the GET
   navigation with one same-origin 302 to the visible query-shape
   handle form (real path + fresh zlNavh token), the same shape the
   initial navigation minted; fetches, POST navigations, and
   unmintable cases keep the direct serve. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  urls: [] as string[],
  queue: [] as Response[],
  inits: [] as Array<{ method?: string; headers?: Headers; body?: unknown } | undefined>,
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init?: { method?: string; headers?: Headers; body?: unknown }) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      transportMock.inits.push(init ? { method: init.method, headers: init.headers, body: init.body } : undefined);
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { b64uEncode, decodeClientUrl, setRouteKey, setScheme } from "../codec";
import { setQueryRoutes, VCTX } from "../swstate";
import { establishContext } from "../vctx";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const HOME = "https://site.example";
const PATH = "/join/6ae3/game/6ae3-player";

const mkEvent = (routeUrl: string, mode: string, destination: string, method = "GET") => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method,
      mode,
      destination,
      credentials: "same-origin",
      referrer: "",
      body: null,
      headers: new Headers(),
    },
    clientId: "doc-1",
    resultingClientId: "doc-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

beforeEach(async () => {
  /* the module-eval routeRestore can replace the key set after this
     file first awaits (a fresh idb mints a new key), so let it settle
     BEFORE the key is set: the minted token must decode on every test. */
  await routeReady;
  setScheme("/j/");
  setRouteKey(KEY);
  setQueryRoutes(true);
  transportMock.calls = 0;
  transportMock.urls = [];
  transportMock.inits = [];
  transportMock.queue = [];
  establishContext(VCTX, "doc-1", HOME + "/");
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

describe("bare-path context navigation redirects to the visible query-shape form (#511)", () => {
  it("redirects a GET navigation on a bare same-origin path with a client context", async () => {
    const { ev, armed } = mkEvent(ORIGIN + PATH, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(loc.startsWith(PATH + "?zlNavh=")).toBe(true);
    /* the clean form decodes back to the context destination */
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe(HOME + PATH);
    /* nothing went upstream on the bare-path request itself */
    expect(transportMock.calls).toBe(0);
  });

  it("keeps the direct serve for subresource fetches (no redirect)", async () => {
    const { ev, armed } = mkEvent(ORIGIN + PATH, "cors", "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual([HOME + PATH]);
  });

  it("keeps the direct serve for POST navigations (a redirect would strip the body)", async () => {
    const { ev, armed } = mkEvent(ORIGIN + PATH, "navigate", "document", "POST");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual([HOME + PATH]);
  });

  it("fails closed without a route key (the bare-path serve stands)", async () => {
    setRouteKey(null);
    const { ev, armed } = mkEvent(ORIGIN + PATH, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual([HOME + PATH]);
  });

  it("fails closed when query routes are disabled", async () => {
    setQueryRoutes(false);
    const { ev, armed } = mkEvent(ORIGIN + PATH, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual([HOME + PATH]);
  });

  it("serves the committed query form through the handle branch on the next hop", async () => {
    /* the redirect target itself decodes and serves: the qHandle
       branch owns the tokened URL, so the 302 loop closes in one hop */
    const { ev, armed } = mkEvent(ORIGIN + PATH, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    const loc = served.headers.get("location")!;
    const second = mkEvent(new URL(loc, ORIGIN).href, "navigate", "document");
    handleFetch(second.ev);
    const doc = await second.armed[0]!;
    expect(doc.status).toBe(200);
    expect(transportMock.urls).toEqual([HOME + PATH]);
  });
});

