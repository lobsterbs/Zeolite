/* #708: every error response the worker answers before any
   transport dispatch leaves a netlog row with the failing stage. The
   pin-191 dead-POST class (net::ERR_FAILED page-side, zero ring
   entries) was invisible in the KDL network export because only DIAG
   saw these failures. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () =>
      new Response("mock", { headers: { "content-type": "text/plain" } }),
  },
}));

/* Test 3 drives the orchestration catch with a boot step that
   rejects (rejections propagate unchanged through raceBoot). */
vi.mock("../cookies", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../cookies")>();
  return {
    ...orig,
    jarProfilesReady: () => Promise.reject(new Error("pond-boot")),
  };
});

import { handleFetch } from "../request";
import { netLogCursor, netLogSince } from "../netlog";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://w.example.org";
let origFetch: typeof fetch;

const mkEvent = (routeUrl: string, mode: string, destination: string) => {
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
    clientId: "c-pre-1",
    resultingClientId: "c-pre-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

describe("pre-dispatch failure rows (#708)", () => {
  beforeEach(() => {
    origFetch = globalThis.fetch;
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

  it("a bad blob-worker token refusal leaves exactly one ring row with the stage", async () => {
    const before = netLogCursor();
    const { ev, armed } = mkEvent(ORIGIN + "/zl-bw/?c=bogus", "cors", "worker");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(404);
    const rows = netLogSince(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "engine: pre-dispatch failure: blob-worker token",
      transport: "engine",
      status: 404,
      path: "/zl-bw/?c=bogus",
    });
  });

  it("a failed worker prelude asset leaves exactly one ring row with the error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("pond");
    }) as typeof fetch;
    const before = netLogCursor();
    const { ev, armed } = mkEvent("blob:" + ORIGIN + "/u-1", "cors", "worker");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(502);
    const rows = netLogSince(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "engine: pre-dispatch failure: worker prelude",
      transport: "engine",
      status: 502,
    });
    expect(rows[0]!.err).toContain("pond");
  });

  it("a pre-pipeline orchestration rejection leaves a ring row, not silent dead air", async () => {
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/api"),
      "cors",
      "empty",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(502);
    const rows = netLogSince(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "engine: pre-dispatch failure: orchestration",
      transport: "engine",
      status: 502,
    });
    expect(rows[0]!.err).toContain("pond-boot");
    expect(typeof rows[0]!.traceId).toBe("string");
  });
});
