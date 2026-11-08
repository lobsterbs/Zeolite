import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #609: under strict opacity the fallback seams keep serving (a
   refusal would strand the page) but record one opacity-downgrade
   diagnostic row per (seam, site) per worker lifetime. A legacy
   route that decodes through decodePath is the canonical case:
   the route reached the browser decodable. */

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
import { VCTX, setStrictOpacity } from "../swstate";
import { b64uEncode, setRouteKey } from "../codec";
import { DIAG } from "../diag";

const ORIGIN = "https://e.example";

const legacyTail = (dest: string) => b64uEncode(new TextEncoder().encode(dest));

const mkEvent = (clientId: string | undefined, pathname: string) => {
  const armed: Array<Promise<Response>> = [];
  const ev = {
    request: new Request(ORIGIN + pathname),
    clientId,
    resultingClientId: "",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const downgradeRows = () =>
  DIAG.snapshot(0).events.filter((e) => e.message.startsWith("opacity downgrade: "));

beforeEach(() => {
  transportMock.calls = 0;
  VCTX.clear();
  setRouteKey(null);
  setStrictOpacity(false);
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
  setStrictOpacity(false);
});

describe("strict opacity downgrade rows (#609)", () => {
  it("serves a legacy route but records the downgrade under strict mode", async () => {
    setStrictOpacity(true);
    establishContext(VCTX, "c-609", "https://page.example/");
    const first = mkEvent("c-609", "/j/" + legacyTail("https://x609.example/a"));
    handleFetch(first.ev);
    const served = await first.armed[0]!;
    expect(served.status).toBe(200);
    const rows = downgradeRows();
    expect(rows.length).toBe(1);
    expect(rows[0].message).toContain("opacity downgrade: legacy route");
    expect(rows[0].message).toContain("site https://x609.example");
    expect(rows[0].severity).toBe("warning");
  });

  it("bounds the memo: one row per site per worker lifetime", async () => {
    setStrictOpacity(true);
    establishContext(VCTX, "c-609b", "https://page.example/");
    const before = downgradeRows().length;
    const one = mkEvent("c-609b", "/j/" + legacyTail("https://z609.example/b"));
    handleFetch(one.ev);
    await one.armed[0]!;
    const two = mkEvent("c-609b", "/j/" + legacyTail("https://z609.example/c"));
    handleFetch(two.ev);
    await two.armed[0]!;
    expect(downgradeRows().length).toBe(before + 1);
  });

  it("emits no downgrade rows in compat mode (strict off)", async () => {
    establishContext(VCTX, "c-609c", "https://page.example/");
    const before = downgradeRows().filter((e) => e.message.includes("y609.example")).length;
    const req = mkEvent("c-609c", "/j/" + legacyTail("https://y609.example/a"));
    handleFetch(req.ev);
    await req.armed[0]!;
    expect(downgradeRows().filter((e) => e.message.includes("y609.example")).length).toBe(before);
  });
});
