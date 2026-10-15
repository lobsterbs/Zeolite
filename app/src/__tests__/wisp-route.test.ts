/* #168: policy route "wisp" surface - the secondary client state
   machine (register/withdraw/normalize) and the transit counter.
   The full altFetch path needs the vendored bundle, which CI vendors;
   here the no-endpoint and no-bundle failures are asserted honestly
   (the same MISSING error the primary client reports). */

import { beforeEach, describe, expect, it } from "vitest";
import { altConfigured, altFetch, altRegister, altReset } from "../libcurl-transport-vendored";
import { transitResetForTests, transitStats, wispRecord } from "../transit";

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
});
