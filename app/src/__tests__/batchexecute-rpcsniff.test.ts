/* #708: an innertube rpc refusal answers HTTP 200 with a batched
   frame whose wrb.fr item has a null payload and a numeric status.
   The sniffer must surface it as a netlog row plus a DIAG entry, and
   stay silent for a healthy batch. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({ body: "" }));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () =>
      new Response(transportMock.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

import { handleFetch } from "../request";
import { netLogCursor, netLogSince } from "../netlog";
import { encodeDestLegacy } from "../codec";
import { isBatchexecuteUrl, parseWrbRefusals } from "../rpcsniff";

const ORIGIN = "https://w.example.org";
const PRELUDE = ")]}'";
const REFUSED_BODY = PRELUDE + "\n\n" + '[["wrb.fr","MI613e",null,null,null,[13],"generic"]]';
const HEALTHY_BODY = PRELUDE + "\n\n" + '[["wrb.fr","UEkKwb","[0,0]",null,null,[1]]]';

let origFetch: typeof fetch;

const mkEvent = (routeUrl: string) => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "POST",
      mode: "cors",
      destination: "empty",
      credentials: "same-origin",
      referrer: "",
      body: null,
      headers: new Headers(),
    },
    clientId: "c-rpc-1",
    resultingClientId: "c-rpc-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

/* The sniffer drains a teed branch, so its row can land a tick after
   the served promise resolves; poll for it instead of guessing. */
const waitRefusedRows = async (before: number, ms = 3000): Promise<ReturnType<typeof netLogSince>> => {
  const t0 = Date.now();
  for (;;) {
    const rows = netLogSince(before).filter(
      (r) => typeof r.verdict === "string" && r.verdict.startsWith("engine: batchexecute rpc refused"),
    );
    if (rows.length > 0 || Date.now() - t0 > ms) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("wrb.fr refusal parser (#708)", () => {
  it("recognizes the observed null-payload refusal shape over the XSSI prelude", () => {
    const refusals = parseWrbRefusals(REFUSED_BODY);
    expect(refusals).toEqual([{ rpc: "MI613e", status: 13 }]);
  });

  it("stays silent for a healthy item with a payload", () => {
    expect(parseWrbRefusals(HEALTHY_BODY)).toEqual([]);
  });

  it("bounds the referee list and classifies only batchexecute URLs", () => {
    expect(
      parseWrbRefusals('[["wrb.fr","A1",null,null,null,[1]],[["wrb.fr","B2",null,null,null,[2]]]]'),
    ).toEqual([{ rpc: "A1", status: 1 }, { rpc: "B2", status: 2 }]);
    expect(isBatchexecuteUrl("https://x.example/batchexecute?rpcids=MI613e")).toBe(true);
    expect(isBatchexecuteUrl("https://x.example/batchexecute-x")).toBe(false);
    expect(isBatchexecuteUrl("not a url")).toBe(false);
  });
});

describe("batchexecute sniffer rows (#708)", () => {
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

  it("a refused rpc over HTTP 200 leaves a sniffer row with the rpc name and status", async () => {
    transportMock.body = REFUSED_BODY;
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/batchexecute?rpcids=MI613e"),
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(REFUSED_BODY);
    const rows = await waitRefusedRows(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "engine: batchexecute rpc refused: MI613e(13)",
      transport: "engine",
      status: 200,
      dest: "https://x.example/batchexecute?rpcids=MI613e",
    });
  });

  it("a healthy batch emits no sniffer row", async () => {
    transportMock.body = HEALTHY_BODY;
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/batchexecute?rpcids=UEkKwb"),
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const rows = await waitRefusedRows(before, 500);
    expect(rows).toHaveLength(0);
  });

  it("a non-batchexecute URL never sniffs even with refusal text in the body", async () => {
    transportMock.body = REFUSED_BODY;
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/other"),
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const rows = await waitRefusedRows(before, 500);
    expect(rows).toHaveLength(0);
  });
});
