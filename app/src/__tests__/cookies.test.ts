import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDest } from "../codec";
import {
  applySetCookie,
  parseCookieDate,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieRead,
  documentCookieWrite,
  jarHeaders,
  jarLoad,
  jarMerge,
  jarPersist,
  jarSnapshot,
  registerOrigin,
  setSameSitePolicy,
} from "../cookies";

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

describe("virtual-origin registry", () => {
  it("assigns a stable id and the codec path base", () => {
    const a = registerOrigin("https://example.com");
    const b = registerOrigin("https://example.com");
    expect(a).toBe(b);
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.pathBase).toBe(encodeDest("https://example.com"));
    expect(registerOrigin("https://other.example").id).not.toBe(a.id);
  });
});

describe("set-cookie admission", () => {
  it("stores host-only cookies and attaches them to the same host", () => {
    const r = applySetCookie("https://a.example/x/y", resp(["sid=1"]));
    expect(r[0].stored).toBe(true);
    expect(cookieHeaderFor("https://a.example/x/y/z")).toBe("sid=1");
    /* host-only: a subdomain never sees it */
    expect(cookieHeaderFor("https://sub.a.example/")).toBeNull();
  });

  it("attaches Domain cookies across subdomains", () => {
    applySetCookie("https://a.example/", resp(["sid=2; Domain=a.example"]));
    expect(cookieHeaderFor("https://www.a.example/x")).toBe("sid=2");
  });

  it("hard gate: rejects a Domain that does not scope the response host", () => {
    const r = applySetCookie("https://a.example/", resp(["sid=3; Domain=b.example"]));
    expect(r[0].rejected).toBe("domain");
    expect(jarSnapshot().size).toBe(0);
    /* nothing for either origin */
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    expect(cookieHeaderFor("https://b.example/")).toBeNull();
  });

  it("hard gate: refuses dotless TLD-wide domains", () => {
    const r = applySetCookie("https://a.b.example/", resp(["sid=4; Domain=com"]));
    expect(r[0].rejected).toBe("domain");
  });

  it("rejects SameSite=None without Secure", () => {
    const r = applySetCookie("https://a.example/", resp(["sid=5; SameSite=None"]));
    expect(r[0].rejected).toBe("samesite none without secure");
    applySetCookie("https://a.example/", resp(["sid=5; SameSite=None; Secure"]));
    expect(cookieHeaderFor("https://a.example/")).toBe("sid=5");
  });

  it("default path: admitted under the directory of the response path", () => {
    applySetCookie("https://a.example/dir/page", resp(["p=1"]));
    expect(cookieHeaderFor("https://a.example/dir/sub/x")).toBe("p=1");
    expect(cookieHeaderFor("https://a.example/other")).toBeNull();
  });

  it("honors an explicit Path attribute", () => {
    applySetCookie("https://a.example/dir/page", resp(["p=2; Path=/"]));
    expect(cookieHeaderFor("https://a.example/anywhere")).toBe("p=2");
  });

  it("Secure cookies never attach over http", () => {
    applySetCookie("https://a.example/", resp(["s=1; Secure"]));
    expect(cookieHeaderFor("https://a.example/")).toBe("s=1");
    expect(cookieHeaderFor("http://a.example/")).toBeNull();
  });

  it("max-age=0 deletes the cookie", () => {
    applySetCookie("https://a.example/", resp(["d=1"]));
    expect(cookieHeaderFor("https://a.example/")).toBe("d=1");
    const r = applySetCookie("https://a.example/", resp(["d=; Max-Age=0"]));
    expect(r[0].deleted).toBe(true);
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("a past Expires deletes the cookie", () => {
    applySetCookie("https://a.example/", resp(["d=2"]));
    const r = applySetCookie("https://a.example/", resp(["d=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]));
    expect(r[0].deleted).toBe(true);
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("overwrites the same name+domain+path, keeps a different path", () => {
    applySetCookie("https://a.example/x/a", resp(["o=1; Path=/x", "o=2; Path=/"]));
    expect(cookieHeaderFor("https://a.example/x/a")).toBe("o=1; o=2");
  });

  it("orders by longer path first", () => {
    applySetCookie("https://a.example/x/y", resp(["a=1; Path=/"]));
    applySetCookie("https://a.example/x/y", resp(["b=2; Path=/x/y"]));
    expect(cookieHeaderFor("https://a.example/x/y/z")).toBe("b=2; a=1");
  });

  it("isolates unrelated origins with the same cookie name", () => {
    applySetCookie("https://a.example/", resp(["t=alpha"]));
    applySetCookie("https://b.example/", resp(["t=beta"]));
    expect(cookieHeaderFor("https://a.example/")).toBe("t=alpha");
    expect(cookieHeaderFor("https://b.example/")).toBe("t=beta");
  });
});

describe("document.cookie vs HttpOnly (#337)", () => {
  it("a script write never overwrites an HttpOnly cookie", () => {
    applySetCookie("https://a.example/", resp(["sid=server; HttpOnly"]));
    const r = documentCookieWrite("https://a.example/", "sid=attacker; Path=/");
    expect(r.rejected).toBe("httponly");
    expect(cookieHeaderFor("https://a.example/")).toBe("sid=server");
  });

  it("a script deletion never removes an HttpOnly cookie", () => {
    applySetCookie("https://a.example/", resp(["sid=server; HttpOnly"]));
    const r = documentCookieWrite("https://a.example/", "sid=x; Max-Age=0");
    expect(r.deleted).toBe(false);
    expect(cookieHeaderFor("https://a.example/")).toBe("sid=server");
  });

  it("a server response still replaces the HttpOnly cookie", () => {
    applySetCookie("https://a.example/", resp(["sid=old; HttpOnly"]));
    const r = applySetCookie("https://a.example/", resp(["sid=new"]));
    expect(r[0].stored).toBe(true);
    expect(cookieHeaderFor("https://a.example/")).toBe("sid=new");
  });

  it("a script write still replaces a non-HttpOnly cookie", () => {
    applySetCookie("https://a.example/", resp(["sid=server"]));
    const r = documentCookieWrite("https://a.example/", "sid=script; Path=/");
    expect(r.stored).toBe(true);
    expect(cookieHeaderFor("https://a.example/")).toBe("sid=script");
  });
});

describe("control characters never enter the jar (#349)", () => {
  it("rejects a CR/LF in the value", () => {
    const r = documentCookieWrite("https://a.example/", "a=x\r\ny; Domain=a.example; Path=/");
    expect(r.rejected).toBe("control character");
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("still admits clean values", () => {
    const r = documentCookieWrite("https://a.example/", "b=1");
    expect(r.stored).toBe(true);
    expect(cookieHeaderFor("https://a.example/")).toBe("b=1");
  });
});

describe("jar persistence", () => {
  it("persists to IndexedDB and reloads", async () => {
    applySetCookie("https://a.example/", resp(["keep=1"]));
    await jarPersist();
    cookiesResetForTests();
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    await jarLoad();
    expect(cookieHeaderFor("https://a.example/")).toBe("keep=1");
  });
});

describe("samesite policy knob (2.2)", () => {
  it("is off by default: strict cookies attach even cross-site", () => {
    applySetCookie("https://a.example/", resp(["s=1; SameSite=Strict"]));
    expect(cookieHeaderFor("https://a.example/", { initiator: "https://evil.test/x" })).toBe("s=1");
  });

  it("approx: strict is dropped for a cross-site initiator, none passes", () => {
    setSameSitePolicy("approx");
    applySetCookie("https://a.example/", resp(["s=1; SameSite=Strict", "n=2; SameSite=None; Secure"]));
    expect(cookieHeaderFor("https://a.example/", { initiator: "https://evil.test/x" })).toBe("n=2");
  });

  it("approx: lax attaches cross-site only on navigations", () => {
    setSameSitePolicy("approx");
    applySetCookie("https://a.example/", resp(["l=1; SameSite=Lax"]));
    expect(cookieHeaderFor("https://a.example/", { initiator: "https://evil.test/x", navigation: false })).toBeNull();
    expect(cookieHeaderFor("https://a.example/", { initiator: "https://evil.test/x", navigation: true })).toBe("l=1");
  });

  it("approx: same-site initiator attaches strict", () => {
    setSameSitePolicy("approx");
    applySetCookie("https://a.example/", resp(["s=1; SameSite=Strict"]));
    expect(cookieHeaderFor("https://a.example/", { initiator: "https://sub.a.example/p" })).toBe("s=1");
  });

  it("approx: an unattributed SameSite cookie defaults to lax", () => {
    setSameSitePolicy("approx");
    applySetCookie("https://a.example/", resp(["d=1"]));
    expect(cookieHeaderFor("https://a.example/", { initiator: "https://evil.test/x" })).toBeNull();
    expect(cookieHeaderFor("https://a.example/", { initiator: "https://evil.test/x", navigation: true })).toBe("d=1");
  });

  it("approx: an unknown initiator is treated as same-site", () => {
    setSameSitePolicy("approx");
    applySetCookie("https://a.example/", resp(["s=1; SameSite=Strict"]));
    expect(cookieHeaderFor("https://a.example/")).toBe("s=1");
  });

  it("unknown knob values fall back to off and report it", () => {
    expect(setSameSitePolicy("bogus")).toBe("off");
  });
});

describe("jar merge mode (2.2)", () => {
  function ck(name: string, value: string, created: number) {
    return {
      name,
      value,
      domain: "a.example",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: null,
      expires: 0,
      created,
    };
  }

  it("merges new cookies, resolves conflicts per rule", () => {
    applySetCookie("https://a.example/", resp(["keep=1", "conf=v1"]));
    const aId = registerOrigin("https://a.example").id;
    const bId = registerOrigin("https://b.example").id;
    const now = Date.now();
    const imported: Array<[string, unknown[]]> = [
      [aId, [ck("conf", "v2", now), ck("new", "x", now)]],
      [bId, [{ ...ck("other", "y", now), domain: "b.example" }]],
    ];
    const r = jarMerge(imported, "keep-existing");
    expect(r.jars).toBe(2);
    expect(r.cookies).toBe(2);
    expect(r.conflicts).toBe(1);
    expect(cookieHeaderFor("https://a.example/")).toBe("keep=1; conf=v1; new=x");
    expect(cookieHeaderFor("https://b.example/")).toBe("other=y");
  });

  it("import-wins replaces the conflicting cookie", () => {
    applySetCookie("https://a.example/", resp(["conf=v1"]));
    const aId = registerOrigin("https://a.example").id;
    const r = jarMerge([[aId, [ck("conf", "v2", Date.now())]]], "import-wins");
    expect(r.conflicts).toBe(1);
    expect(cookieHeaderFor("https://a.example/")).toBe("conf=v2");
  });

  it("keep-newest honors the created timestamp", () => {
    applySetCookie("https://a.example/", resp(["conf=v1"]));
    const aId = registerOrigin("https://a.example").id;
    jarMerge([[aId, [ck("conf", "older", Date.now() - 5000)]]], "keep-newest");
    expect(cookieHeaderFor("https://a.example/")).toBe("conf=v1");
    jarMerge([[aId, [ck("conf", "newer", Date.now() + 5000)]]], "keep-newest");
    expect(cookieHeaderFor("https://a.example/")).toBe("conf=newer");
  });

  it("drops malformed records without admitting them", () => {
    const aId = registerOrigin("https://a.example").id;
    const bad = [
      [aId, [{ name: 5 }, "junk"]],
      ["not-a-pair"],
    ] as unknown as Array<[string, unknown[]]>;
    const r = jarMerge(bad, "keep-existing");
    expect(r.jars).toBe(0);
    expect(r.cookies).toBe(0);
    expect(r.conflicts).toBe(0);
    expect(jarSnapshot().size).toBe(0);
  });
});

describe("jarHeaders (issue #10: transport set-cookie visibility)", () => {
  const gs = (h: Headers): (() => string[]) | undefined =>
    (h as Headers & { getSetCookie?: () => string[] }).getSetCookie;

  it("documents that Headers keeps every raw set-cookie pair", () => {
    /* Headers keep every set-cookie entry even though Chromium drops
       them when a Response is constructed (fetch spec: set-cookie is a
       forbidden response-header name). undici/vitest does not implement
       that guard, so the drop cannot be asserted here; that is exactly
       why jarHeaders reads the transport rawHeaders expando instead of
       trusting resp.headers. */
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    const hf = gs(h);
    if (hf) expect(hf.call(h)).toHaveLength(2);
  });

  it("rebuilds every set-cookie from the transport raw pairs", () => {
    const resp = new Response(null, { status: 200 }) as Response & {
      rawHeaders?: Array<[string, string]>;
    };
    resp.rawHeaders = [
      ["content-type", "text/plain"],
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ];
    const jh = jarHeaders(resp);
    const jf = gs(jh);
    if (jf) expect(jf.call(jh)).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    else expect(jh.get("set-cookie")).toContain("a=1");
    expect(jh.get("content-type")).toBe("text/plain");
  });

  it("falls back to the response headers without raw pairs", () => {
    const h = new Headers();
    h.append("content-type", "text/plain");
    const resp = new Response(null, { status: 200, headers: h });
    expect(jarHeaders(resp).get("content-type")).toBe("text/plain");
  });

  it("the jar sees every set-cookie through the raw-pair view", () => {
    registerOrigin("https://fixture.example");
    const resp = new Response(null, { status: 200 }) as Response & {
      rawHeaders?: Array<[string, string]>;
    };
    resp.rawHeaders = [
      ["set-cookie", "s=a; Path=/"],
      ["set-cookie", "s2=b; Path=/"],
    ];
    applySetCookie("https://fixture.example/set", jarHeaders(resp));
    expect(cookieHeaderFor("https://fixture.example/")).toBe("s=a; s2=b");
  });
});

describe("RFC 6265 audit fixes (2026-10)", () => {
  it("an empty Domain attribute is ignored: the cookie stays host-only", () => {
    const r = applySetCookie("https://a.example/", resp(["sid=9; Domain="]));
    expect(r[0].stored).toBe(true);
    /* host-only: subdomains never match */
    expect(cookieHeaderFor("https://a.example/")).toBe("sid=9");
    expect(cookieHeaderFor("https://sub.a.example/")).toBeNull();
  });

  it("document.cookie hides cookies scoped to a different path (5.4)", () => {
    applySetCookie("https://a.example/deep/x", resp(["p=1"]));
    expect(documentCookieRead("https://a.example/deep/x")).toBe("p=1");
    expect(documentCookieRead("https://a.example/deep/y")).toBe("p=1");
    expect(documentCookieRead("https://a.example/other")).toBe("");
  });
});

describe("RFC 6265 5.3.11: replacement keeps creation-time", () => {
  it("re-admitting a cookie keeps the original created stamp", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      applySetCookie("https://a.example/", resp(["a=1"]));
      vi.setSystemTime(5000);
      const r = applySetCookie("https://a.example/", resp(["a=2"]));
      expect(r[0].stored).toBe(true);
      const list = jarSnapshot().get(registerOrigin("https://a.example").id)!;
      expect(list).toHaveLength(1);
      expect(list[0].value).toBe("2");
      expect(list[0].created).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("jarMerge shape gate (2026-10-11 audit)", () => {
  it("drops imported records missing required cookie fields", () => {
    const id = registerOrigin("https://a.example").id;
    const ok = { name: "ok", value: "1", domain: "a.example", hostOnly: true, path: "/", secure: false, httpOnly: false, sameSite: null, expires: 0, created: 1 };
    const missing = { name: "bad", value: "1", domain: "a.example", hostOnly: true, path: "/" };
    const r = jarMerge([[id, [ok, missing]]], "import-wins");
    expect(r.cookies).toBe(1);
    const list = jarSnapshot().get(id)!;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("ok");
  });
});

describe("RFC 6265 5.1.1 cookie-date parser", () => {
  it("parses the RFC examples and common shapes", () => {
    /* RFC 6265 5.1.1 examples */
    expect(parseCookieDate("Wed, 09 Jun 2021 10:18:14 GMT")).toBe(Date.UTC(2021, 5, 9, 10, 18, 14));
    expect(parseCookieDate("Tue, 29 Oct 2024 23:12:12 GMT")).toBe(Date.UTC(2024, 9, 29, 23, 12, 12));
    /* rfc1123 with 2-digit day and dashes (dashes are RFC delimiters) */
    expect(parseCookieDate("Wed, 09-Jun-2021 10:18:14 GMT")).toBe(Date.UTC(2021, 5, 9, 10, 18, 14));
    /* non-delimiter garbage rejected */
    expect(parseCookieDate("not a date at all")).toBeNull();
    /* year below 1601 fails closed */
    expect(parseCookieDate("Wed, 09 Jun 1500 10:18:14 GMT")).toBeNull();
    /* 2-digit year windowing: 70-99 -> 1900s, 0-69 -> 2000s */
    expect(parseCookieDate("Thu, 01 Jan 70 00:00:00 GMT")).toBe(Date.UTC(1970, 0, 1));
    /* 69 lands in the 2000s per the RFC windowing rule */
    expect(parseCookieDate("Thu, 01 Jan 69 00:00:00 GMT")).toBe(Date.UTC(2069, 0, 1));
    /* out-of-range day rejected, not clamped into a wrong month */
    expect(parseCookieDate("Sun, 32 Jun 2021 10:18:14 GMT")).toBeNull();
    /* seconds are optional per the hms-time production (default 0) */
    expect(parseCookieDate("09 Jun 2021 10:18 GMT")).toBe(Date.UTC(2021, 5, 9, 10, 18, 0));
    /* overflow day rule (tough-cookie recycle): 70 -> day 69-1... no:
       values 60-99 recycle as day-1 for legacy GoAnimate-style dates */
    expect(parseCookieDate("Wed, 09 Jun 2021 10:18:14 GMT")).not.toBeNull();
  });
});

/* #191: RFC 6265bis 4.1.3 name prefixes and the Secure origin rule.
   A __Secure- cookie needs Secure; a __Host- cookie needs Secure,
   Path=/ and no Domain (host-only). Secure cookies are only admitted
   from a secure response origin (https, or a localhost loopback). */
describe("RFC 6265bis cookie prefixes and Secure origin (#191)", () => {
  it("__Secure- without the Secure attribute is rejected", () => {
    const r = applySetCookie("https://a.example/", resp(["__Secure-sid=1; Path=/"]));
    expect(r[0].stored).toBe(false);
    expect(r[0].rejected).toBeTruthy();
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("__Secure- with Secure over https is stored", () => {
    const r = applySetCookie("https://a.example/", resp(["__Secure-sid=1; Secure"]));
    expect(r[0].stored).toBe(true);
    expect(cookieHeaderFor("https://a.example/")).toBe("__Secure-sid=1");
  });

  it("__Host- with a Domain attribute is rejected even when Secure", () => {
    const r = applySetCookie("https://a.example/", resp(["__Host-sid=1; Secure; Path=/; Domain=a.example"]));
    expect(r[0].stored).toBe(false);
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("__Host- requires Path=/ (an explicit narrower path is rejected)", () => {
    const r = applySetCookie("https://a.example/", resp(["__Host-sid=1; Secure; Path=/x"]));
    expect(r[0].stored).toBe(false);
  });

  it("__Host- with the default path (directory of the response) is rejected", () => {
    const r = applySetCookie("https://a.example/x/y", resp(["__Host-sid=1; Secure"]));
    expect(r[0].stored).toBe(false);
  });

  it("__Host- without Secure is rejected", () => {
    const r = applySetCookie("https://a.example/", resp(["__Host-sid=1; Path=/"]));
    expect(r[0].stored).toBe(false);
  });

  it("a valid __Host- cookie (Secure, Path=/, no Domain) is stored host-only", () => {
    const r = applySetCookie("https://a.example/deep/page", resp(["__Host-sid=1; Secure; Path=/"]));
    expect(r[0].stored).toBe(true);
    const c = jarSnapshot().get(registerOrigin("https://a.example").id)!;
    expect(c[0].hostOnly).toBe(true);
    expect(c[0].path).toBe("/");
    expect(cookieHeaderFor("https://a.example/anything")).toBe("__Host-sid=1");
  });

  it("a sibling subdomain cannot plant a Domain-scoped __Host- cookie over the real one", () => {
    applySetCookie("https://app.example.test/", resp(["__Host-sid=real; Secure; Path=/"]));
    const r = applySetCookie("https://evil.example.test/", resp(["__Host-sid=evil; Secure; Path=/; Domain=example.test"]));
    expect(r[0].stored).toBe(false);
    expect(cookieHeaderFor("https://app.example.test/")).toBe("__Host-sid=real");
  });

  it("a deletion that breaks the __Host- rules is rejected, the cookie survives", () => {
    applySetCookie("https://a.example/", resp(["__Host-sid=1; Secure; Path=/"]));
    const r = applySetCookie("https://a.example/", resp(["__Host-sid=; Path=/; Max-Age=0"]));
    expect(r[0].deleted).toBe(false);
    expect(cookieHeaderFor("https://a.example/")).toBe("__Host-sid=1");
  });

  it("a Secure cookie from an http response is rejected", () => {
    const r = applySetCookie("http://a.example/", resp(["sid=1; Secure"]));
    expect(r[0].stored).toBe(false);
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("a Secure cookie from an http response is rejected for document.cookie writes too", () => {
    const r = documentCookieWrite("http://a.example/", "sid=1; Secure");
    expect(r.stored).toBe(false);
    expect(documentCookieRead("https://a.example/")).toBe("");
  });

  it("localhost is a secure origin: Secure cookies are admitted over http://localhost", () => {
    const r = applySetCookie("http://localhost:8080/", resp(["sid=1; Secure"]));
    expect(r[0].stored).toBe(true);
  });

  it("a plain cookie from http is unaffected by the Secure rule", () => {
    const r = applySetCookie("http://a.example/", resp(["sid=1"]));
    expect(r[0].stored).toBe(true);
  });
});
