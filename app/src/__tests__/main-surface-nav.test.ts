import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #611 (Google sign-in 401): accounts.google.com/ServiceLogin answers a
   navigation stamped Sec-Fetch-Dest: iframe with a hard 401, and every
   engine pane navigation is a physical iframe fetch. The pane's own
   navigations must therefore claim the top-level destination. The
   client's surface class is recorded at serve time - a document served
   from a minted navigation handle (a NAVH route or a committed query
   route) is the pane's main surface - and that flag is the tiebreaker
   when a genuine subframe's own cross-origin link click mints the very
   same handle-shaped request. These tests drive the real handleFetch
   loop: the pre-established pane client, the serve-time establishment
   wiring, the SW-restart rehydrate, the NAVH request shape, and the
   fail-closed marker residual (the marker fallback stays iframe, tied
   to #612). */

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
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { b64uEncode, buildNavHandleUrl, buildQueryHandleUrl, setRouteKey, setScheme } from "../codec";
import { establishContext } from "../vctx";
import { setQueryRoutes, VCTX } from "../swstate";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

/* The live failure shape: the sign-in link off a committed Google
   pane document. */
const SERVICELOGIN = "https://accounts.google.com/ServiceLogin?hl=en&passive=true";
const GOOGLE_HOME = "https://www.google.com/";

const mkEvent = (
  routeUrl: string,
  mode: string,
  destination: string,
  method = "GET",
  clientId = "c-1",
  resultingClientId = "c-1-new",
) => {
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
    clientId,
    resultingClientId,
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const textBody = () => new Response("ok", { headers: { "content-type": "text/plain" } });
const destOf = (i: number) => transportMock.inits[i]?.headers?.get("sec-fetch-dest") ?? null;

beforeEach(async () => {
  /* the module-eval routeRestore can replace the key set after this
     file first awaits (a fresh idb mints a new key), so let it settle
     BEFORE the key is set: the token must decode on every test. */
  await routeReady;
  setScheme("/j/");
  setRouteKey(KEY);
  setQueryRoutes(false);
  transportMock.calls = 0;
  transportMock.urls = [];
  transportMock.inits = [];
  transportMock.queue = [];
  VCTX.clear();
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("main-surface tab navigation stamps sec-fetch-dest document (#611)", () => {
  it("the pane's own navigation claims the top-level destination", async () => {
    establishContext(VCTX, "c-pane", GOOGLE_HOME, "window", true);
    const committed = buildQueryHandleUrl(SERVICELOGIN)!;
    transportMock.queue = [textBody()];
    const { ev, armed } = mkEvent(ORIGIN + committed, "navigate", "iframe", "GET", "c-pane", "c-pane-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    /* the token never rides upstream and the destination is exact */
    expect(transportMock.urls[0]).toBe(SERVICELOGIN);
    expect(destOf(0)).toBe("document");
    expect(transportMock.inits[0]?.headers?.get("sec-fetch-mode")).toBe("navigate");
    /* the proven-working set carries no Sec-Fetch-User */
    expect(transportMock.inits[0]?.headers?.get("sec-fetch-user")).toBeNull();
  });

  it("a subframe client's same-shaped navigation keeps the physical iframe destination (differential)", async () => {
    /* established WITHOUT the surface flag: the #596 default shape,
       the class a genuine subframe's own client lands in */
    establishContext(VCTX, "c-sub", GOOGLE_HOME, "window");
    const committed = buildQueryHandleUrl("https://widget.example/frame-page")!;
    transportMock.queue = [textBody()];
    const { ev, armed } = mkEvent(ORIGIN + committed, "navigate", "iframe", "GET", "c-sub", "c-sub-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(destOf(0)).toBe("iframe");
  });

  it("the pane's document serve stamps the resulting client's surface (establishment wiring)", async () => {
    /* Step 1: the pane's initial document load - a committed query
       route, physical destination iframe - establishes the new
       client as main surface at serve time. */
    const paneCommitted = buildQueryHandleUrl(GOOGLE_HOME)!;
    transportMock.queue = [textBody()];
    const pane = mkEvent(ORIGIN + paneCommitted, "navigate", "iframe", "GET", "c-0", "c-pane");
    handleFetch(pane.ev);
    const first = await pane.armed[0]!;
    expect(first.status).toBe(200);
    expect(transportMock.calls).toBe(1);

    /* Step 2: the pane's own next navigation, from the client the
       serve stamped. No pre-establishment here: the wiring under
       test is the serve-time establishment itself. */
    const committed = buildQueryHandleUrl(SERVICELOGIN)!;
    transportMock.queue = [textBody()];
    const nav = mkEvent(ORIGIN + committed, "navigate", "iframe", "GET", "c-pane", "c-pane-3");
    handleFetch(nav.ev);
    const served = await nav.armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[1]).toBe(SERVICELOGIN);
    expect(destOf(1)).toBe("document");
  });

  it("a restarted worker restores the surface from the committed client URL (rehydrate)", async () => {
    /* no context in the map; the SW restart rehydrate must recover
       the surface class from the committed client URL shape */
    const paneUrl = ORIGIN + buildQueryHandleUrl(GOOGLE_HOME)!;
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async (id: string) => (id === "c-r" ? { url: paneUrl } : null) },
    });
    const committed = buildQueryHandleUrl(SERVICELOGIN)!;
    transportMock.queue = [textBody()];
    const { ev, armed } = mkEvent(ORIGIN + committed, "navigate", "iframe", "GET", "c-r", "c-r-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe(SERVICELOGIN);
    expect(destOf(0)).toBe("document");
  });

  it("a NAVH-shaped pane navigation claims the top-level destination too", async () => {
    establishContext(VCTX, "c-pane", GOOGLE_HOME, "window", true);
    const navh = buildNavHandleUrl(SERVICELOGIN)!;
    transportMock.queue = [textBody()];
    const { ev, armed } = mkEvent(ORIGIN + navh, "navigate", "iframe", "GET", "c-pane", "c-pane-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0].startsWith("https://accounts.google.com/ServiceLogin")).toBe(true);
    expect(destOf(0)).toBe("document");
  });

  it("the marker fallback stays iframe even for a main-surface client (fail closed, #612)", async () => {
    /* the mint-failure fallback commits the marker route, whose
       client is ambiguous between a mint-failed pane and a runtime
       subframe assignment: the surface stamp must fail closed */
    establishContext(VCTX, "c-pane", GOOGLE_HOME, "window", true);
    const marker = "/__zl_nav__/" + b64uEncode(new TextEncoder().encode(SERVICELOGIN));
    transportMock.queue = [textBody()];
    const { ev, armed } = mkEvent(ORIGIN + marker, "navigate", "iframe", "GET", "c-pane", "c-pane-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(destOf(0)).toBe("iframe");
  });
});
