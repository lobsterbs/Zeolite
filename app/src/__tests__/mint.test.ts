import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uDecode,
  b64uEncode,
  decodePath,
  encodeDest,
  encodeDestLegacy,
  mintableDest,
  setRouteKey,
  setScheme,
} from "../codec";

/* Issue #54 residual 1: the page-realm mint seam. zl:mint is the
   control message by which a proxied page asks the SW to mint an
   opaque route for a destination. These tests pin its contract:
   which destinations are mintable, and what the minted route
   guarantees with and without a route key. Admitting the message
   to proxied pages is not a capability change: the legacy codec
   is page-public, a page can always encode a route itself. */

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(null);
});

describe("mintableDest (#54 seam)", () => {
  it("accepts absolute http(s) destinations", () => {
    expect(mintableDest("https://example.com/")).toBe(true);
    expect(mintableDest("http://example.com/path?q=1")).toBe(true);
    expect(mintableDest("https://target.dev:8443/x#f")).toBe(true);
  });

  it("rejects relative paths, non-http schemes and garbage", () => {
    expect(mintableDest("/path")).toBe(false);
    expect(mintableDest("example.com")).toBe(false);
    expect(mintableDest("about:blank")).toBe(false);
    expect(mintableDest("javascript:alert(1)")).toBe(false);
    expect(mintableDest("data:text/plain,hi")).toBe(false);
    expect(mintableDest("")).toBe(false);
  });
});

describe("minted route contract (#54 seam)", () => {
  it("roundtrips a destination with and without a route key", () => {
    const dest = "https://example.com/page?q=1";
    expect(decodePath(encodeDest(dest))).toBe(dest);
    setRouteKey(b64uEncode(new Uint8Array(16).map((_, i) => i)));
    expect(decodePath(encodeDest(dest))).toBe(dest);
  });

  it("a keyed mint never carries the destination decodably", () => {
    setRouteKey(b64uEncode(new Uint8Array(16).map((_, i) => i)));
    const dest = "https://secret.example/private";
    const route = encodeDest(dest);
    expect(route).toMatch(/^\/j\//);
    expect(route).not.toContain("secret");
    // Without the key the route fails closed...
    setRouteKey(null);
    expect(decodePath(route)).toBeNull();
    // ...and the legacy codec cannot recover it either.
    const tail = route.slice("/j/".length).split(/[?#]/)[0];
    expect(new TextDecoder().decode(b64uDecode(tail)!)).not.toContain("secret");
  });

  it("a rotated key strands existing routes; a fresh mint rides the new key", () => {
    setRouteKey(b64uEncode(new Uint8Array(16).map((_, i) => i)));
    const old = encodeDest("https://rotate.example/private");
    /* Rotation: every route minted under the old key fails closed;
       minting under the new one keeps working. */
    setRouteKey(b64uEncode(new Uint8Array(16).map((_, i) => 255 - i)));
    expect(decodePath(old)).toBeNull();
    expect(decodePath(encodeDest("https://rotate.example/private"))).toBe("https://rotate.example/private");
  });

  it("a keyless mint degrades to the legacy shape, still a valid route", () => {
    const dest = "https://example.com/x";
    expect(encodeDest(dest)).toBe(encodeDestLegacy(dest));
    expect(decodePath(encodeDest(dest))).toBe(dest);
  });
});
