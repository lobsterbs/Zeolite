import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDest } from "../codec";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
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
