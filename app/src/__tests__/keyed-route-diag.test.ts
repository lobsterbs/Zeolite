import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #290: a token-shaped route no held key decodes strands the request
   with a 404 and a #100 diag event. The /sorry bot-wall capture showed
   that event could not attribute the miss to the page that minted the
   token, so the diag now records the requesting client virtual URL
   (when the worker knows the client) alongside the opaque route. The
   transport must never be reached: an undecodable route is a strand,
   not a guessed upstream fetch. */

const transportMock = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      transportMock.calls++;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { handleFetch } from "../request";
import { establishContext } from "../vctx";
import { VCTX } from "../swstate";
import { b64uEncode } from "../codec";
import { DIAG } from "../diag";

const ORIGIN = "https://e.example";

/* A v1-token-shaped tail: 0x01 plus filler. Looks keyed by shape;
   no held key decodes it, so the fetch handler must strand it. */
const fakeToken = b64uEncode(new Uint8Array([1, ...new Array(45).fill(0x41)]));

const mkEvent = (clientId: string | undefined) => {
  const armed: Array<Promise<Response>> = [];
  const ev = {
    request: new Request(ORIGIN + "/j/" + fakeToken),
    clientId,
    resultingClientId: "",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const lastDecodeDiag = () => {
  const evs = DIAG.snapshot(0).events.filter((e) => e.message === "keyed route decode failed (route key rotated?)");
  return evs[evs.length - 1];
};

beforeEach(() => {
  transportMock.calls = 0;
  VCTX.clear();
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
});
describe("keyed route decode failure diagnostics (#100/#290)", () => {
  it("strands an undecodable token-shaped route with 404 and no upstream fetch", async () => {
    const { ev, armed } = mkEvent("c-290");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(404);
    expect(await served.text()).toBe("zeolite: undecodable keyed route (route key rotated?)");
    expect(transportMock.calls).toBe(0);
  });

  it("names the requesting page in the diag when the client context is known (#290)", async () => {
    const page = "https://page.example/sorry/index?hl=en&q=abc";
    establishContext(VCTX, "c-290", page);
    const { ev, armed } = mkEvent("c-290");
    handleFetch(ev);
    await armed[0]!;
    const diag = lastDecodeDiag();
    expect(diag).toBeTruthy();
    expect(diag!.technicalReason).toContain("tail " + fakeToken.length + " chars");
    expect(diag!.technicalReason).toContain("requesting page " + page);
    expect(diag!.url).toBe(ORIGIN + "/j/" + fakeToken);
  });

  it("omits the page attribution when no context exists and still strands", async () => {
    const { ev, armed } = mkEvent("c-unknown");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(404);
    const diag = lastDecodeDiag();
    expect(diag).toBeTruthy();
    expect(diag!.technicalReason).not.toContain("requesting page");
    expect(transportMock.calls).toBe(0);
  });
});
