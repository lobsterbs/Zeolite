import { describe, expect, it } from "vitest";
import { decodePath, encodeDest } from "../codec";
import { navEncode } from "../bootstrap/navguard";
import { initScript } from "../pageload";
import { errorPage } from "../errorpage";
import {
  mapRefreshHeader,
  stripHostile,
  charsetFromHeader,
  resolveCharset,
  makeDecoder,
  decodeBody,
  utf8ContentType,
} from "../headers";

/* Issue #32 acceptance: the real destination string must be absent
   from every page-visible surface the engine produces: routes in the
   address bar and history, the injected init script, navigation-guard
   markers in DOM attributes, and the engine-owned error page. */
const TARGET = "https://leaky.example.org/private/page?secret=1";

describe("page-visible surfaces never carry the plaintext destination (#32)", () => {
  it("engine routes", () => {
    const route = encodeDest(TARGET);
    expect(route).not.toContain("leaky.example.org");
    expect(route).not.toContain("private");
    expect(route).not.toContain("secret");
  });

  it("the injected init script", () => {
    expect(initScript(TARGET, null)).not.toContain("leaky.example.org");
    expect(initScript(TARGET, "/*fp*/")).not.toContain("leaky.example.org");
  });

  it("navigation guard markers", () => {
    expect(navEncode(TARGET)).not.toContain("leaky.example.org");
  });

  it("the engine error page", () => {
    const p = errorPage({ route: "/j/x", category: "dns", engineVersion: "v" });
    expect(p).not.toContain("leaky.example.org");
    expect(p).not.toContain("https://");
  });

  it("b64u is obfuscation, not encryption: the codec decodes its own routes", () => {
    /* Honest bound, not a flaw: decodePath is as public as the route
       scheme itself. #32 removes the plaintext from every
       page-visible surface; it does not make the target secret from
       whoever already holds the route. */
    expect(decodePath(encodeDest(TARGET))).toBe(TARGET);
  });
});

describe("response-header surgery never carries the plaintext destination", () => {
  const H: Record<string, string> = {
    "content-security-policy": "img-src https://leaky.example.org",
    link: "<https://leaky.example.org/a.js>; rel=preload",
    "content-location": "https://leaky.example.org/private/page",
    "x-original-url": "https://leaky.example.org/private/page",
    "content-type": "text/html",
  };

  it("destination-bearing headers are stripped, others survive", () => {
    const out = stripHostile(new Headers(H));
    for (const [k, v] of out) {
      expect(v).not.toContain("leaky.example.org");
    }
    expect(out.get("content-type")).toBe("text/html");
  });

  it("Refresh url= is re-encoded to an engine route", () => {
    const h = new Headers({ refresh: '5; url="https://leaky.example.org/next"' });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    const out = h.get("refresh")!;
    expect(out).not.toContain("leaky.example.org");
    expect(out.startsWith("5; url=")).toBe(true);
    expect(decodePath(out.slice("5; url=".length))).toBe("https://leaky.example.org/next");
  });

  it("relative Refresh url resolves against the response destination", () => {
    const h = new Headers({ refresh: "0; url=/other" });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    const out = h.get("refresh")!;
    expect(out).not.toContain("leaky.example.org");
    expect(decodePath(out.slice("0; url=".length))).toBe("https://leaky.example.org/other");
  });

  it("same-page Refresh (no url=) survives untouched", () => {
    const h = new Headers({ refresh: "30" });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    expect(h.get("refresh")).toBe("30");
  });

  it("unresolvable Refresh url= fails closed", () => {
    /* port > 65535: the WHATWG parser rejects it, so the fail-closed
     branch is the oracle here (a scheme-less value resolves as a
     relative path instead and gets encoded, which is fine - the
     output is still a route, never a plaintext target). */
    const h = new Headers({ refresh: "5; url=https://leaky.example.org:99999" });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    expect(h.get("refresh")).toBeNull();
  });

  it("Refresh padded 'url =' variant is still mapped", () => {
    const h = new Headers({ refresh: "5; url = https://leaky.example.org/next" });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    const out = h.get("refresh")!;
    expect(out).not.toContain("leaky.example.org");
    expect(decodePath(out.slice(out.indexOf("url=") + 4))).toBe("https://leaky.example.org/next");
  });

  it("browser-action headers are stripped (isolation + report escape)", () => {
    const h = new Headers({
      "clear-site-data": '"cache", "storage", "cookies"',
      "report-to": '{"group":"default","endpoints":[{"url":"https://leaky.example.org/report"}]}',
      nel: '{"report_to":"default","max_age":86400}',
      "timing-allow-origin": "https://leaky.example.org",
    });
    const out = stripHostile(h);
    expect(out.has("clear-site-data")).toBe(false);
    expect(out.has("report-to")).toBe(false);
    expect(out.has("nel")).toBe(false);
    expect(out.has("timing-allow-origin")).toBe(false);
  });
});

