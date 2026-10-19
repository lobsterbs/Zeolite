import { describe, expect, it } from "vitest";
import {
  hostPatternMatches,
  hostPatternsMatch,
  parseHostPattern,
  PermissionGate,
} from "../permissions";

describe("host patterns", () => {
  it("parses <all_urls>", () => {
    const p = parseHostPattern("<all_urls>");
    expect(p?.all).toBe(true);
  });
  it("parses wildcard-subdomain patterns", () => {
    const p = parseHostPattern("https://*.example.com/*");
    expect(p?.scheme).toBe("https");
    expect(p?.host).toBe("*.example.com");
    expect(p?.path).toBe("/*");
  });
  it("rejects malformed patterns", () => {
    expect(parseHostPattern("nota pattern")).toBeNull();
    expect(parseHostPattern("https:///*")).toBeNull();
  });
  it("matches subdomains and the bare domain, not lookalikes", () => {
    const p = parseHostPattern("https://*.example.com/*")!;
    expect(hostPatternMatches(p, "https://a.example.com/x")).toBe(true);
    expect(hostPatternMatches(p, "https://example.com/")).toBe(true);
    expect(hostPatternMatches(p, "https://badexample.com/x")).toBe(false);
    expect(hostPatternMatches(p, "http://a.example.com/x")).toBe(false);
  });
  /* #277: <all_urls> covers file URLs in the supported-scheme set. The
     engine itself never proxies file: destinations, so this is grammar
     coverage, not a runtime file-access claim. */
  it("matches <all_urls> on the supported schemes including file (#277)", () => {
    const p = parseHostPattern("<all_urls>")!;
    expect(hostPatternMatches(p, "https://any.site/")).toBe(true);
    expect(hostPatternMatches(p, "file:///etc/passwd")).toBe(true);
    expect(hostPatternMatches(p, "about:blank")).toBe(false);
  });
  it("parses and matches file patterns with an empty host (#277)", () => {
    expect(parseHostPattern("file:///*")).not.toBeNull();
    const p = parseHostPattern("file:///*")!;
    expect(hostPatternMatches(p, "file:///path/to/page.html")).toBe(true);
    expect(hostPatternMatches(p, "https://path/to/")).toBe(false);
    /* empty hosts stay rejected for every non-file scheme */
    expect(parseHostPattern("https:///*")).toBeNull();
    expect(parseHostPattern("ftp:///*")).toBeNull();
  });
  /* #280: the wildcard scheme covers the web + WebSocket schemes only. */
  it("keeps *:// off file and ftp URLs (#280)", () => {
    const p = parseHostPattern("*://*/*")!;
    expect(hostPatternMatches(p, "https://a.com/x")).toBe(true);
    expect(hostPatternMatches(p, "http://a.com/x")).toBe(true);
    expect(hostPatternMatches(p, "ws://a.com/x")).toBe(true);
    expect(hostPatternMatches(p, "ftp://a.com/x")).toBe(false);
    expect(hostPatternMatches(p, "file:///x")).toBe(false);
  });
  it("matches interior and multiple wildcards in the path (#280)", () => {
    const mid = parseHostPattern("https://a.com/api/*/v2")!;
    expect(hostPatternMatches(mid, "https://a.com/api/x/v2")).toBe(true);
    expect(hostPatternMatches(mid, "https://a.com/api/x/y/v2")).toBe(true);
    expect(hostPatternMatches(mid, "https://a.com/api/v2")).toBe(false);
    const inner = parseHostPattern("https://a.com/foo*bar/baz")!;
    expect(hostPatternMatches(inner, "https://a.com/fooXbar/baz")).toBe(true);
    expect(hostPatternMatches(inner, "https://a.com/foobar/baz")).toBe(true);
    expect(hostPatternMatches(inner, "https://a.com/foo/baz")).toBe(false);
  });
  it("evaluates path patterns against path plus query (#280)", () => {
    const p = parseHostPattern("https://a.com/search?q=1")!;
    expect(hostPatternMatches(p, "https://a.com/search?q=1")).toBe(true);
    expect(hostPatternMatches(p, "https://a.com/search")).toBe(false);
    expect(hostPatternMatches(p, "https://a.com/search?q=2")).toBe(false);
    /* a trailing * still spans the query boundary */
    const star = parseHostPattern("https://a.com/search*")!;
    expect(hostPatternMatches(star, "https://a.com/search?q=2")).toBe(true);
  });
  it("matches hosts case-insensitively (#280)", () => {
    const p = parseHostPattern("https://Example.COM/*")!;
    expect(hostPatternMatches(p, "https://example.com/x")).toBe(true);
    const p2 = parseHostPattern("https://*.Example.com/*")!;
    expect(hostPatternMatches(p2, "https://a.EXAMPLE.com/x")).toBe(true);
  });
  it("escapes regex specials in literal path segments (#280)", () => {
    /* An empty query is canonically stripped by the URL parser, so the
       pattern's literal '?' is exercised against a real query string. */
    const p = parseHostPattern("https://a.com/x.y+z(1)?q=*")!;
    expect(hostPatternMatches(p, "https://a.com/x.y+z(1)?q=1")).toBe(true);
    expect(hostPatternMatches(p, "https://a.com/x.y+z(1)?q=hello")).toBe(true);
    /* Escaped literals: an unescaped '.' or '+' would let lookalikes through. */
    expect(hostPatternMatches(p, "https://a.com/xaybz1c?q=1")).toBe(false);
    const dot = parseHostPattern("https://a.com/x.y")!;
    expect(hostPatternMatches(dot, "https://a.com/x.y")).toBe(true);
    expect(hostPatternMatches(dot, "https://a.com/xay")).toBe(false);
  });
  it("hostPatternsMatch scans a list", () => {
    expect(hostPatternsMatch(["https://a.com/*", "https://b.com/*"], "https://b.com/x")).toBe(true);
    expect(hostPatternsMatch(["https://a.com/*"], "https://c.com/x")).toBe(false);
  });
});

describe("PermissionGate", () => {
  const gate = new PermissionGate(["tabs", "storage"], ["https://*.example.com/*"]);
  it("reports granted permissions", () => {
    expect(gate.has("tabs")).toBe(true);
    expect(gate.has("cookies")).toBe(false);
  });
  it("require throws for missing permissions", () => {
    expect(() => gate.require("tabs")).not.toThrow();
    expect(() => gate.require("cookies")).toThrow(/permission/);
  });
  it("enforces host permissions", () => {
    expect(gate.hasHost("https://a.example.com/")).toBe(true);
    expect(() => gate.requireHost("https://other.site/")).toThrow(/host permission/);
  });
});
