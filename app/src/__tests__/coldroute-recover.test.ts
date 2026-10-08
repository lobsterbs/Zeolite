import { beforeEach, describe, expect, it } from "vitest";
import { b64uEncode, decodeLegacyRoute, encodeDest, setRouteKey, setScheme } from "../codec";

/* #113: decodeLegacyRoute recovers a legacy route minted under a
   prefix the worker has not configured yet (cold start), the shape
   decodePath cannot see. */
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(null);
});

describe("decodeLegacyRoute (#113)", () => {
  it("recovers a historical /zl/ tail under the default shape", () => {
    const tail = b64uEncode(ENC.encode("https://example.com/search?q=hi"));
    expect(decodeLegacyRoute("/zl/" + tail)).toBe("https://example.com/search?q=hi");
  });

  it("recovers a tail under the configured prefix", () => {
    setScheme("/q/");
    const tail = b64uEncode(ENC.encode("https://example.com/page"));
    expect(decodeLegacyRoute("/q/" + tail)).toBe("https://example.com/page");
  });

  it("fails closed on a keyed tail", () => {
    setRouteKey(KEY);
    const route = encodeDest("https://example.com/page");
    expect(decodeLegacyRoute("/zl/" + route.slice(3))).toBeNull();
  });

  it("never captures host routes or engine assets", () => {
    const tail = b64uEncode(ENC.encode("https://example.com/x"));
    expect(decodeLegacyRoute("/r/" + tail)).toBeNull();
    expect(decodeLegacyRoute("/lj/" + tail)).toBeNull();
    expect(decodeLegacyRoute("/sw.js")).toBeNull();
  });

  it("refuses garbage, non-http payloads, deeper paths and nav handles", () => {
    expect(decodeLegacyRoute("/zl/not b64!!")).toBeNull();
    expect(decodeLegacyRoute("/zl/" + b64uEncode(ENC.encode("ftp://x")))).toBeNull();
    expect(decodeLegacyRoute("/zl/a/b")).toBeNull();
    expect(decodeLegacyRoute("/__zl_navh__/abc")).toBeNull();
  });
});
