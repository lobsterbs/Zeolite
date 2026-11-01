import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Wave-32 wedge class (ai117 churn probe): the fetch handler awaits
   browser API calls (clients.get, caches.delete, caches.open/match)
   BEFORE the navigation deadline arms. A call that never settles wedged
   the request with no bound at all: the reload never committed, and a
   hung UI-asset request parked the tab empty (the grey-screen class).
   Each such await now rides raceBoot (#249): past PRE_DEADLINE_BOUND_MS
   the fetch proceeds on the same degraded path an exception already
   takes, and DIAG names the wedged step. Real timers, not fake ones:
   the bound is 1.5s per step and the regression IS the wall-clock
   settle (the pre-fix handler never answered at all). */

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
import { b64uEncode, encodeDestLegacy, setRouteKey, setScheme } from "../codec";

const ORIGIN = "https://engine.example";
const DEST = "https://site.example/x?y=1";

const mkEvent = (routeUrl: string) => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "GET",
      mode: "navigate",
      destination: "document",
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

const hang = (): Promise<never> => new Promise(() => {});
let legacyCacheDeleteStarted = false;
let rootRecoveryStartedWhileLegacyCleanupPending = false;

beforeEach(async () => {
  legacyCacheDeleteStarted = false;
  rootRecoveryStartedWhileLegacyCleanupPending = false;
  /* settle the module-eval route restore first, then pin the route key
     (a fresh idb mints its own key; the encoded route must decode with
     THIS key - see prel-nav-clean.test.ts). */
  await routeReady;
  setScheme("/j/");
  setRouteKey(b64uEncode(new Uint8Array(16).map((_, i) => i + 32)));
  transportMock.calls = 0;
  transportMock.urls = [];
  transportMock.queue = [];
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    clients: {
      get: () => {
        rootRecoveryStartedWhileLegacyCleanupPending = legacyCacheDeleteStarted;
        return hang();
      },
    },
  });
  vi.stubGlobal("caches", {
    delete: () => {
      legacyCacheDeleteStarted = true;
      return hang();
    },
    open: async () => {
      throw new Error("no cache storage");
    },
  });
});

describe("pre-deadline awaits are bounded (wave-32 wedge class)", () => {
  it(
    "serves a navigation when clients.get and caches.delete never settle",
    async () => {
      const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(DEST));
      handleFetch(ev);
      /* The cache cleanup remains unresolved when client-root recovery
         begins, proving independent gates overlap without a clock bound. */
      const served = await armed[0]!;

      expect(legacyCacheDeleteStarted).toBe(true);
      expect(rootRecoveryStartedWhileLegacyCleanupPending).toBe(true);
      expect(served.status).toBe(200);
      expect(transportMock.calls).toBe(1);
      expect(transportMock.urls[0]).toBe(DEST);
    },
    20000,
  );

  it(
    "serves a navigation when the page-cache match never settles",
    async () => {
      vi.stubGlobal("caches", {
        delete: async () => true,
        open: async () => ({ match: () => hang() }),
      });
      const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(DEST));
      handleFetch(ev);
      /* the hung cache match reads as a miss past its bound; the live
         path owns the request */
      const served = await armed[0]!;

      expect(served.status).toBe(200);
      expect(transportMock.calls).toBe(1);
      expect(transportMock.urls[0]).toBe(DEST);
    },
    20000,
  );
});
