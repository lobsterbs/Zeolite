/* #168: policy route "wisp" surface - the secondary client state
   machine (register/withdraw/normalize) and the transit counter.
   The full altFetch path needs the vendored bundle, which CI vendors;
   here the no-endpoint and no-bundle failures are asserted honestly
   (the same MISSING error the primary client reports). */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { altConfigured, altEndpoint, altFetch, altRegister, altReset, altStateForTests } from "../libcurl-transport-vendored";
import { transitResetForTests, transitStats, wispRecord } from "../transit";
import { persistRoute } from "../request";

describe("wisp route secondary client (#168)", () => {
  beforeEach(() => {
    altRegister("");
    altReset();
    transitResetForTests();
  });

  it("registers and withdraws the announced endpoint", () => {
    expect(altConfigured()).toBe(false);
    altRegister("wss://public.example/");
    expect(altConfigured()).toBe(true);
    altRegister("");
    expect(altConfigured()).toBe(false);
  });

  it("normalizes a missing trailing slash (the client requires one)", async () => {
    altRegister("wss://public.example/no-slash");
    expect(altConfigured()).toBe(true);
    /* The bundle is not vendored in the test environment, so the fetch
       fails with the same honest MISSING error the primary reports
       after URL normalization. */
    await expect(altFetch("https://example.com/")).rejects.toThrow(/not vendored/);
  });

  it("ignores non-ws(s) urls honestly", () => {
    altRegister("https://not-a-wisp.example/");
    expect(altConfigured()).toBe(false);
  });

  it("altFetch without an endpoint names the gap", async () => {
    await expect(altFetch("https://example.com/")).rejects.toThrow(
      /without an announced public endpoint/,
    );
  });

  it("wispRecord counts into transitStats", () => {
    expect(transitStats().wisp).toBe(0);
    wispRecord();
    wispRecord();
    expect(transitStats().wisp).toBe(2);
    transitResetForTests();
    expect(transitStats().wisp).toBe(0);
  });
  it("altEndpoint exposes the normalized endpoint for the persistence seam", () => {
    expect(altEndpoint()).toBeNull();
    altRegister("wss://public.example");
    expect(altEndpoint()).toBe("wss://public.example/");
    altRegister("");
    expect(altEndpoint()).toBeNull();
  });

  it("altReset busts the transport cache generation (#133 parity)", () => {
    altRegister("wss://public.example/");
    const g0 = altStateForTests().generation;
    altReset();
    expect(altStateForTests().generation).toBe(g0 + 1);
    /* The announced endpoint survives the reset: the next wisp-routed
       fetch re-initializes toward the same url on a fresh socket. */
    expect(altStateForTests().url).toBe("wss://public.example/");
  });

  it("a withdraw then re-register never reuses the old generation", () => {
    altRegister("wss://public.example/");
    const g0 = altStateForTests().generation;
    altRegister("");
    expect(altStateForTests().generation).toBe(g0 + 1);
    expect(altEndpoint()).toBeNull();
    altRegister("wss://public.example/");
    expect(altStateForTests().generation).toBe(g0 + 2);
    expect(altEndpoint()).toBe("wss://public.example/");
  });

  it("persistRoute carries the announced endpoint in the route shape", async () => {
    /* An idle-killed worker instance restores the endpoint from this
       blob (request.ts routeReady reads it back); the shape must
       contain the endpoint while configured and omit it after a
       withdraw. */
    const puts: { url: string; body: string }[] = [];
    vi.stubGlobal("self", { registration: { scope: "https://engine.test/" } });
    vi.stubGlobal("caches", {
      open: async () => ({
        put: async (url: string, res: Response) => {
          puts.push({ url, body: await res.text() });
        },
      }),
    });
    try {
      altRegister("wss://public.example");
      await persistRoute("/j/");
      expect(puts.length).toBe(1);
      expect(puts[0].url).toBe("https://engine.test/route-config.kdl");
      expect(puts[0].body).toContain('wisp-endpoint "wss://public.example/"');
      altRegister("");
      await persistRoute("/j/");
      expect(puts.length).toBe(2);
      expect(puts[1].body).not.toContain("wisp-endpoint");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