/* Issue B: a rewritten body decodes with the upstream charset
   (header, BOM, meta/@charset prescan, spec default) and the served
   copy is re-encoded UTF-8 with the header saying so. Legacy encodings
   must round-trip; the old always-UTF-8 decode turned them into
   replacement-character garbage. */
describe("charset resolution (issue B)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("charsetFromHeader extracts the charset parameter", () => {
    expect(charsetFromHeader("text/html; charset=Shift_JIS")).toBe("Shift_JIS");
    expect(charsetFromHeader('text/html; charset="windows-1252"')).toBe("windows-1252");
    expect(charsetFromHeader("text/html")).toBeNull();
    expect(charsetFromHeader("")).toBeNull();
  });

  it("the header charset wins over a BOM and any meta", () => {
    expect(resolveCharset("text/html; charset=utf-8", new Uint8Array([0xff, 0xfe, 0x3c]), true)).toBe("utf-8");
  });

  it("a BOM resolves the charset without a header", () => {
    expect(resolveCharset("text/html", new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]), true)).toBe("utf-8");
    expect(resolveCharset("text/html", new Uint8Array([0xff, 0xfe, 0x3c]), true)).toBe("utf-16le");
    expect(resolveCharset("text/html", new Uint8Array([0xfe, 0xff, 0x3c]), true)).toBe("utf-16be");
  });

  it("an HTML meta prescan resolves the charset", () => {
    expect(resolveCharset("text/html", enc('<html><head><meta charset="windows-1252">'), true)).toBe("windows-1252");
    expect(resolveCharset("text/html", enc('<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">'), true)).toBe("ISO-8859-1");
    expect(resolveCharset("text/html", enc('<meta charset="Shift_JIS">'), true)).toBe("Shift_JIS");
  });

  it("a CSS @charset resolves the stylesheet charset", () => {
    expect(resolveCharset("text/css", enc('@charset "iso-8859-1";\nbody{color:red}'), false)).toBe("iso-8859-1");
  });

  it("spec defaults when nothing declares a charset", () => {
    expect(resolveCharset("text/html", enc("<html><body>plain"), true)).toBe("windows-1252");
    expect(resolveCharset("text/css", enc("body{color:red}"), false)).toBe("utf-8");
    expect(resolveCharset("", null, true)).toBe("windows-1252");
  });

  it("makeDecoder never throws on a bogus label", () => {
    const d = makeDecoder("not-a-real-charset");
    expect(d.decode(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]))).toBe("café");
  });

  it("legacy encodings round-trip instead of mangling", () => {
    /* "café" as latin-1: the old always-UTF-8 decode dropped the E9. */
    expect(makeDecoder("windows-1252").decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
    expect(makeDecoder("shift_jis").decode(new Uint8Array([0x93, 0xfa, 0x96, 0x7b]))).toBe("日本");
    expect(decodeBody(new Uint8Array([0x63, 0x61, 0x66, 0xe9]).buffer, "text/html; charset=windows-1252")).toBe("café");
  });

  it("a truncated multi-byte tail flushes to a replacement char, never silence", () => {
    const d = makeDecoder("utf-8");
    let out = d.decode(new Uint8Array([0xe3, 0x81, 0x82, 0xe6]), { stream: true }); /* あ + orphan first byte of 日 */
    expect(out).toBe("あ");
    out = d.decode(); /* the flush the done-branch used to skip */
    expect(out).toBe("\uFFFD");
  });

  it("utf8ContentType always declares utf-8 on the served copy", () => {
    expect(utf8ContentType("text/html; charset=windows-1252")).toBe("text/html; charset=utf-8");
    expect(utf8ContentType("text/html")).toBe("text/html; charset=utf-8");
    expect(utf8ContentType("text/css")).toBe("text/css; charset=utf-8");
    expect(utf8ContentType("")).toBe("text/html; charset=utf-8");
  });
});
