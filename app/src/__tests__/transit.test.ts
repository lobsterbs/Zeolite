import { describe, expect, it, beforeEach } from "vitest";
import {
  decideTransport,
  refineWithContent,
  originOf,
  transitRecord,
  transitStats,
  transitResetForTests,
  docKind,
  sniffsAsHtml,
  DOC_DESTS,
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
  /* Issue E: embed, fencedframe and xslt used to fall through to
     NativeTransit; they load documents like iframe/object do. */
  it("embed, fencedframe and xslt destinations require the rewrite path", () => {
    for (const dest of DOC_DESTS) {
      expect(decideTransport("https://example.com/x", dest)).toEqual({
        mode: "RewriteFallback",
        fallbackReason: "DOCUMENT_REWRITE_REQUIRED",
      });
    }
  });
});

/* Issue C: one classification for the SW's rewrite branches and the
   refinement; XHTML documents are HTML to the rewriter. */
describe("docKind", () => {
  it("html for text/html and application/xhtml+xml", () => {
    expect(docKind("text/html")).toBe("html");
    expect(docKind("text/html; charset=shift_jis")).toBe("html");
    expect(docKind("application/xhtml+xml")).toBe("html");
    expect(docKind("APPLICATION/XHTML+XML")).toBe("html");
  });
  it("css for text/css", () => {
    expect(docKind("text/css")).toBe("css");
    expect(docKind("text/css; charset=utf-8")).toBe("css");
  });
  it("none for everything else", () => {
    expect(docKind("image/svg+xml")).toBe("none");
    expect(docKind("application/xml")).toBe("none");
    expect(docKind("application/javascript")).toBe("none");
    expect(docKind("")).toBe("none");
  });
});

/* Issue C: the browser sniffs html for content-type-less navigations;
   the SW sniffs the same way so such documents join the rewrite path
   instead of leaking absolute links past the engine. */
describe("sniffsAsHtml", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it("recognizes document opens", () => {
    expect(sniffsAsHtml(enc("<!doctype html><html>"))).toBe(true);
    expect(sniffsAsHtml(enc("<!DOCTYPE HTML>\n<html>"))).toBe(true);
    expect(sniffsAsHtml(enc("<!-- comment --><html>"))).toBe(true);
    expect(sniffsAsHtml(enc("<table><tr>"))).toBe(true);
    expect(sniffsAsHtml(enc("<script>"))).toBe(true);
  });
  it("does not claim binary or script-adjacent heads", () => {
    expect(sniffsAsHtml(enc("\x89PNG\r\n\x1a\n"))).toBe(false);
    expect(sniffsAsHtml(enc("function f(){}"))).toBe(false);
    expect(sniffsAsHtml(enc(""))).toBe(false);
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
  /* Issue C: destination-aware refinement. An XML document on a
     document destination is a required-but-unsupported rewrite: the
     rewriter speaks HTML, not XML, so the body still serves native
     and the honest reason is the only telemetry. */
  it("XML documents on document destinations are recorded as required-but-unsupported", () => {
    const native = { mode: "NativeTransit" as const };
    expect(refineWithContent(native, "image/svg+xml", "document")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "XML_DOCUMENT_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "application/xml", "iframe")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "XML_DOCUMENT_REWRITE_REQUIRED",
    });
    /* XML on a non-document destination is a plain resource. */
    expect(refineWithContent(native, "image/svg+xml", "image")).toEqual({ mode: "NativeTransit" });
  });
  it("content-type-less document destinations demand the rewrite path", () => {
    const native = { mode: "NativeTransit" as const };
    expect(refineWithContent(native, "", "document")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "DOCUMENT_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "", "fetch")).toEqual({ mode: "NativeTransit" });
  });
  it("XHTML bodies are html to the rewriter, whatever the destination", () => {
    const native = { mode: "NativeTransit" as const };
    expect(refineWithContent(native, "application/xhtml+xml", "iframe")).toEqual({
      mode: "RewriteFallback",
      fallbackReason: "DOCUMENT_REWRITE_REQUIRED",
    });
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
  it("fallback decisions are network entries, not diag failures", async () => {
    const { DIAG } = await import("../diag");
    const before = DIAG.snapshot(0).events.length;
    transitRecord("t9", "https://a.com/", { mode: "RewriteFallback", fallbackReason: "CSS_URL_REWRITE_REQUIRED" });
    expect(DIAG.snapshot(0).events.length).toBe(before);
    const s = transitStats();
    expect(s.fallback).toBe(1);
    expect(s.fallbacks[0].url).toBe("https://a.com/");
    expect(s.fallbacks[0].reason).toBe("CSS_URL_REWRITE_REQUIRED");
  });
  /* Issue E: the epoch lets a consumer detect a SW restart instead
     of trusting counters that silently reset. */
  it("stats carry the per-worker epoch", () => {
    const s = transitStats();
    expect(typeof s.epoch).toBe("number");
    expect(s.epoch).toBeGreaterThan(0);
    expect(transitStats().epoch).toBe(s.epoch);
  });
});
