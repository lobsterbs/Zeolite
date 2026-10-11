import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CookieJar, parseDate } from "tough-cookie";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  parseCookieDate,
  setSameSitePolicy,
} from "../cookies";

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

/** Admit one Set-Cookie header for a response URL into our jar. */
function admit(url: string, header: string): ReturnType<typeof applySetCookie> {
  return applySetCookie(url, resp([header]));
}

/** Our Cookie header value for a request URL; empty string for none. */
function ours(url: string, ctx?: { initiator?: string; navigation?: boolean }): string {
  return cookieHeaderFor(url, ctx) ?? "";
}

/** tough-cookie's Cookie header value for the same sequence. */
function ref(set: Array<[string, string]>, url: string): string {
  const jar = new CookieJar();
  for (const [header, from] of set) jar.setCookieSync(header, from, { http: true });
  return jar.getCookieStringSync(url, { http: true });
}

/* Shared corpus: RFC 6265 5.1.1 cookie dates where the spec and the
   tough-cookie reference agree. The oracle pins our parser to the
   reference so a date regression cannot slip through. */
const DATES: Array<[string, number]> = [
  ["Wed, 21 Oct 2015 07:28:00 GMT", Date.UTC(2015, 9, 21, 7, 28, 0)],
  ["Wed, 21-Oct-2015 07:28:00 GMT", Date.UTC(2015, 9, 21, 7, 28, 0)],
  ["Sun, 06 Nov 1994 08:49:37 GMT", Date.UTC(1994, 10, 6, 8, 49, 37)],
  ["Sunday, 06-Nov-94 08:49:37 GMT", Date.UTC(1994, 10, 6, 8, 49, 37)],
  ["Sun Nov  6 08:49:37 1994", Date.UTC(1994, 10, 6, 8, 49, 37)],
  ["01 Jan 70 00:00:00 GMT", Date.UTC(1970, 0, 1, 0, 0, 0)],
  ["01 Jan 69 00:00:00 GMT", Date.UTC(2069, 0, 1, 0, 0, 0)],
  ["Tue, 15 Aug 2023 12:00:00", Date.UTC(2023, 7, 15, 12, 0, 0)],
];

describe("parseCookieDate oracle (tough-cookie)", () => {
  for (const [s, want] of DATES) {
    it("parses " + JSON.stringify(s) + " like tough-cookie", () => {
      const tc = parseDate(s);
      expect(tc).toBeDefined();
      expect(parseCookieDate(s)).toBe(tc!.getTime());
      expect(parseCookieDate(s)).toBe(want);
    });
  }

  it("rejects what the RFC grammar rejects", () => {
    expect(parseCookieDate("not a date")).toBeNull();
    expect(parseCookieDate("Wed Oct 21 2015")).toBeNull();
    expect(parseDate("not a date")).toBeUndefined();
    expect(parseDate("Wed Oct 21 2015")).toBeUndefined();
  });

  /* Deliberate delta, documented: RFC 6265 makes the seconds field of
     the time token optional; tough-cookie requires hh:mm:ss. Ours
     follows the RFC (missing seconds default to 0). */
  it("accepts RFC-optional seconds, where tough-cookie is stricter", () => {
    expect(parseCookieDate("Wed, 21 Oct 2015 07:28 GMT")).toBe(Date.UTC(2015, 9, 21, 7, 28, 0));
    expect(parseDate("Wed, 21 Oct 2015 07:28 GMT")).toBeUndefined();
  });

  it("rejects pre-1601 years per the RFC (tough-cookie accepts)", () => {
    expect(parseCookieDate("Wed, 21 Oct 1500 07:28:00 GMT")).toBeNull();
  });
});

