/* #500: rules-blocked requests must fail at the network level, like a
   real blocker. Block-tester sites count only fetch rejections; a
   synthetic 403 response resolves the fetch and the block stays
   invisible to the page. Navigations keep the engine error page. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      transportMock.calls++;
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch } from "../request";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://w.example.org";
let origFetch: typeof fetch;

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

describe("rules-blocked requests fail at the network level (#500)", () => {
  beforeEach(() => {
    transportMock.calls = 0;
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('block "tracker.example"', { status: 200 })) as typeof fetch;
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
    globalThis.fetch = origFetch;
    vi.unstubAllGlobals();
  });

  it("a blocked fetch answers a network error, never upstream (#500)", async () => {
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://tracker.example/ad.js"),
      "c-block-1",
      "cors",
      "empty",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.type).toBe("error");
    expect(served.status).toBe(0);
    expect(transportMock.calls).toBe(0);
  });

  it("a blocked navigation keeps the engine 403 error page (#500)", async () => {
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://tracker.example/"),
      "c-block-2",
      "navigate",
      "document",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(403);
    expect(transportMock.calls).toBe(0);
  });
});
