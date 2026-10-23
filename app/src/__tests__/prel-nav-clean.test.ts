import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* URL fidelity for prel navigations (the Google sei reload class):
   a GET navigation that arrives on a __zl_prel__ tail under a NAVH
   parent decodes correctly, but the document would park on the
   opaque prel pathname with its query folded inside it, invisible
   to location.search, so session-refresh flows that reload once in
   a real browser re-trigger through the engine and the SPA state
   breaks. The SW answers the prel navigation with one same-origin
   302 to the visible handle form (token + real path + real query),
   the same shape the initial navigation minted (#144). */

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

import { handleFetch, navhCleanFromPrel, routeReady } from "../request";
import { b64uEncode, buildNavHandleUrl, decodeClientUrl, encodeDestLegacy, setRouteKey, setScheme } from "../codec";
import { setQueryRoutes } from "../swstate";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const DEST = "https://www.google.com/search?q=what+is+a+hurricane";
const SEI_DEST = "https://www.google.com/search?q=what+is+a+hurricane&sei=SEI1";

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
  /* NAVH-path-form suite: the injector default is on, these tests
     pin the arm they assert; the query shape has its own describe. */
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

describe("prel navigation redirect to the visible handle form", () => {
  it("redirects a GET navigation on a NAVH-parent prel tail (Google sei reload shape)", async () => {
    const base = buildNavHandleUrl(DEST)!;
    const parent = new URL(base, ORIGIN).pathname;
    const prel = parent + "/__zl_prel__/" + encodeURIComponent("/search?q=what+is+a+hurricane&sei=SEI1");
    const { ev, armed } = mkEvent(ORIGIN + prel, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    /* #385: the clean form re-mints, so the token segment is fresh
       while the visible path and query stay identical */
    expect(loc.startsWith("/__zl_navh__/")).toBe(true);
    expect(loc.endsWith("/search?q=what+is+a+hurricane&sei=SEI1")).toBe(true);
    expect(loc.split("/")[2]).not.toBe(parent.split("/")[2]);
    /* the clean form decodes back to the exact same destination */
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe(SEI_DEST);
    /* nothing went upstream on the prel request itself */
    expect(transportMock.calls).toBe(0);
  });

  it("keeps the prel decode for fetches (no redirect)", async () => {
    const base = buildNavHandleUrl(DEST)!;
    const parent = new URL(base, ORIGIN).pathname;
    const prel = parent + "/__zl_prel__/" + encodeURIComponent("/search?q=what+is+a+hurricane&sei=SEI1");
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + prel, "cors", "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe(SEI_DEST);
  });

  it("keeps the prel decode for POST navigations (a redirect would strip the body)", async () => {
    const base = buildNavHandleUrl(DEST)!;
    const parent = new URL(base, ORIGIN).pathname;
    const prel = parent + "/__zl_prel__/" + encodeURIComponent("/search?q=what+is+a+hurricane&sei=SEI1");
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + prel, "navigate", "document", "POST");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe(SEI_DEST);
  });

  it("redirects a non-NAVH-parent prel navigation to a fresh handle (#383)", async () => {
    const scheme = encodeDestLegacy("https://site.example/dir/page");
    const prel = scheme + "/__zl_prel__/" + encodeURIComponent("/x?y=1");
    const { ev, armed } = mkEvent(ORIGIN + prel, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(loc.startsWith("/__zl_navh__/")).toBe(true);
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe("https://site.example/x?y=1");
    expect(transportMock.calls).toBe(0);
  });

  it("escapes surplus leading slashes in the clean form and round-trips them (#202)", () => {
    const base = buildNavHandleUrl("https://www.google.com/dir/page")!;
    const parent = new URL(base, ORIGIN).pathname;
    const clean = navhCleanFromPrel(
      parent + "/__zl_prel__/" + encodeURIComponent("//b?c=1"),
      "https://www.google.com//b?c=1",
    );
    /* #385: the token is re-minted; the visible form stays identical */
    expect(clean!.endsWith("/%2Fb?c=1")).toBe(true);
    expect(clean!.split("/")[2]).not.toBe(parent.split("/")[2]);
    expect(decodeClientUrl(new URL(clean!, ORIGIN))).toBe("https://www.google.com//b?c=1");
  });

  it("mints a fresh handle for a non-NAVH parent (#383); an unparsable destination still fails closed", () => {
    const clean = navhCleanFromPrel("/not-a-route/__zl_prel__/%2Fx", "https://example.com/x");
    expect(clean).not.toBeNull();
    expect(clean!.startsWith("/__zl_navh__/")).toBe(true);
    expect(decodeClientUrl(new URL(clean!, ORIGIN))).toBe("https://example.com/x");
    expect(navhCleanFromPrel("/__zl_navh__/tok/search/__zl_prel__/%2Fx", "::not a url")).toBeNull();
  });
});

describe("expired navigation handle re-mint (#385)", () => {
  it("redirects a GET navigation on an expired handle to a fresh handle", async () => {
    const expired = buildNavHandleUrl(DEST, -60_000)!;
    const parent = new URL(expired, ORIGIN).pathname;
    const { ev, armed } = mkEvent(
      ORIGIN + parent + "?q=what+is+a+hurricane",
      "navigate",
      "document",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    /* the fresh location decodes back to the exact destination */
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe(DEST);
    expect(loc.split("/")[2]).not.toBe(parent.split("/")[2]);
    expect(transportMock.calls).toBe(0);
  });

  it("fails closed for a tampered token (MAC does not verify, no re-mint)", async () => {
    const expired = buildNavHandleUrl(DEST, -60_000)!;
    const parts = new URL(expired, ORIGIN).pathname.split("/");
    const tok = parts[2]!;
    parts[2] = tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A");
    const { ev, armed } = mkEvent(ORIGIN + parts.join("/") + "?q=x", "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(404);
    expect(transportMock.calls).toBe(0);
  });

  it("keeps the expiry for fetches on an expired handle (no re-mint)", async () => {
    const expired = buildNavHandleUrl(DEST, -60_000)!;
    const parent = new URL(expired, ORIGIN).pathname;
    const { ev, armed } = mkEvent(ORIGIN + parent, "cors", "empty");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(404);
    expect(transportMock.calls).toBe(0);
  });
});

describe("queryRoutes clean form (Injector phase 2)", () => {
  beforeEach(() => {
    setQueryRoutes(false);
  });

  it("mints the query shape when queryRoutes is on", () => {
    setQueryRoutes(true);
    const base = buildNavHandleUrl(DEST)!;
    const parent = new URL(base, ORIGIN).pathname;
    const clean = navhCleanFromPrel(
      parent + "/__zl_prel__/" + encodeURIComponent("/search?q=what+is+a+hurricane&sei=SEI1"),
      SEI_DEST,
    );
    expect(clean).not.toBeNull();
    expect(clean!.startsWith("/search?q=what+is+a+hurricane&sei=SEI1&zlNavh=")).toBe(true);
    expect(clean!.includes("/__zl_navh__/")).toBe(false);
    expect(decodeClientUrl(new URL(clean!, ORIGIN))).toBe(SEI_DEST);
  });

  it("falls back to the NAVH path form on an engine-internal collision", () => {
    setQueryRoutes(true);
    const base = buildNavHandleUrl("https://www.google.com/")!;
    const parent = new URL(base, ORIGIN).pathname;
    const dest = "https://www.google.com/__zl_navh__/thing?q=1";
    const clean = navhCleanFromPrel(
      parent + "/__zl_prel__/" + encodeURIComponent("/__zl_navh__/thing?q=1"),
      dest,
    );
    expect(clean).not.toBeNull();
    expect(clean!.startsWith("/__zl_navh__/")).toBe(true);
    expect(clean!.includes("zlNavh=")).toBe(false);
    expect(decodeClientUrl(new URL(clean!, ORIGIN))).toBe(dest);
  });

  it("keeps the NAVH path form when queryRoutes is off", () => {
    const base = buildNavHandleUrl(DEST)!;
    const parent = new URL(base, ORIGIN).pathname;
    const clean = navhCleanFromPrel(
      parent + "/__zl_prel__/" + encodeURIComponent("/search?q=what+is+a+hurricane&sei=SEI1"),
      SEI_DEST,
    );
    expect(clean).not.toBeNull();
    expect(clean!.startsWith("/__zl_navh__/")).toBe(true);
    expect(clean!.includes("zlNavh=")).toBe(false);
  });
});
