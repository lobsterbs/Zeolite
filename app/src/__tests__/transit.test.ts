import { describe, expect, it, beforeEach } from "vitest";
import {
  decideTransport,
  refineWithContent,
  reasonOf,
  originOf,
  transitRecord,
  transitStats,
  transitResetForTests,
  docKind,
  sniffsAsHtml,
  DOC_DESTS,
  JS_TRANSFORM_DESTS,
  type TransitDecision,
} from "../transit";

const native: TransitDecision = { mode: "NativeTransit", reason: "NON_DOCUMENT_RESOURCE" };

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
      expect(decideTransport("https://example.com/app.js", dest)).toEqual(native);
    }
  });
  it("document loads are deterministic rewrite fallback", () => {
    expect(decideTransport("https://example.com/", "document")).toEqual({
      mode: "RewriteFallback",
      reason: "DOCUMENT_REWRITE_REQUIRED",
    });
    expect(decideTransport("https://example.com/embed", "iframe")).toEqual({
      mode: "RewriteFallback",
      reason: "DOCUMENT_REWRITE_REQUIRED",
    });
  });
  it("non-http(s) schemes cannot be handled natively", () => {
    expect(decideTransport("ftp://example.com/file", "document")).toEqual({
      mode: "RewriteFallback",
      reason: "UNSUPPORTED_PROTOCOL",
    });
    expect(decideTransport("::bad::", "script")).toEqual({
      mode: "RewriteFallback",
      reason: "UNSUPPORTED_PROTOCOL",
    });
  });
  /* Issue E: embed, fencedframe and xslt used to fall through to
     NativeTransit; they load documents like iframe/object do. */
  it("embed, fencedframe and xslt destinations require the rewrite path", () => {
    for (const dest of DOC_DESTS) {
      expect(decideTransport("https://example.com/x", dest)).toEqual({
        mode: "RewriteFallback",
        reason: "DOCUMENT_REWRITE_REQUIRED",
      });
    }
  });
});

/* #94: one explainable, discriminated decision per request. Every
   branch of the model is exercised: native carries its default reason,
   each block reason is constructible, reasonOf surfaces fallback and
   blocked reasons and stays silent for native (the unremarkable
   default), a blocked request never lands in completed-transit
   telemetry, and refinement passes already-decided requests through
   untouched. */
