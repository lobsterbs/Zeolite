/* #383: a prel navigation under a non-handle parent (legacy /zl/<b64>,
   marker routes) now answers a freshly minted handle, not the opaque
   prel form. The handle must keep the real query visible and decode
   back to the destination. Route-level behaviour (the 302) needs the
   wasm bundle; the minting invariant is pinned here. */

import { beforeEach, describe, expect, it } from "vitest";
import { b64uEncode, buildNavHandleUrl, decodeNavHandlePath, mintableDest, setRouteKey, setScheme } from "../codec";

const KEY_A = b64uEncode(new Uint8Array(16).map((_, i) => i));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY_A);
});

describe("prel clean form for any parent (#383)", () => {
  const dest = "https://www.google.com/search?q=magnet+physics&sei=abc123";

  it("mints a handle whose visible suffix keeps the real query", () => {
    expect(mintableDest(dest)).toBe(true);
    const url = buildNavHandleUrl(dest)!;
    expect(url).not.toBeNull();
    expect(url).toContain("/__zl_navh__/");
    const u = new URL(url, "https://engine.test");
    expect(u.search).toBe("?q=magnet+physics&sei=abc123");
  });

  it("the minted handle decodes back to the destination", () => {
    const url = buildNavHandleUrl(dest)!;
    const u = new URL(url, "https://engine.test");
    const tail = u.pathname.slice("/__zl_navh__/".length);
    expect(decodeNavHandlePath(tail)).toBe("https://www.google.com/search");
  });

  it("refuses non-http destinations, so the prel form is kept for them", () => {
    expect(mintableDest("javascript:alert(1)")).toBe(false);
    expect(mintableDest("file:///etc/passwd")).toBe(false);
  });
});
