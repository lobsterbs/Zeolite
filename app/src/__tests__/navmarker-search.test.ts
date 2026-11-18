import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* #633/#425 seam (b): the navguard marker route carries the full
   destination in its b64u payload, and the marker URL's OWN search is
   documented page decoration that must UNION onto the payload
   (mergeRouteSearch semantics, outer params winning) - that is what
   decodeClientUrlNoHash (dest + u.search) and markerPathDest both do.
   The NAV request branch in handleFetch never set routeCarriesQuery,
   so <marker>?sso_reload=true went upstream as the bare payload and
   the decoration was silently dropped - the dropped-query-params
   class on accounts.google.com flows. Every sibling branch (NAVH
   #144, /j/ routes, legacy recovery) sets routeCarriesQuery; the NAV
   branch must too, and the GET-navigation 302 must mint the unioned
   destination so the committed handle form keeps the search. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
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
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { b64uEncode, decodeClientUrl, setRouteKey, setScheme } from "../codec";
import { setQueryRoutes } from "../swstate";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const DEST = "https://accounts.example/ServiceLogin?hl=en&passive=true";
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
  await routeReady;
  setScheme("/j/");
  setRouteKey(KEY);
  setQueryRoutes(false);
  transportMock.calls = 0;
  transportMock.urls = [];
  transportMock.queue = [];
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

describe("marker-route search union (#633 dropped params)", () => {
  it("unions the marker URL search onto the payload for fetches", async () => {
    const marker = "/__zl_nav__/" + b64u(DEST) + "?sso_reload=true&dsh=S-1:2";
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + marker, "cors", "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe(
      "https://accounts.example/ServiceLogin?hl=en&passive=true&sso_reload=true&dsh=S-1:2",
    );
  });

  it("mints the 302 handle form with the unioned search on GET navigations", async () => {
    setQueryRoutes(true);
    const marker = "/__zl_nav__/" + b64u(DEST) + "?sso_reload=true";
    const { ev, armed } = mkEvent(ORIGIN + marker, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe(
      "https://accounts.example/ServiceLogin?hl=en&passive=true&sso_reload=true",
    );
    expect(transportMock.calls).toBe(0);
  });

  it("a bare marker without search is unchanged", async () => {
    const marker = "/__zl_nav__/" + b64u(DEST);
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + marker, "cors", "script");
    handleFetch(ev);
    await armed[0]!;
    expect(transportMock.urls[0]).toBe(DEST);
  });
});
