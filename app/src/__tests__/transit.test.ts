import { describe, expect, it, beforeEach } from "vitest";
import {
  decideTransport,
  refineWithContent,
  originOf,
  transitRecord,
  transitStats,
  transitResetForTests,
} from "../transit";

beforeEach(() => transitResetForTests());

describe("originOf", () => {
  it("parses scheme/host/port", () => {
    expect(originOf("https://example.com/api")).toEqual({
      scheme: "https",
      host: "example.com",
      port: null,
    });
    expect(originOf("http://host:8080/")).toEqual({ scheme: "http", host: "host", port: 8080 });
    expect(originOf("not a url")).toBeNull();
  });
});

describe("decideTransport", () => {
  it("native for transportable resources", () => {
    for (const dest of ["script", "image", "font", "empty", "style-link"]) {
      expect(decideTransport("https://example.com/app.js", dest)).toEqual({ mode: "NativeTransit" });
    }
  });
  it("document loads are deterministic rewrite fallback", () => {
    expect(decideTransport("https://example.com/", "document")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "DOCUMENT_REWRITE_REQUIRED",
    });
    expect(decideTransport("https://example.com/embed", "iframe")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "DOCUMENT_REWRITE_REQUIRED",
    });
  });
  it("non-http(s) schemes cannot be handled natively", () => {
    expect(decideTransport("ftp://example.com/file", "document")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "UNSUPPORTED_PROTOCOL",
    });
    expect(decideTransport("::bad::", "script")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "UNSUPPORTED_PROTOCOL",
    });
  });
});

describe("refineWithContent", () => {
  it("html/css bodies force the rewrite path", () => {
    const native = { mode: "NativeTransit" as const };
    expect(refineWithContent(native, "text/html")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "DOCUMENT_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "TEXT/CSS")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "CSS_URL_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "image/png")).toEqual({ mode: "NativeTransit" });
    expect(refineWithContent({ mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" }, "image/png"))
      .toEqual({ mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" });
  });
});

describe("transitRecord", () => {
  it("counts native and fallback separately", () => {
    transitRecord("t1", "https://a.com/x.js", { mode: "NativeTransit" });
    transitRecord("t2", "https://a.com/", { mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" });
    const s = transitStats();
    expect(s.native).toBe(1);
    expect(s.fallback).toBe(1);
    expect(s.fallbacks).toHaveLength(1);
    expect(s.fallbacks[0].reason).toBe("DOCUMENT_REWRITE_REQUIRED");
    expect(s.fallbacks[0].traceId).toBe("t2");
  });
  it("fallback ring stays bounded", () => {
    for (let i = 0; i < 80; i++) {
      transitRecord("t" + i, "https://a.com/" + i, { mode: "RewriteFallback", fallbackReason: "UNSUPPORTED_PROTOCOL" });
    }
    const s = transitStats();
    expect(s.fallback).toBe(80);
    expect(s.fallbacks.length).toBeLessThanOrEqual(64);
    expect(s.fallbacks[s.fallbacks.length - 1].url).toBe("https://a.com/79");
  });
  it("fallback emits a diag event (never silent)", async () => {
    const { DIAG } = await import("../diag");
    const before = DIAG.snapshot(0).events.length;
    transitRecord("t9", "https://a.com/", { mode: "RewriteFallback", fallbackReason: "CSS_URL_REWRITE_REQUIRED" });
    const evs = DIAG.snapshot(0).events.slice(before);
    expect(evs.some((e) => e.stage === "TRANSPORT_FALLBACK" && e.url === "https://a.com/")).toBe(true);
  });
});
