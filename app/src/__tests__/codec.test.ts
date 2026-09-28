import { describe, expect, it, beforeEach } from "vitest";
import {
  encodeDest,
  decodePath,
  isEngineAsset,
  isEnginePath,
  referrerDest,
  setScheme,
  unwrapDest,
} from "../codec";

/* codec keeps rotatable module state (prefix/scheme): reset between
   tests so an order-dependent rotation leak cannot hide a defect. */
beforeEach(() => setScheme("/j/", "b64u"));

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
    setScheme("/zl/", "b64u");
    expect(isEnginePath("/j/abc")).toBe(false);
    const wrapped = "https://example.com" + encodeDest("https://real.dev/x");
    expect(unwrapDest(wrapped)).toBe("https://real.dev/x");
    const page = "https://engine.dev" + encodeDest("https://target.dev/p");
    expect(referrerDest(page, "/l.png")).toBe("https://target.dev/l.png");
  });
});