describe("TransitDecision model (#94)", () => {
  it("every mode carries a machine-readable reason", () => {
    expect(decideTransport("https://example.com/x.js", "image")).toEqual({
      mode: "NativeTransit",
      reason: "NON_DOCUMENT_RESOURCE",
    });
    expect(decideTransport("https://example.com/", "document")).toEqual({
      mode: "RewriteFallback",
      reason: "DOCUMENT_REWRITE_REQUIRED",
    });
    expect(decideTransport("ftp://example.com/f", "document")).toEqual({
      mode: "RewriteFallback",
      reason: "UNSUPPORTED_PROTOCOL",
    });
  });
  it("every block reason is constructible and explainable", () => {
    const blocked: TransitDecision[] = [
      { mode: "Blocked", reason: "BLOCKED_RULES" },
      { mode: "Blocked", reason: "BLOCKED_INTERCEPT" },
      { mode: "Blocked", reason: "BLOCKED_WEBREQUEST" },
    ];
    for (const dec of blocked) {
      expect(dec.mode).toBe("Blocked");
      expect(reasonOf(dec)).toBe(dec.reason);
    }
  });
  it("reasonOf is silent for native, explicit for fallback and blocked", () => {
    expect(reasonOf(native)).toBeUndefined();
    expect(reasonOf({ mode: "RewriteFallback", reason: "CSS_URL_REWRITE_REQUIRED" })).toBe(
      "CSS_URL_REWRITE_REQUIRED",
    );
    expect(reasonOf({ mode: "Blocked", reason: "BLOCKED_WEBREQUEST" })).toBe("BLOCKED_WEBREQUEST");
  });
  it("a blocked request is not completed transit telemetry", () => {
    transitRecord("t1", "https://a.com/x", { mode: "Blocked", reason: "BLOCKED_RULES" });
    const s = transitStats();
    expect(s.native).toBe(0);
    expect(s.fallback).toBe(0);
    expect(s.fallbacks).toHaveLength(0);
  });
  it("refinement passes decided (fallback, blocked) decisions through untouched", () => {
    const fallback: TransitDecision = { mode: "RewriteFallback", reason: "UNSUPPORTED_PROTOCOL" };
    expect(refineWithContent(fallback, "text/html", "document")).toEqual(fallback);
    const blocked: TransitDecision = { mode: "Blocked", reason: "BLOCKED_RULES" };
    expect(refineWithContent(blocked, "text/html", "document")).toEqual(blocked);
  });
  /* Parity guard: the SW's serve-time transform branch and the
     refinement must agree on which destinations' JS bodies get
     transformed, or netLog lies about what happened. */
  it("JS_TRANSFORM_DESTS matches the refinement's JS destinations exactly", () => {
    for (const dest of JS_TRANSFORM_DESTS) {
      expect(refineWithContent(native, "text/javascript", dest)).toEqual({
        mode: "RewriteFallback",
        reason: "JS_LITERAL_REWRITE_REQUIRED",
      });
    }
    const notTransformed = ["document", "image", "font", "audio", "video", "manifest", "fetch"];
    for (const dest of notTransformed) {
      if (JS_TRANSFORM_DESTS.has(dest)) continue;
      expect(refineWithContent(native, "text/javascript", dest)).toEqual(native);
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
    expect(refineWithContent(native, "text/html")).toEqual({
      mode: "RewriteFallback",
      reason: "DOCUMENT_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "TEXT/CSS")).toEqual({
      mode: "RewriteFallback",
      reason: "CSS_URL_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "image/png")).toEqual(native);
    expect(refineWithContent({ mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" }, "image/png"))
      .toEqual({ mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" });
  });
  /* Issue C: destination-aware refinement. An XML document on a
     document destination is a required-but-unsupported rewrite: the
     rewriter speaks HTML, not XML, so the body still serves native
     and the honest reason is the only telemetry. */
  it("XML documents on document destinations are recorded as required-but-unsupported", () => {
    expect(refineWithContent(native, "image/svg+xml", "document")).toEqual({
      mode: "RewriteFallback",
      reason: "XML_DOCUMENT_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "application/xml", "iframe")).toEqual({
      mode: "RewriteFallback",
      reason: "XML_DOCUMENT_REWRITE_REQUIRED",
    });
    /* XML on a non-document destination is a plain resource. */
    expect(refineWithContent(native, "image/svg+xml", "image")).toEqual(native);
  });
  it("content-type-less document destinations demand the rewrite path", () => {
    expect(refineWithContent(native, "", "document")).toEqual({
      mode: "RewriteFallback",
      reason: "DOCUMENT_REWRITE_REQUIRED",
    });
    expect(refineWithContent(native, "", "fetch")).toEqual(native);
  });
  it("XHTML bodies are html to the rewriter, whatever the destination", () => {
    expect(refineWithContent(native, "application/xhtml+xml", "iframe")).toEqual({
      mode: "RewriteFallback",
      reason: "DOCUMENT_REWRITE_REQUIRED",
    });
  });
  /* The SW serve-time-transforms JS bodies on script destinations,
     destination "" fetch/XHR and worker scripts (specifier pass +
     rewriteJsBody literals + worker prelude); the decision must say
     rewrite, not NativeTransit, or netLog lies about what happened. */
  it("JS bodies on script/worker destinations are rewrite fallbacks", () => {
    for (const ct of [
      "text/javascript",
      "application/javascript",
      "application/x-javascript",
      "text/ecmascript; charset=utf-8",
    ]) {
      for (const dest of JS_TRANSFORM_DESTS) {
        expect(refineWithContent(native, ct, dest)).toEqual({
          mode: "RewriteFallback",
          reason: "JS_LITERAL_REWRITE_REQUIRED",
        });
      }
    }
    /* JS on a non-script destination is a plain native resource. */
    expect(refineWithContent(native, "application/javascript", "image")).toEqual(native);
  });
});

describe("transitRecord", () => {
  it("counts native and fallback separately", () => {
    transitRecord("t1", "https://a.com/x.js", native);
    transitRecord("t2", "https://a.com/", { mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" });
    const s = transitStats();
    expect(s.native).toBe(1);
    expect(s.fallback).toBe(1);
    expect(s.fallbacks).toHaveLength(1);
    expect(s.fallbacks[0].reason).toBe("DOCUMENT_REWRITE_REQUIRED");
    expect(s.fallbacks[0].traceId).toBe("t2");
  });
  it("fallback ring stays bounded", () => {
    for (let i = 0; i < 80; i++) {
      transitRecord("t" + i, "https://a.com/" + i, { mode: "RewriteFallback", reason: "UNSUPPORTED_PROTOCOL" });
    }
    const s = transitStats();
    expect(s.fallback).toBe(80);
    expect(s.fallbacks.length).toBeLessThanOrEqual(64);
    expect(s.fallbacks[s.fallbacks.length - 1].url).toBe("https://a.com/79");
  });
  it("fallback decisions are network entries, not diag failures", async () => {
    const { DIAG } = await import("../diag");
    const before = DIAG.snapshot(0).events.length;
    transitRecord("t9", "https://a.com/", { mode: "RewriteFallback", reason: "CSS_URL_REWRITE_REQUIRED" });
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