describe("cookie jar oracle (tough-cookie reference)", () => {
  it("host-only cookies scope to the exact host", () => {
    const seq: Array<[string, string]> = [["sid=1", "https://a.example/x/y"]];
    admit("https://a.example/x/y", "sid=1");
    expect(ours("https://a.example/x/y/z")).toBe(ref(seq, "https://a.example/x/y/z"));
    expect(ours("https://a.example/x/y/z")).toBe("sid=1");
    expect(ours("https://sub.a.example/")).toBe(ref(seq, "https://sub.a.example/"));
    expect(ours("https://sub.a.example/")).toBe("");
  });

  it("Domain cookies attach across subdomains", () => {
    const seq: Array<[string, string]> = [["a=1; Domain=example.com", "https://www.example.com/x"]];
    admit("https://www.example.com/x", "a=1; Domain=example.com");
    expect(ours("https://sub.example.com/y")).toBe(ref(seq, "https://sub.example.com/y"));
    expect(ours("https://sub.example.com/y")).toBe("a=1");
  });

  it("refuses Domain=public suffix (ICANN section), like the reference", () => {
    const r = admit("https://site.co.uk/", "a=1; Domain=co.uk");
    expect(r[0].stored).toBe(false);
    const jar = new CookieJar();
    expect(() => jar.setCookieSync("a=1; Domain=co.uk", "https://site.co.uk/", { http: true })).toThrow();
  });

  it("refuses Domain=public suffix (private section), like the reference", () => {
    const r = admit("https://b.github.io/", "a=1; Domain=github.io");
    expect(r[0].stored).toBe(false);
    const jar = new CookieJar();
    expect(() => jar.setCookieSync("a=1; Domain=github.io", "https://b.github.io/", { http: true })).toThrow();
  });

  it("default-path and path-match agree", () => {
    const seq: Array<[string, string]> = [["a=1", "https://example.com/dir/page"]];
    admit("https://example.com/dir/page", "a=1");
    expect(ours("https://example.com/dir/x")).toBe(ref(seq, "https://example.com/dir/x"));
    expect(ours("https://example.com/dir/x")).toBe("a=1");
    expect(ours("https://example.com/other")).toBe(ref(seq, "https://example.com/other"));
    expect(ours("https://example.com/other")).toBe("");
  });

  it("longer cookie paths attach first", () => {
    const seq: Array<[string, string]> = [
      ["a=1", "https://example.com/dir/page"],
      ["b=1; Path=/", "https://example.com/dir/page"],
    ];
    admit("https://example.com/dir/page", "a=1");
    admit("https://example.com/dir/page", "b=1; Path=/");
    expect(ours("https://example.com/dir/x")).toBe(ref(seq, "https://example.com/dir/x"));
    expect(ours("https://example.com/dir/x")).toBe("a=1; b=1");
  });

  it("Secure cookies never attach over http", () => {
    const seq: Array<[string, string]> = [["s=1; Secure", "https://example.com/"]];
    admit("https://example.com/", "s=1; Secure");
    expect(ours("http://example.com/")).toBe(ref(seq, "http://example.com/"));
    expect(ours("http://example.com/")).toBe("");
    expect(ours("https://example.com/")).toBe("s=1");
  });

  it("Max-Age=0 deletes the identity, like the reference", () => {
    const seq: Array<[string, string]> = [
      ["d=1", "https://example.com/"],
      ["d=1; Max-Age=0", "https://example.com/"],
    ];
    admit("https://example.com/", "d=1");
    admit("https://example.com/", "d=1; Max-Age=0");
    expect(ours("https://example.com/")).toBe(ref(seq, "https://example.com/"));
    expect(ours("https://example.com/")).toBe("");
  });

  it("re-admitting an identity overwrites the value", () => {
    const seq: Array<[string, string]> = [
      ["o=1", "https://example.com/"],
      ["o=2", "https://example.com/"],
    ];
    admit("https://example.com/", "o=1");
    admit("https://example.com/", "o=2");
    expect(ours("https://example.com/")).toBe(ref(seq, "https://example.com/"));
    expect(ours("https://example.com/")).toBe("o=2");
  });

  it("same-path ties attach in creation order", () => {
    const seq: Array<[string, string]> = [
      ["x=1", "https://example.com/"],
      ["y=1", "https://example.com/"],
    ];
    admit("https://example.com/", "x=1");
    admit("https://example.com/", "y=1");
    expect(ours("https://example.com/")).toBe(ref(seq, "https://example.com/"));
    expect(ours("https://example.com/")).toBe("x=1; y=1");
  });

  it("HttpOnly cookies attach to engine (http) requests", () => {
    const seq: Array<[string, string]> = [["h=1; HttpOnly", "https://example.com/"]];
    admit("https://example.com/", "h=1; HttpOnly");
    expect(ours("https://example.com/")).toBe(ref(seq, "https://example.com/"));
    expect(ours("https://example.com/")).toBe("h=1");
  });

  it("an already-past Expires deletes (RFC 5.3 step 5.3.7)", () => {
    admit("https://example.com/", "e=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT");
    expect(ours("https://example.com/")).toBe("");
  });

  /* Deliberate delta, documented: RFC 6265bis (and every browser)
   requires Secure for SameSite=None; tough-cookie still admits it.
   Ours follows the browsers. */
  it("rejects SameSite=None without Secure (reference still admits)", () => {
    const r = admit("https://example.com/", "a=1; SameSite=None");
    expect(r[0].stored).toBe(false);
    expect(r[0].rejected).toBe("samesite none without secure");
    const jar = new CookieJar();
    expect(() => jar.setCookieSync("a=1; SameSite=None", "https://example.com/", { http: true })).not.toThrow();
  });
});

describe("SameSite site boundary (PSL via tldts)", () => {
  beforeEach(() => setSameSitePolicy("approx"));

  it("distinguishes sites under a multi-label public suffix (co.uk)", () => {
    admit("https://x.site.co.uk/", "st=1; SameSite=Strict");
    admit("https://x.site.co.uk/", "lx=1; SameSite=Lax");
    /* same registrable domain: same site */
    expect(ours("https://x.site.co.uk/a", { initiator: "https://y.site.co.uk/b" })).toBe("st=1; lx=1");
    /* different registrable domain under the same suffix: cross-site.
       The old last-two-labels approximation called these same-site. */
    expect(ours("https://x.site.co.uk/a", { initiator: "https://other.co.uk/b" })).toBe("");
    expect(ours("https://x.site.co.uk/a", { initiator: "https://other.co.uk/b", navigation: true })).toBe("lx=1");
  });

  it("treats private-section suffixes as site boundaries (github.io)", () => {
    admit("https://a.b.github.io/", "st=1; SameSite=Strict");
    /* same project domain: same site */
    expect(ours("https://a.b.github.io/p", { initiator: "https://c.b.github.io/q" })).toBe("st=1");
    /* sibling project: cross-site, so strict is blocked */
    expect(ours("https://a.b.github.io/p", { initiator: "https://d.github.io/q" })).toBe("");
  });

  it("SameSite=None with Secure attaches cross-site under approx", () => {
    admit("https://a.example/", "n=1; Secure; SameSite=None");
    expect(ours("https://a.example/x", { initiator: "https://b.example.org/y" })).toBe("n=1");
  });
});
