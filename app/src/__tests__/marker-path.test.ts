import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* #612/#634: the nav marker (/__zl_nav__/<b64u>) is engine vocabulary
   in a PATH too. A destination whose path ends with the marker was
   page-built by resolving the marker against a virtual origin and was
   dialed verbatim upstream (Google 404 #612, HTTP.sys 400 #634). The
   SW resolves the marker payload (the marker URL's own search unions
   onto it) and serves it; a GET top-level navigation on the marker
   route itself redirects once to the visible handle form, so the
   document never parks on the opaque pathname and never decorates
   the marker itself. */

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

import { handleFetch, markerPathDest, routeReady } from "../request";
import { b64uEncode, decodeClientUrl, encodeDest, setRouteKey, setScheme } from "../codec";
import { setQueryRoutes } from "../swstate";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const DEST = "https://accounts.example/ServiceLogin?hl=en";
const b64u = (s: string) => b64uEncode(new TextEncoder().encode(s));

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
    clientId: "c-1",
    resultingClientId: "c-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

beforeEach(async () => {
  /* the module-eval routeRestore can replace the key set after this
     file first awaits (a fresh idb mints a new key), so let it settle
     BEFORE the key is set: the NAVH token must decode on every test. */
  await routeReady;
  setScheme("/j/");
  setRouteKey(KEY);
  setQueryRoutes(false);
  transportMock.calls = 0;
  transportMock.urls = [];
  transportMock.inits = [];
  transportMock.queue = [];
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });
  /* no cache storage: the cache-first lookup misses, the store warns once */
  vi.stubGlobal("caches", {
    open: async () => {
      throw new Error("no cache storage");
    },
  });
});

describe("markerPathDest (unit, #612/#634)", () => {
  it("returns null when the path carries no marker", () => {
    expect(markerPathDest("https://www.google.com/search?q=1")).toBeNull();
  });

  it("resolves an end-of-path marker and unions the marker URL search onto the payload", () => {
    const d =
      "https://login.example/__zl_nav__/" +
      b64u("https://login.example/authorize?client_id=9") +
      "?sso_reload=true";
    expect(markerPathDest(d)).toBe("https://login.example/authorize?client_id=9&sso_reload=true");
  });

  it("resolves chained markers (a payload that itself carries a marker)", () => {
    const inner = "https://a.example/end/__zl_nav__/" + b64u("https://b.example/final?k=1");
    const outer = "https://c.example/m/__zl_nav__/" + b64u(inner);
    expect(markerPathDest(outer)).toBe("https://b.example/final?k=1");
  });

  it("keeps legacy behavior for a mid-path marker with trailing segments", () => {
    expect(
      markerPathDest("https://www.google.com/__zl_nav__/" + b64u("https://www.google.com/x") + "/more"),
    ).toBeNull();
  });

  it("fails closed on garbage and non-HTTP payloads", () => {
    expect(markerPathDest("https://www.google.com/__zl_nav__/%")).toBeNull();
    expect(markerPathDest("https://www.google.com/__zl_nav__/Y")).toBeNull();
    expect(markerPathDest("https://www.google.com/__zl_nav__/")).toBeNull();
    expect(markerPathDest("https://www.google.com/__zl_nav__/" + b64u("javascript:alert(1)"))).toBeNull();
  });
});

describe("marker-route navigation (handleFetch arms)", () => {
  it("redirects a GET document navigation on the marker route to the visible handle form (#612/#634)", async () => {
    const marker = "/__zl_nav__/" + b64u(DEST);
    const { ev, armed } = mkEvent(ORIGIN + marker, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(loc.startsWith("/__zl_navh__/")).toBe(true);
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe(DEST);
    /* nothing went upstream on the marker request itself */
    expect(transportMock.calls).toBe(0);
  });

  it("mints the query shape for the marker navigation when queryRoutes is on", async () => {
    setQueryRoutes(true);
    const marker = "/__zl_nav__/" + b64u(DEST);
    const { ev, armed } = mkEvent(ORIGIN + marker, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(loc.startsWith("/ServiceLogin?hl=en&zlNavh=")).toBe(true);
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe(DEST);
    expect(transportMock.calls).toBe(0);
  });

  it("keeps the in-place serve for pane navigations on the marker route (fail-closed surface stamp, #612)", async () => {
    const marker = "/__zl_nav__/" + b64u(DEST);
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + marker, "navigate", "iframe");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe(DEST);
  });

  it("keeps the in-place serve for fetches on the marker route", async () => {
    const marker = "/__zl_nav__/" + b64u(DEST);
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + marker, "cors", "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe(DEST);
  });
});

describe("marker-in-path destinations (the #612 producer class)", () => {
  const RESOLVED = "https://www.google.com/search?q=1&sso_reload=true";
  const markerInPath =
    "https://www.google.com/__zl_nav__/" + b64u("https://www.google.com/search?q=1") + "?sso_reload=true";

  it("redirects a GET document navigation whose destination carries the marker to the clean form", async () => {
    const keyed = encodeDest(markerInPath);
    const { ev, armed } = mkEvent(ORIGIN + keyed, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe(RESOLVED);
    expect(transportMock.calls).toBe(0);
  });

  it("serves the resolved payload in place for fetches", async () => {
    const keyed = encodeDest(markerInPath);
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + keyed, "cors", "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe(RESOLVED);
  });
});
