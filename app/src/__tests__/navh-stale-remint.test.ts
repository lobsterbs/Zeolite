/* #385: a handle past its 120 s TTL is still MAC-verifiable. The SW
   re-mints it only for the root client it was minted for. These cover
   the codec side (live, stale, tampered, root). The route-level 302 and
   the isRootClient check need the wasm bundle, so they are not here. */

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { b64uEncode, decodeNavHandle, encodeNavHandle, navHandleStale, NAVH_TTL_MS, setRouteKey, setScheme } from "../codec";

const KEY_A = b64uEncode(new Uint8Array(16).map((_, i) => i));
const DEST = "https://www.google.com/search?q=x";

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY_A);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("navHandleStale (#385)", () => {
  it("live token: not stale, and decodes normally", () => {
    const tok = encodeNavHandle(DEST, undefined, "root-A")!;
    expect(decodeNavHandle(tok)).toBe("https://www.google.com");
    expect(navHandleStale(tok)).toBeNull();
  });

  it("expired token: decode fails, but the MAC-verified destination and root are recoverable", () => {
    const tok = encodeNavHandle(DEST, undefined, "root-A")!;
    vi.setSystemTime(new Date(Date.now() + NAVH_TTL_MS + 1000));
    expect(decodeNavHandle(tok)).toBeNull();
    expect(navHandleStale(tok)).toEqual({ destination: "https://www.google.com", rootClientId: "root-A" });
  });

  it("a re-mint for the stale destination is live again", () => {
    const tok = encodeNavHandle(DEST, undefined, "root-A")!;
    vi.setSystemTime(new Date(Date.now() + NAVH_TTL_MS + 1000));
    const stale = navHandleStale(tok)!;
    const fresh = encodeNavHandle(stale.destination, undefined, stale.rootClientId)!;
    expect(fresh).not.toBe(tok);
    expect(decodeNavHandle(fresh)).toBe("https://www.google.com");
  });

  it("a tampered expired token is not recoverable", () => {
    const tok = encodeNavHandle(DEST, undefined, "root-A")!;
    vi.setSystemTime(new Date(Date.now() + NAVH_TTL_MS + 1000));
    const bad = tok.slice(0, -2) + (tok.endsWith("AA") ? "BB" : "AA");
    expect(navHandleStale(bad)).toBeNull();
  });

  it("a garbage token is not stale", () => {
    expect(navHandleStale("not-a-token")).toBeNull();
  });
});
