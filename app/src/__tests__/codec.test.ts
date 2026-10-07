import { describe, expect, it, beforeEach } from "vitest";
import {
  b64uEncode,
  encodeDest,
  encodeDestLegacy,
  decodePath,
  isEngineAsset,
  isEnginePath,
  looksKeyedToken,
  recoverPath,
  referrerDest,
  setRouteKey,
  setRouteKeys,
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
    /* #73: a legacy layer whose tail decodes to a non-http(s) string
       no longer decodes at all (fail-closed like keyedDecode), so the
       peel stops and the wrapped route is returned unchanged. */
    const bad = "https://example.com" + encodeDest("hello");
    expect(unwrapDest(bad)).toBe(bad);
    // A layer whose base64 tail cannot decode at all is left unchanged.
    const undecodable = "https://example.com/j/aGVsbG8~~~~~~";
    expect(unwrapDest(undecodable)).toBe(undecodable);
  });

  it("legacy tails fail closed on non-http(s) destinations (#73)", () => {
    expect(decodePath(encodeDestLegacy("file:///etc/passwd"))).toBeNull();
    expect(decodePath(encodeDestLegacy("javascript:alert(1)"))).toBeNull();
    expect(decodePath(encodeDestLegacy("wss://attacker/"))).toBeNull();
    // Invalid UTF-8 tail: the strict decoder fails closed, no mojibake.
    expect(decodePath("/j/-A")).toBeNull();
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

  it("resolves a directory-relative tail against the referrer's page URL", () => {
    /* Bug-scout regression: relative tails used to resolve against
       the origin root, so /dir/page.html referencing img/x.png
       recovered /img/x.png instead of /dir/img/x.png. */
    const page = "https://engine.dev" + encodeDest("https://target.dev/some/dir/page.html");
    expect(referrerDest(page, "img/logo.png")).toBe("https://target.dev/some/dir/img/logo.png");
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

  it("roundtrips a >512-byte destination (#100 long-dest interop vector)", () => {
    /* Pinned interop with the Rust codec (crates/rewriter/src/
       encode.rs): same key, same 639-byte destination, same token.
       A long destination spans many keystream blocks, so the token
       format is pinned at that shape too. */
    const LONG = "https://example.com/long/destination?q=" + "x".repeat(600);
    setRouteKey(KEY);
    const route = encodeDest(LONG);
    expect(route).toBe(
      "/j/AU5Yu8quyIPehcTDkGs9lSmUz-vU4HwN0kDyHco1BvLBOU9Hi4bthk9KvCt7G2atQN-25Yl3p9WBTYhb1JQLdcIlxf62NBcFGQ8LbxiaziEuLbK2disqogS8phoDw0rQbRUrn2fEStWkwpsUOrqCePxBxLdQJcAa9PuaKo6QA9L3vwXORFuKVd5_jq7tXEZvIc82pXNi1Xo0TzAAj6h40Bd_ickV_3maVA10U3jeGeldM54heL6iYsYtc2_mZ7jsXQn2E7tIz6ELUi_dhJN7J2wugo159vovPiGslh0UinmQVp_aYr1R5QYH-wJ8B75sobH6e2UEj3Oq_ljlYyBzjFxoVe-fIbxh7VVxKMnEmmMOuzyPv2Ggj5vzAcR5bdlbYmwRLrC6iVqmzQm-8wwh_DzPOLhrPoEi0wcEn5wecQK42JUgg6Mf5bDOAQyoRCQFGGaO54a_rqICmpzAPaDgpTwyPfjwfOAldEqvWJHvGQmV48X2rYOj1Wri96hP1mmsDgHDbkNtDnhVgDDKPl4QSNuiiGoBzmOXgeZ1O3jvdlpVapsaBphATzOAlHoTXz8q7m4WSBp8ldjDO8B8Y1Uy3ZgeMdRi2EViQaIZYDpXVfQaFMx3HpKUHIvTWwwkmWvFZf_AHJSRD1KpttBID3S-LYjtcttJRbVJXvxWpeUbtKDDQOCjPLS6S_baMw6AfZZh5aDAYzznqfQU1aI_43LpiIpRjApd2mQn9WPfBcTjdU_NpjeIRvAwDxz5lzHQfTDjge68RMGrkLxlIBo5bBv2rGXNbTykuyWkF49mKKW2d8e75iySEOu1kNWm97C-HM-v7Yk3AuDa1Me-B660RoYAbBVJ3bkyphKiuE6vWiaWQ2Y",
    );
    expect(decodePath(route)).toBe(LONG);
  });

  it("looksKeyedToken flags token shape without needing the key", () => {
    setRouteKey(KEY);
    expect(looksKeyedToken(encodeDest(DEST))).toBe(true);
    expect(looksKeyedToken(encodeDestLegacy(DEST))).toBe(false);
    setRouteKey(null);
    // A route stranded by a key rotation is still token-shaped, so the
    // SW 404 reason can single it out from a plain bad tail.
    expect(looksKeyedToken(PINNED)).toBe(true);
    expect(looksKeyedToken("/j/aGVsbG8")).toBe(false);
    expect(looksKeyedToken("/j/AQ")).toBe(false);
    expect(looksKeyedToken("/not-engine/j/AQ")).toBe(false);
  });
});

describe("recoverPath (concatenated tails)", () => {
  /* The JS literal pass mints a keyed route for a URL-shaped literal
     that is only a fragment; runtime concatenation appends the rest
     after the token, so the request path is <token><plaintext> and
     decodePath 404s. recoverPath retries every prefix as a
     MAC-verified token and appends the remainder verbatim. */
  const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i * 5 + 1));
  const R = "/zl/";

  it("recovers a fragment token with the rest of the URL appended", () => {
    setScheme(R);
    setRouteKeys([KEY]);
    const token = encodeDest("https://simple").slice(R.length);
    expect(recoverPath(R + token + "analyticscdn.com/simple.gif")).toBe(
      "https://simpleanalyticscdn.com/simple.gif",
    );
  });

  it("recovers a host-only token with an absolute path appended", () => {
    setScheme(R);
    setRouteKeys([KEY]);
    const token = encodeDest("https://example.com").slice(R.length);
    expect(recoverPath(R + token + "/fonts/x.woff2")).toBe("https://example.com/fonts/x.woff2");
  });

  it("keeps query and fragment outside the recovered tail", () => {
    setScheme(R);
    setRouteKeys([KEY]);
    const token = encodeDest("https://example.com").slice(R.length);
    expect(recoverPath(R + token + "/a.png?x=1#f")).toBe("https://example.com/a.png");
  });

  it("returns null for a plaintext tail: no token prefix", () => {
    setScheme(R);
    setRouteKeys([KEY]);
    expect(recoverPath(R + "img/goats.mp4")).toBeNull();
  });

  it("returns null when the minting key left the decode history", () => {
    setScheme(R);
    setRouteKeys([KEY]);
    const token = encodeDest("https://example.com/a.png").slice(R.length);
    setRouteKeys([b64uEncode(new Uint8Array(16).fill(9))]);
    expect(recoverPath(R + token + "/b.png")).toBeNull();
  });

  it("returns null without a route key: legacy tails are refused", () => {
    setScheme(R);
    setRouteKeys([]);
    const tail = encodeDestLegacy("https://example.com/a.png").slice(R.length);
    expect(recoverPath(R + tail + "/b.png")).toBeNull();
  });

  it("rejects a hostile token-shaped tail fast, not quadratic", () => {
    /* Availability regression: the old per-L rescan re-decoded the
       tail for every prefix length with a per-byte SipHash; a single
       crafted request could freeze the shared worker for seconds.
       The gate must kill a wrong-key tail in constant time. */
    setScheme(R);
    setRouteKeys([KEY]);
    const t0 = Date.now();
    /* "AQ" decodes to a 0x01 lead byte, so the shape check passes and
       the wrong-key gate is what must reject it, fast. */
    expect(recoverPath(R + "AQ" + "A".repeat(2000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("rejects a hostile tail when the plaintext carries non-b64u chars", () => {
    /* The appended plaintext after a real token contains "/" and "."
       (not b64u): recovery must still find the token prefix before
       the first invalid char. */
    setScheme(R);
    setRouteKeys([KEY]);
    const token = encodeDest("https://example.com/a/b.png").slice(R.length);
    expect(recoverPath(R + token + "/more/path.gif")).toBe("https://example.com/a/b.png/more/path.gif");
  });
});
