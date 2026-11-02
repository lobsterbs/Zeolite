import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* sw-torture follow-up (wave-32 wedge class): jarProfilesReady was the
   one pre-engine boot await in the fetch handler WITHOUT a raceBoot
   bound - every sibling (legacy-cache discard, jar-root recovery,
   engine boot, route restore) already rode one. A Cache Storage open
   or match in the profile store that never settles wedged EVERY
   proxied fetch forever, while zl:ping (control plane) still answered.

   This file needs its own module registry: jarProfilesReady memoizes
   its promise, so the wedge only manifests on the FIRST fetch after
   worker evaluation - sharing a file with other handleFetch tests
   would find the promise already settled.

   Real timers, like boot-wedge.test.ts: the bound is 1.5s per step
   and the regression IS the wall-clock settle. */

const transportMock = vi.hoisted(() => ({ calls: 0, urls: [] as string[] }));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { b64uEncode, encodeDestLegacy, setRouteKey, setScheme } from "../codec";
import { DIAG } from "../diag";

const ORIGIN = "https://engine.example";
const DEST = "https://site.example/x?y=1";
const hang = (): Promise<never> => new Promise(() => {});

beforeEach(async () => {
  /* settle the module-eval route restore first, then pin the route key
     (a fresh idb mints its own key; the encoded route must decode with
     THIS key - see prel-nav-clean.test.ts). */
  await routeReady;
  setScheme("/j/");
  setRouteKey(b64uEncode(new Uint8Array(16).map((_, i) => i + 32)));
  transportMock.calls = 0;
  transportMock.urls = [];
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });
  /* Hang EXACTLY the jar-profile snapshot read ("profiles"); every
     other cache read resolves as a miss so the rest of the boot chain
     moves. */
  vi.stubGlobal("caches", {
    delete: async () => true,
    open: async () => ({
      match: (k: unknown) => (String(k).includes("profiles") ? hang() : Promise.resolve(undefined)),
      put: async () => true,
    }),
  });
});

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

describe("jar-profile restore is bounded in the fetch gate", () => {
  it(
    "serves a navigation when the profile snapshot read never settles",
    async () => {
      const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(DEST));
      handleFetch(ev);
      /* pre-fix: this await never settles (every proxied request
         wedged); post-fix: the pre-engine deadline reads the hang as
         a miss and the fetch proceeds on the fail-closed profile
         default (cookies off until the host rebinds). */
      const served = await armed[0]!;

      expect(served.status).toBe(200);
      expect(transportMock.calls).toBe(1);
      expect(transportMock.urls[0]).toBe(DEST);
      expect(DIAG.snapshot(0).events.some((e) => e.message.includes("jar profile restore"))).toBe(true);
    },
    20000,
  );
});
