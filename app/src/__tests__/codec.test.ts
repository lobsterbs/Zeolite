import { describe, expect, it, beforeEach } from "vitest";
import {
  b64uEncode,
  encodeDest,
  encodeDestLegacy,
  decodePath,
  isEngineAsset,
  isEnginePath,
  referrerDest,
  setRouteKey,
  setScheme,
  unwrapDest,
} from "../codec";

/* codec keeps rotatable module state (prefix, #55 route key): reset
   between tests so an order-dependent leak cannot hide a defect. */
beforeEach(() => {
  setScheme("/j/");
  setRouteKey(null);
});

describe("unwrapDest", () => {
  it("returns plain destinations unchanged", () => {
    expect(unwrapDest("https://example.com/page")).toBe("https://example.com/page");
    expect(unwrapDest("http://example.com/a?b=1#f")).toBe("http://example.com/a?b=1#f");
  });

  it("peels a single wrapped route bound to the target host", () => {
    const inner = "https://www.google.com/search?q=zeolite";
    const wrapped = "https://www.google.com" + encodeDest(inner);
    expect(unwrapDest(wrapped)).toBe(inner);
  });

  it("peels a multi-layer nested chain down to the real destination", () => {
    // Mirrors the live bug: 4+ layers of /zl/<b64> bound to www.google.com.
    let cur = "https://www.google.com/search?q=test";
    for (let i = 0; i < 4; i++) {
      cur = "https://www.google.com" + encodeDest(cur);
    }
    expect(unwrapDest(cur)).toBe("https://www.google.com/search?q=test");
  });

  it("handles a fragment on the innermost destination", () => {
    const wrapped = "https://example.com" + encodeDest("https://target.dev/page#anchor");
    expect(unwrapDest(wrapped)).toBe("https://target.dev/page#anchor");
  });

  it("stops at the last decodable layer", () => {
    // A layer that decodes to something that is not an http(s) URL stops
    // the peel: the decoded value is returned as the final destination.
    const bad = "https://example.com" + encodeDest("hello");
    expect(unwrapDest(bad)).toBe("hello");
    // A layer whose base64 tail cannot decode at all is left unchanged.
    const undecodable = "https://example.com/j/aGVsbG8~~~~~~";
    expect(unwrapDest(undecodable)).toBe(undecodable);
  });

  it("returns non-http input unchanged", () => {
    expect(unwrapDest("")).toBe("");
    expect(unwrapDest("data:text/plain,hi")).toBe("data:text/plain,hi");
  });
});

describe("referrerDest", () => {
  it("recovers the real home of an escaped same-origin fetch", () => {
    const page = "https://engine.dev" + encodeDest("https://target.dev/some/page.html");
    expect(referrerDest(page, "/img/logo.png")).toBe("https://target.dev/img/logo.png");
    expect(referrerDest(page, "/api?v=1")).toBe("https://target.dev/api?v=1");
  });

  it("null for referrers that are not engine routes", () => {
    expect(referrerDest("https://engine.dev/index.html", "/x")).toBeNull();
    expect(referrerDest("", "/x")).toBeNull();
    expect(referrerDest("not a url", "/x")).toBeNull();
  });

  it("null when the referrer decodes to an opaque destination", () => {
    const page = "https://engine.dev" + encodeDest("about:blank");
    expect(referrerDest(page, "/x")).toBeNull();
  });
});

describe("isEngineAsset", () => {
  it("flags engine-served assets", () => {
    for (const p of [
      "/sw.js",
      "/bootstrap.js",
      "/prelude.js",
      "/worker-prelude.js",
      "/devtools.html",
      "/devtools.js",
      "/index.html",
      "/rewriter_wasm.js",
      "/rewriter_wasm_bg.wasm",
      "/wisp_wasm.js",
      "/wisp_wasm_bg.wasm",
    ]) {
      expect(isEngineAsset(p)).toBe(true);
    }
  });

  it("does not flag engine routes or foreign paths", () => {
    expect(isEngineAsset(decodePath(encodeDest("https://x.dev/"))!)).toBe(false);
    expect(isEngineAsset("/")).toBe(false);
    expect(isEngineAsset("/rules.json")).toBe(false);
    expect(isEngineAsset("/sw.js.bak")).toBe(false);
  });
});

describe("route symmetry after rotation", () => {
  it("unwrap and referrer follow a rotated prefix", () => {
    setScheme("/zl/");
    expect(isEnginePath("/j/abc")).toBe(false);
    const wrapped = "https://example.com" + encodeDest("https://real.dev/x");
    expect(unwrapDest(wrapped)).toBe("https://real.dev/x");
    const page = "https://engine.dev" + encodeDest("https://target.dev/p");
    expect(referrerDest(page, "/l.png")).toBe("https://target.dev/l.png");
  });
});

describe("mirror scheme removal (issue #32)", () => {
  beforeEach(() => setScheme("/j/"));

  it("a /m/ path is not an engine route and does not decode", () => {
    expect(isEnginePath("/m/https://x.dev/")).toBe(false);
    expect(decodePath("/m/https://x.dev/")).toBeNull();
  });

  it("a route never carries the destination verbatim", () => {
    const dest = "https://target.dev/p?q=1";
    const route = encodeDest(dest);
    expect(route).not.toContain("target.dev");
    expect(route).toMatch(/^\/j\//);
    expect(decodePath(route)).toBe(dest);
  });
});

describe("keyed opaque routes (issue #55)", () => {
  /* Pinned interop vector, mirrored by the Rust codec test
     (crates/rewriter/src/encode.rs): key 00..0f, destination below.
     Routes live in history and bookmarks, so the token format is
     frozen - this token must survive every refactor byte for byte. */
  const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
  const DEST = "https://example.com/path?q=1";
  const PINNED = "/j/AfhHzGwm0S7HzQm7oCo2BuN_M9rWothiobfdMNe-Tw2pTYP-gQpzwm3EC7Hy";

  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("mints and decodes the pinned interop token", () => {
    setRouteKey(KEY);
    expect(encodeDest(DEST)).toBe(PINNED);
    expect(decodePath(PINNED)).toBe(DEST);
  });

  it("fails closed without the key, on a wrong key and on junk", () => {
    setRouteKey(null);
    expect(decodePath(PINNED)).toBeNull();
    const wrong = b64uEncode(new Uint8Array(16).map((_, i) => i * 7 + 3));
    setRouteKey(wrong);
    expect(decodePath(PINNED)).toBeNull();
    // Token-shaped junk: first byte 1, 16 IV bytes, 2 body bytes.
    const junk = "/j/" + b64uEncode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 65, 66]));
    expect(decodePath(junk)).toBeNull();
    // A key that is not 16 bytes degrades to legacy, never half-keyed.
    setRouteKey(b64uEncode(new Uint8Array(8)));
    expect(encodeDest(DEST)).toBe(encodeDestLegacy(DEST));
  });

  it("legacy tails always decode, keyed or not (dual decode)", () => {
    const legacy = encodeDestLegacy(DEST);
    expect(legacy).not.toBe(PINNED);
    expect(decodePath(legacy)).toBe(DEST);
    setRouteKey(KEY);
    expect(decodePath(legacy)).toBe(DEST);
  });

  it("a keyed route never carries the destination in the clear", () => {
    setRouteKey(KEY);
    const route = encodeDest("https://secret.example/private/page?x=1");
    expect(route).toMatch(/^\/j\//);
    expect(route).not.toContain("secret.example");
    expect(route).not.toContain("private");
  });
});
