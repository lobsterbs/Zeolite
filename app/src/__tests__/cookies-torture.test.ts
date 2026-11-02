import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CookieJar, parseDate } from "tough-cookie";
import { openDb, idbClear, idbGet, idbPut, STORE_COOKIES } from "../extensions/idb";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieItems,
  documentCookieWrite,
  jarClearScope,
  jarEnumeration,
  jarLoad,
  jarMerge,
  jarPersist,
  jarReplace,
  jarSnapshot,
  onCookieJarChange,
  parseCookieDate,
  registerOrigin,
  setSameSitePolicy,
  cookieStoreOp,
} from "../cookies";

/* Cookie-jar torture suite.

   Three layers:
   - deterministic edge cases for the seams the reading found risky
     (identity across origin buckets, expiry precedence, corrupt
     persistence, import-key injection, capacity policy #598 and
     facade grammar #599);
   - a seeded fuzz of the date parser and the admission/assembly path
     differentially tested against tough-cookie, with every deviation
     classified: the suite fails on any UNCLASSIFIED deviation;
   - pinned "deliberate delta" behavior where this jar follows the
     RFC/browsers and tough-cookie does not (the same policy
     cookies-oracle.test.ts documents), plus pinned known limitations.

   Delta classes the fuzz accepts, each with its reason:
   - samesite-none-without-secure: RFC 6265bis hard gate, tough admits.
   - __Secure-/__Host- prefix rules: ours enforces, tough ignores.
   - Secure from an insecure origin: ours refuses, tough admits.
     (For all three: ours refuses the whole header, so it also never
     applies a replace/delete that header would have carried - tough
     does. The fuzz classifier accepts any divergence whose involved
     cookie names are all gated-header names.)
   - host-only vs Domain coexistence: RFC 6265 5.3 step 11 makes the
     host-only flag part of cookie identity, so both cookies live and
     both attach; tough-cookie collapses them into one.
   - empty Path attribute: ours ignores it per RFC 6265 5.2.4; tough
     lets the empty path win, which then matches every request path.
   - same-millisecond creation ties: RFC 6265 5.4 orders equal-path
     cookies by creation time but leaves ms ties unspecified; ours
     breaks them by admission order, tough by its internal order.
   - dates: RFC-optional seconds, day-shaped tokens outside 1-31, the
     '.' delimiter splitting fractional seconds, and day-of-month
     overflow (ours normalizes like Firefox, tough rejects). */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}
function admit(url: string, header: string): ReturnType<typeof applySetCookie> {
  return applySetCookie(url, resp([header]));
}
function ours(url: string, ctx?: { initiator?: string; navigation?: boolean }): string {
  return cookieHeaderFor(url, ctx) ?? "";
}

/* ------------------------------------------------------------------ */
/* deterministic: cookie identity across origin buckets                */
/* ------------------------------------------------------------------ */

describe("cookie identity across origin buckets (RFC 6265 5.3 step 11)", () => {
  /* The jar stores cookies in per-origin buckets, but cookie identity
     is (name, domain, host-only, path) - scheme, port and admitting
     subdomain are NOT part of it. Replacement and deletion must
     therefore consider every bucket of the profile. */

  it("replaces the same identity set via http and https", () => {
    admit("https://a.example/", "b=1");
    admit("http://a.example/", "b=2");
    expect(ours("https://a.example/")).toBe("b=2");
    expect(ours("http://a.example/")).toBe("b=2");
    expect(ours("https://a.example:8443/")).toBe("b=2");
  });

  it("replaces the same identity across ports", () => {
    admit("https://a.example:8443/", "p=1");
    admit("https://a.example/", "p=2");
    expect(ours("https://a.example/")).toBe("p=2");
  });

  it("replaces a Domain cookie admitted from sibling subdomains", () => {
    admit("https://sub.a.example/", "d=1; Domain=a.example");
    admit("https://www.a.example/", "d=2; Domain=a.example");
    expect(ours("https://x.a.example/")).toBe("d=2");
  });

  it("a deletion via the other scheme kills the cookie (no zombies)", () => {
    admit("https://a.example/", "z=1");
    const r = admit("http://a.example/", "z=; Max-Age=0");
    expect(r[0].deleted).toBe(true);
    expect(ours("https://a.example/")).toBe("");
  });

  it("a Domain-cookie deletion from a sibling kills it everywhere", () => {
    admit("https://sub.a.example/", "q=1; Domain=a.example");
    admit("https://www.a.example/", "q=; Domain=a.example; Max-Age=0");
    expect(ours("https://x.a.example/")).toBe("");
  });

  it("replacement keeps the original creation time wherever it lives", () => {
    admit("https://a.example/", "first=1");
    admit("https://a.example/", "later=1");
    admit("http://a.example/", "first=2");
    expect(ours("https://a.example/")).toBe("first=2; later=1");
  });

  it("host-only and Domain cookies stay distinct identities (RFC)", () => {
    admit("https://a.example/", "h=host");
    admit("https://a.example/", "h=dom; Domain=a.example");
    expect(ours("https://a.example/")).toBe("h=host; h=dom");
    expect(ours("https://sub.a.example/")).toBe("h=dom");
  });

  it("an HttpOnly cookie is protected from script writes in every bucket", () => {
    admit("http://a.example/", "s=1; HttpOnly");
    const r = documentCookieWrite("https://a.example/", "s=2");
    expect(r.rejected).toBe("httponly");
    expect(ours("https://a.example/")).toBe("s=1");
  });

  it("the jar change event fires once per deletion, not once per bucket", () => {
    admit("https://a.example/", "e=1");
    admit("http://a.example/", "dup=1");
    admit("https://a.example/", "dup=2"); /* collapses the two buckets */
    const events: string[] = [];
    const off = onCookieJarChange((c) => events.push(c.result.name + ":" + (c.result.deleted ? "del" : "set")));
    admit("http://a.example/", "e=; Max-Age=0");
    admit("https://a.example/", "e=; Max-Age=0"); /* second delete is a no-op */
    off();
    expect(events).toEqual(["e:del"]);
  });
});

/* ------------------------------------------------------------------ */
/* deterministic: expiry precedence                                    */
/* ------------------------------------------------------------------ */

describe("expiry precedence (RFC 6265 5.3: Max-Age wins)", () => {
  it("a live Max-Age with a stale Expires is stored, not deleted", () => {
    const r = admit("https://a.example/", "x=1; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(r[0].stored).toBe(true);
    expect(ours("https://a.example/")).toBe("x=1");
  });

  it("a live Max-Age with a stale Expires replaces the old value", () => {
    admit("https://a.example/", "x=1");
    admit("https://a.example/", "x=2; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(ours("https://a.example/")).toBe("x=2");
  });

  it("Max-Age<=0 deletes even with a future Expires", () => {
    admit("https://a.example/", "y=1");
    const r = admit("https://a.example/", "y=; Max-Age=0; Expires=Wed, 01 Jan 2031 00:00:00 GMT");
    expect(r[0].deleted).toBe(true);
    expect(ours("https://a.example/")).toBe("");
  });

  it("a stale Expires alone still deletes", () => {
    admit("https://a.example/", "z=1");
    const r = admit("https://a.example/", "z=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(r[0].deleted).toBe(true);
    expect(ours("https://a.example/")).toBe("");
  });

  it("a future Expires with no Max-Age is stored", () => {
    const r = admit("https://a.example/", "f=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT");
    expect(r[0].stored).toBe(true);
    expect(ours("https://a.example/")).toBe("f=1");
  });
});

/* ------------------------------------------------------------------ */
/* deterministic: persistence resilience                                */
/* ------------------------------------------------------------------ */

describe("persistence torture", () => {
  beforeEach(async () => {
    const db = await openDb();
    await idbClear(db, STORE_COOKIES);
  });

  it("restores the durable jar after persist + reset (control)", async () => {
    admit("https://good.example/", "seed=1");
    await jarPersist();
    cookiesResetForTests();
    await jarLoad();
    expect(ours("https://good.example/")).toBe("seed=1");
  });

  it("one corrupt origins row must not take the whole jar down", async () => {
    admit("https://good.example/", "seed=1");
    await jarPersist();
    const db = await openDb();
    const id = registerOrigin("https://good.example").id;
    await idbPut(db, STORE_COOKIES, "origins", [
      [id, "https://good.example"],
      ["zz", "not a url at all"],
      ["zz2", "http://"],
    ]);
    cookiesResetForTests();
    await jarLoad();
    /* the good row still restores its cookies; the bad rows are
       skipped, and the restore must not abort halfway */
    expect(ours("https://good.example/")).toBe("seed=1");
  });

  it("drops malformed cookie records but keeps the valid ones", async () => {
    admit("https://good.example/", "seed=1");
    await jarPersist();
    const db = await openDb();
    const id = registerOrigin("https://good.example").id;
    const good = { name: "k", value: "v", domain: "good.example", hostOnly: true, path: "/",
      secure: false, httpOnly: false, sameSite: null, expires: 0, created: 1 };
    await idbPut(db, STORE_COOKIES, "jar", [
      [id, [{ name: "bad", value: 1, domain: "good.example", hostOnly: true, path: "/",
        secure: false, httpOnly: false, expires: 0, created: 1 }, good]],
      "garbage-not-a-pair",
      [42, [good]],
    ]);
    cookiesResetForTests();
    await jarLoad();
    expect(ours("https://good.example/")).toBe("k=v");
  });

  it("a zombie deletion must not resurrect through persistence", async () => {
    admit("https://a.example/", "z=1");
    admit("http://a.example/", "z=; Max-Age=0");
    await jarPersist();
    cookiesResetForTests();
    await jarLoad();
    expect(ours("https://a.example/")).toBe("");
  });

  it("session-profile cookies never touch IndexedDB", async () => {
    admit("https://a.example/", "d=1");
    const db = await openDb();
    await idbClear(db, STORE_COOKIES);
    await jarPersist();
    const rec = (await idbGet(db, STORE_COOKIES, "jar")) as Array<[string, unknown[]]>;
    expect(rec.length).toBeGreaterThan(0);
    expect(rec.every(([k]) => !k.includes("\u0000"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* deterministic: import seam hardening                                 */
/* ------------------------------------------------------------------ */

describe("import seam torture (zl:importSession keys)", () => {
  const SEP = "\u0000";
  const evilKey = "client:evil" + SEP + "abc123";
  const cookie = { name: "ghost", value: "1", domain: "a.example", hostOnly: true, path: "/",
    secure: false, httpOnly: false, sameSite: null, expires: 0, created: 1 };

  it("jarReplace refuses keys carrying the profile separator", () => {
    jarReplace([[evilKey, [cookie]]]);
    /* no phantom profile in enumeration, nothing reachable */
    expect(jarEnumeration().map((v) => v.profile)).toEqual(["default"]);
    expect(jarSnapshot().size).toBe(0);
    expect(ours("https://a.example/")).toBe("");
  });

  it("jarMerge refuses them too and reports honest counts", () => {
    const r = jarMerge([[evilKey, [cookie]]], "import-wins");
    expect(r).toEqual({ jars: 0, cookies: 0, conflicts: 0 });
    expect(jarEnumeration().map((v) => v.profile)).toEqual(["default"]);
  });

  it("jarReplace also refuses an empty key", () => {
    jarReplace([["", [cookie]]]);
    expect(jarSnapshot().size).toBe(0);
  });

  it("valid bare-origin-id keys still import", () => {
    const id = registerOrigin("https://a.example").id;
    jarReplace([[id, [cookie]]]);
    expect(ours("https://a.example/")).toBe("ghost=1");
  });
});

/* ------------------------------------------------------------------ */
/* deterministic: capacity policy + boundary behavior                   */
/* ------------------------------------------------------------------ */

describe("capacity and boundary pins", () => {
  it("per-domain cap: the 51st admission evicts the oldest of that domain, siblings untouched", () => {
    admit("https://a.example/", "old=1");
    const headers: string[] = [];
    for (let i = 0; i < 50; i++) headers.push(`c${i}=v`);
    applySetCookie("https://a.example/", resp(headers));
    expect(ours("https://a.example/")).not.toContain("old=1");
    let total = 0;
    for (const [, l] of jarSnapshot()) total += l.length;
    expect(total).toBe(50);
    /* a.example's overflow never drops another domain's cookies */
    admit("https://b.example/", "sib=1");
    expect(ours("https://b.example/")).toBe("sib=1");
  });

  it("eviction order: expired first, then soonest expiry, session last, ties by age", () => {
    const headers: string[] = [];
    headers.push("soon=1; Max-Age=60");
    for (let i = 0; i < 49; i++) headers.push(`s${i}=v`);
    applySetCookie("https://a.example/", resp(headers));
    /* the just-stored identity is protected from its own admission's
       pass, so the soonest-expiring EXISTING cookie goes first */
    admit("https://a.example/", "extra=1");
    expect(ours("https://a.example/")).not.toContain("soon=1");
    expect(ours("https://a.example/")).toContain("s0=");
    expect(ours("https://a.example/")).toContain("extra=1");
    /* one more admission evicts the oldest session cookie */
    admit("https://a.example/", "extra2=1");
    expect(ours("https://a.example/")).not.toContain("s0=");
    expect(ours("https://a.example/")).toContain("s1=");
  });

  it("byte cap: an oversized cookie is refused whole; exactly at cap is admitted", () => {
    expect(admit("https://a.example/", "k=" + "x".repeat(4095))[0].stored).toBe(true);
    const r = admit("https://a.example/", "big=" + "x".repeat(4096));
    expect(r[0]).toMatchObject({ stored: false, rejected: "size" });
    expect(ours("https://a.example/")).toBe("k=" + "x".repeat(4095));
    expect(jarSnapshot().size).toBe(1);
  });

  it("deletions are never size-gated", () => {
    const r = admit("https://a.example/", "big=" + "x".repeat(5000) + "; Max-Age=0");
    expect(r[0]).toMatchObject({ stored: false, deleted: false });
    expect(r[0].rejected).toBeUndefined();
  });

  it("total cap: 3000 per profile, oldest creations go; per-domain caps bound one origin's share", () => {
    const entries: Array<[string, unknown[]]> = [];
    let created = 1;
    for (let d = 0; d < 61; d++) {
      const id = registerOrigin(`https://h${d}.example`).id;
      const list: unknown[] = [];
      for (let i = 0; i < 50; i++) {
        list.push({
          name: `d${d}c${i}`, value: "v", domain: `h${d}.example`, hostOnly: true, path: "/",
          secure: false, httpOnly: false, sameSite: null, expires: 0, created: created++,
        });
      }
      entries.push([id, list]);
    }
    jarReplace(entries);
    /* one admission over the 3050-cookie import triggers the sweep */
    admit("https://h60.example/", "trigger=1");
    let total = 0;
    for (const [, l] of jarSnapshot()) total += l.length;
    expect(total).toBe(3000);
    expect(ours("https://h0.example/")).toBe("");
    /* h60 was already at its per-domain cap: the protected trigger
       stays, the domain's oldest cookie pays for it */
    expect(ours("https://h60.example/")).toContain("trigger=1");
    expect(ours("https://h60.example/")).not.toContain("d60c0=");
  });

  it("persist-time enforcement bounds the durable record", async () => {
    const id = registerOrigin("https://a.example").id;
    const list: unknown[] = [];
    for (let i = 0; i < 60; i++) {
      list.push({
        name: `p${i}`, value: "v", domain: "a.example", hostOnly: true, path: "/",
        secure: false, httpOnly: false, sameSite: null, expires: 0, created: i + 1,
      });
    }
    jarReplace([[id, list]]);
    await jarPersist();
    let total = 0;
    for (const [, l] of jarSnapshot()) total += l.length;
    expect(total).toBe(50);
  });

  it("evictions surface as jar change records (cookies.onChanged consistency)", () => {
    const seen: Array<{ result: { name: string; stored: boolean; deleted: boolean } }> = [];
    onCookieJarChange((c) => seen.push(c));
    admit("https://a.example/", "old=1");
    const headers: string[] = [];
    for (let i = 0; i < 50; i++) headers.push(`c${i}=v`);
    applySetCookie("https://a.example/", resp(headers));
    const evicted = seen.find((c) => c.result.deleted && c.result.name === "old");
    expect(evicted).toBeTruthy();
  });

  it("control characters are refused in names and values (page seam)", () => {
    /* The response seam cannot carry CTLs through Node's Headers (undici
       rejects them first); the page seam - documentCookieWrite - is where
       they actually reach the parser, #349. Edge whitespace CTLs are
       trimmed away first (browser behavior); CTLs inside the name or
       value are refused. */
    for (const bad of ["a\x00b=1", "a=1\x7f", "a=1\r\nb", "a\tb=1", "=\x01"]) {
      const r = documentCookieWrite("https://a.example/", bad);
      expect(r.stored).toBe(false);
    }
    expect(ours("https://a.example/")).toBe("");
  });

  it("UTF-8 values round-trip", () => {
    admit("https://a.example/", "café=crème");
    expect(ours("https://a.example/")).toBe("café=crème");
    expect(documentCookieItems("https://a.example/")[0].value).toBe("crème");
  });

  it("cookie names are case-sensitive", () => {
    admit("https://a.example/", "a=1");
    admit("https://a.example/", "A=2");
    expect(ours("https://a.example/")).toBe("a=1; A=2");
  });

  it("attribute names are case-insensitive; Domain values lowercase", () => {
    admit("https://sub.EXAMPLE.com/", "up=1; DOMAIN=EXAMPLE.com; PATH=/; SECURE; MAX-AGE=3600");
    expect(ours("https://www.example.com/x")).toBe("up=1");
    expect(ours("http://www.example.com/")).toBe("");
  });

  it("duplicate attributes: the last Path wins; an empty Path is ignored", () => {
    admit("https://a.example/d/p", "x=1; Path=/a; Path=/b");
    expect(ours("https://a.example/b/q")).toBe("x=1");
    expect(ours("https://a.example/a/q")).toBe("");
    admit("https://a.example/d/p", "y=1; Path=");
    /* empty Path attribute is ignored -> default path /d */
    expect(ours("https://a.example/d/q")).toBe("y=1");
  });

  it("an empty Domain attribute is ignored (host-only)", () => {
    admit("https://a.example/", "e=1; Domain=");
    expect(ours("https://sub.a.example/")).toBe("");
    expect(ours("https://a.example/")).toBe("e=1");
  });

  it("IP hosts: a Domain equal to the IP host is host-only in effect", () => {
    admit("https://127.0.0.1/", "ipd=1; Domain=127.0.0.1");
    expect(ours("https://127.0.0.1/")).toBe("ipd=1");
    /* no suffix games on IPs */
    admit("https://1.2.3.4/", "ips=1; Domain=3.4");
    expect(ours("https://1.2.3.4/")).toBe("");
  });

  it("a trailing-dot host does not domain-match the undotted domain", () => {
    admit("https://example.com./", "dot=1; Domain=example.com");
    expect(ours("https://example.com./")).toBe("");
    expect(jarSnapshot().size).toBe(0);
  });

  it("cookies attach across ports and (non-Secure) across schemes", () => {
    admit("https://a.example/", "p=1");
    expect(ours("https://a.example:8443/x")).toBe("p=1");
    expect(ours("http://a.example:8080/x")).toBe("p=1");
  });

  it("__Host- deletion attempts that break the prefix rules are refused", () => {
    admit("https://a.example/", "__Host-k=1; Secure");
    const r = admit("https://sub.a.example/", "__Host-k=; Domain=a.example; Secure; Max-Age=0");
    expect(r[0].stored).toBe(false);
    expect(ours("https://a.example/")).toBe("__Host-k=1");
  });

  it("cookieStore.set rejects names/values that could smuggle attributes (#599)", () => {
    /* the crafted value that used to land a cross-subdomain Secure
       cookie now dies at the facade boundary with TypeError */
    expect(() =>
      cookieStoreOp("set", { name: "inj", value: "1; Domain=example.com; Secure" }, "https://sub.example.com/"),
    ).toThrow(TypeError);
    expect(ours("https://www.example.com/")).toBe("");
    expect(() =>
      cookieStoreOp("set", { name: "sn", value: "1; SameSite=None" }, "https://sub.example.com/"),
    ).toThrow(TypeError);
    /* the grammar invariant: ';' is neither a token char nor a
       cookie-octet, so no smuggle string can pass validation */
    for (const bad of ["1; Domain=x", "1; Secure", "a,b", 'q"q', "a\\b", " v", "v ", "x\x00y", "x\x7f"]) {
      expect(() => cookieStoreOp("set", { name: "n", value: bad }, "https://a.example/")).toThrow(TypeError);
    }
    for (const badName of ["k; Path=/wrong", "a b", "k=v", "", "x\x00y", "(k)", "k@l"]) {
      expect(() => cookieStoreOp("set", { name: badName, value: "1" }, "https://a.example/")).toThrow(TypeError);
    }
    /* a crafted path is the same smuggle vector: refused */
    expect(() =>
      cookieStoreOp("set", { name: "p", value: "1", path: "/x; Domain=example.com" }, "https://sub.example.com/"),
    ).toThrow(TypeError);
    /* legal cookie-octets still round-trip, including '=' */
    cookieStoreOp("set", { name: "ok", value: "a=b?c[d]e{f}g:h" }, "https://a.example/");
    expect(ours("https://a.example/")).toContain("ok=a=b?c[d]e{f}g:h");
  });

  it("cookieStore.delete with an unround-trippable name rejects loudly (#599)", () => {
    cookieStoreOp("set", { name: "k", value: "1", path: "/d" }, "https://a.example/d/p");
    /* the crafted name used to serialize into a malformed pair and
       silently drop the deletion; now it rejects */
    expect(() => cookieStoreOp("delete", { name: "k; Path=/wrong" }, "https://a.example/d/p")).toThrow(TypeError);
    expect(ours("https://a.example/d/q")).toBe("k=1");
    /* a valid delete still deletes */
    cookieStoreOp("delete", { name: "k", path: "/d" }, "https://a.example/d/p");
    expect(ours("https://a.example/d/q")).toBe("");
  });

  it("clearJar on garbage is refused, not coerced", () => {
    admit("https://a.example/", "c=1");
    expect(jarClearScope("a".repeat(65), undefined)).toMatchObject({ ok: false });
    expect(jarClearScope("x\u0000y", undefined)).toMatchObject({ ok: false });
    expect(jarClearScope(undefined, "not a url $")).toMatchObject({ ok: false });
    expect(ours("https://a.example/")).toBe("c=1");
    expect(jarClearScope(undefined, undefined)).toMatchObject({ ok: true, cookies: 1 });
    expect(ours("https://a.example/")).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* fuzz: date parser vs tough-cookie                                    */
/* ------------------------------------------------------------------ */

describe("parseCookieDate fuzz (tough-cookie differential)", () => {
  /* deterministic LCG so a failure is reproducible from the seed */
  let seed = 0x600d1e;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Wednesday", "Funday"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Xxx", "DEC", "may"];
  const YEARS = ["68", "69", "70", "94", "99", "00", "42", "06", "1420", "1601", "1994", "2015", "2031", "9999", "10000", "0"];
  const DAYS = ["0", "1", "6", "06", "21", "28", "31", "32", "59", "60", "94", "99", "6x", "42"];
  const TIMES = ["07:28:00", "7:28", "07:28", "08:49:37", "25:00:00", "08:60:00", "08:49:60", "07:28:00.5", "12345678:12:12", "0:0:0"];
  const ZONES = ["GMT", "UTC", "PST", "", "+0100"];

  function gen(): string {
    const d = pick(DAYS), mon = pick(MON), y = pick(YEARS), t = pick(TIMES);
    const dow = pick(DOW);
    const sep = pick([" ", ", ", "-", "\t", "  ", ",\t"]);
    const garbage = pick(["", " 42", " xxx", " " + pick(DAYS)]);
    switch (Math.floor(rnd() * 8)) {
      case 0: return `${dow},${sep}${d}${sep}${mon}${sep}${y}${sep}${t}${sep}${pick(ZONES)}${garbage}`;
      case 1: return `${dow}, ${d}-${mon}-${y} ${t} ${pick(ZONES)}`;
      case 2: return `${mon} ${d} ${t} ${y}`;
      case 3: return `${t} ${dow} ${d} ${mon} ${y}`;
      case 4: return `${dow} ${d} ${mon} ${y}`;
      case 5: return `${dow.toUpperCase()}, ${d} ${mon.toUpperCase()} ${y} ${t.toUpperCase()} GMT`;
      case 6: return `${dow},${sep}${d}${sep}${mon}${sep}${y}${sep}${t}${sep}${y}`;
      default: return `${d} ${mon} ${y} ${t}`;
    }
  }

  const DELIM = /[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]+/;
  const toks = (s: string): string[] => s.split(DELIM).filter(Boolean);
  /* Divergence shapes where ours legitimately differs from tough-cookie
     on garbage dates (all documented in the suite header):
     - a time token without seconds (RFC makes them optional; tough
       requires hh:mm:ss);
     - a standalone day-shaped token outside 1-31 (0, 32-99): the RFC
       grammar has no range check, so whether such a token becomes day,
       year or nothing is implementation freedom;
     - a '.' anywhere: the RFC delimiter set splits fractional seconds
       into two tokens, tough does not;
     - a day token 29-31 paired with a short month: ours normalizes the
       overflow like Date.UTC/Firefox, tough rejects the date. */
  const SHORT_MONTHS = /^(feb|apr|jun|sep|nov)$/i;
  const divergentShape = (s: string): boolean => {
    const t = toks(s);
    if (t.some((x) => /^\d{1,2}:\d{1,2}$/.test(x))) return true;
    if (t.some((x) => /^(0|[3-9]\d)$/.test(x))) return true;
    if (s.includes(".")) return true;
    const monthIdx = t.findIndex((x) => /^[a-z]{3}/i.test(x) && SHORT_MONTHS.test(x.slice(0, 3)));
    return monthIdx >= 0 && t.some((x) => /^(29|30|31)$/.test(x));
  };

  it("agrees with tough-cookie outside the documented deltas", () => {
    const unexplained: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const s = gen();
      const o = parseCookieDate(s);
      const t = parseDate(s);
      const tv = t === undefined ? null : t.getTime();
      if (o === tv) continue;
      if (o !== null && tv === null && divergentShape(s)) continue; /* documented divergence on garbage dates */
      if (o === null && tv !== null) { unexplained.push(`ours=null tough=${tv} ${JSON.stringify(s)}`); continue; }
      unexplained.push(`ours=${o} tough=${tv} ${JSON.stringify(s)}`);
    }
    expect(unexplained.slice(0, 20), "seed 0x600d1e").toEqual([]);
  });

  it("curated corpus: exact values (RFC 6265 5.1.1 semantics)", () => {
    const cases: Array<[string, number | null]> = [
      ["Sun, 06 Nov 1994 08:49:37 GMT", 784111777000],
      ["Sunday, 06-Nov-94 08:49:37 GMT", 784111777000],
      ["Sun Nov  6 08:49:37 1994", 784111777000],
      ["Sun, 06 94 08:49:37 Nov", 784111777000],
      ["07:28:00 Wed, 21 Oct 2015 GMT", 1445412480000],
      ["Wed, 21 Oct 2015 07:28:00 GMT extra tokens 42", 1445412480000],
      ["Wed, 21 42 Oct 2015 07:28:00 GMT", 2297489280000],
      ["Wed, 21 Oct 42 07:28:00 GMT", 2297489280000],
      ["Wed, 21 Oct 2015 07:28:00 2015", 1445412480000],
      ["Sun, 06 Nov 1601 08:49:37 GMT", -11617744223000],
      ["Sun, 06 Nov 9999 08:49:37 GMT", 253397494177000],
      ["Wed, 21 Oct 2015 07:28 GMT", 1445412480000],
      ["Sun, 94 Nov 06 08:49:37 1994", 784111777000],
      /* day-of-month overflow normalizes like Date.UTC (Firefox-style);
         tough-cookie rejects these outright - documented divergence */
      ["31 Sep 06 07:28:00", Date.UTC(2006, 8, 31, 7, 28)],
      ["Feb 30 2015 00:00:00 GMT", Date.UTC(2015, 1, 30)],
      ["Sun, 42 May 06 07:28:00 06", Date.UTC(2042, 4, 6, 7, 28)],
      ["07:28:00.5 Jan 9999 42", Date.UTC(9999, 0, 5, 7, 28)],
      ["SUN, 06 NOV 1994 08:49:37 GMT", 784111777000],
      ["Wed, 13 Oct 68 12:00:00", 3117355200000],
      ["Wed, 13 Oct 69 12:00:00", 3148891200000],
      ["Wed, 13 Oct 70 12:00:00", 24667200000],
      ["01 Jan 00 00:00:00 GMT", 946684800000],
      ["2015-10-21T07:28:00Z", null],
      ["Wed, 21 Oct 2015", null],
      ["Sun, 06 Xxx 1994 08:49:37 GMT", null],
      ["Sun, 06 Nov 1994 25:00:00 GMT", null],
      ["Sun, 06 Nov 1994 08:60:00 GMT", null],
      ["Sun, 06 Nov 1994 08:49:60 GMT", null],
      ["Sun, 00 Nov 1994 08:49:37 GMT", null],
      ["Sun, 32 Nov 1994 08:49:37 GMT", null],
      ["Sun, 06 Nov 10000 08:49:37 GMT", null],
      ["Sun, 06 Nov 1500 08:49:37 GMT", null],
      ["not a date", null],
      ["Wed Oct 21 2015", null],
      ["7:8:9 Nov 2015", null],
    ];
    for (const [s, want] of cases) expect(parseCookieDate(s), JSON.stringify(s)).toBe(want);
  });
});

/* ------------------------------------------------------------------ */
/* fuzz: admission + assembly vs tough-cookie                           */
/* ------------------------------------------------------------------ */

describe("admission/assembly fuzz (tough-cookie differential)", () => {
  const NAMES = ["a", "b", "sid", "A", "x y", "__Host-x", "__Secure-y"];
  const VALUES = ["1", "2", "", "café", "v w", "1;2", "x".repeat(30)];
  const ATTRS = [
    "Domain=a.example", "Domain=.a.example", "Domain=b.example", "Domain=example",
    "Path=/", "Path=/d", "Path=", "Secure", "HttpOnly", "SameSite=Lax",
    "SameSite=None", "SameSite=None; Secure", "Max-Age=0", "Max-Age=3600",
    "Max-Age=-1", "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Expires=Wed, 01 Jan 2031 00:00:00 GMT",
    "Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  const URLS = [
    "https://a.example/", "https://a.example/d/p", "https://sub.a.example/",
    "https://b.example/", "http://a.example/", "https://a.example:8443/",
  ];

  let seed = 0xc0ffee;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  function defaultPathOf(url: string): string {
    const p = new URL(url).pathname || "/";
    const last = p.lastIndexOf("/");
    return last <= 0 ? "/" : p.slice(0, last);
  }

  /** Static detector for the gates where this jar follows the
      RFC/browsers and tough-cookie admits anyway. */
  function gateFires(header: string, url: string): boolean {
    const semi = header.indexOf(";");
    const pair = (semi < 0 ? header : header.slice(0, semi)).trim();
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq).trim() : "";
    const rest = (semi < 0 ? "" : header.slice(semi + 1)).toLowerCase();
    const has = (k: string) => new RegExp("(^|;)\\s*" + k + "(\\s|;|=|$)").test(rest);
    if (/samesite\s*=\s*none\b/.test(rest) && !has("secure")) return true;
    if (name.startsWith("__Secure-") && !has("secure")) return true;
    if (name.startsWith("__Host-")) {
      const pathMatch = /path\s*=\s*(\/[\x21-\x7e]*)/.exec(rest);
      const effectivePath = pathMatch ? pathMatch[1] : defaultPathOf(url);
      if (!has("secure") || has("domain") || effectivePath !== "/") return true;
    }
    if (has("secure") && !url.startsWith("https://") && !/\/\/(localhost|127\.)/.test(url)) return true;
    return false;
  }

  function toughHeader(seq: Array<[string, string]>, url: string): string {
    const jar = new CookieJar();
    for (const [h, u] of seq) {
      try { jar.setCookieSync(h, u, { http: true }); } catch { /* tough refuses some headers ours admits and vice versa */ }
    }
    return jar.getCookieStringSync(url, { http: true });
  }

  function tokens(s: string): string[] {
    return s === "" ? [] : s.split("; ");
  }

  it("classifies every deviation; none may be unexplained", () => {
    const unexplained: string[] = [];
    for (let i = 0; i < 1500; i++) {
      cookiesResetForTests();
      const seq: Array<[string, string]> = [];
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        let h = pick(NAMES) + "=" + pick(VALUES);
        const na = Math.floor(rnd() * 3);
        for (let a = 0; a < na; a++) h += "; " + pick(ATTRS);
        const url = pick(URLS);
        seq.push([h, url]);
        applySetCookie(url, resp([h]));
      }
      const probe = pick(URLS);
      const o = ours(probe);
      const r = toughHeader(seq, probe);
      if (o === r) continue;
      const om = tokens(o).slice().sort();
      const rm = tokens(r).slice().sort();
      const sameMultiset = om.length === rm.length && om.every((x, j) => x === rm[j]);
      if (sameMultiset) continue; /* creation-time ms tie: order unspecified */

      const headerName = (h: string): string => {
        const pair = h.split(";")[0].trim();
        const eq = pair.indexOf("=");
        return eq > 0 ? pair.slice(0, eq).trim() : "";
      };
      /* Multiplicity-aware name diffs: which cookie names ours holds
         more/less of than the reference, and by how many. */
      const count = (xs: string[]): Map<string, number> => {
        const m = new Map<string, number>();
        for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
        return m;
      };
      const oc = count(om.map((t) => t.split("=")[0]));
      const rc = count(rm.map((t) => t.split("=")[0]));
      const oursOnly: string[] = [];
      const refOnly: string[] = [];
      for (const [n, c] of oc) for (let i = 0; i < c - (rc.get(n) ?? 0); i++) oursOnly.push(n);
      for (const [n, c] of rc) for (let i = 0; i < c - (oc.get(n) ?? 0); i++) refOnly.push(n);
      const involved = new Set<string>([...oursOnly, ...refOnly]);
      /* Names whose value multisets differ (a gated replace changed a
         value in the reference but not in ours) also count as involved. */
      for (const n of new Set([...oc.keys(), ...rc.keys()])) {
        const ov = om.filter((t) => t.split("=")[0] === n);
        const rv = rm.filter((t) => t.split("=")[0] === n);
        if (ov.length === rv.length && ov.some((t, j) => t !== rv[j])) involved.add(n);
      }

      /* Gated headers (where ours follows the RFC/browsers and tough
         admits): ours refuses the whole header, so it neither stores
         the new cookie, nor replaces/deletes a pre-existing identity
         of that name - tough does all three. Any divergence whose
         involved names are all gated-header names is explained. */
      const gatedNames = new Set(seq.filter(([h, u]) => gateFires(h, u)).map(([h]) => headerName(h)));
      if (gatedNames.size > 0 && involved.size > 0 && [...involved].every((nm) => gatedNames.has(nm))) continue;

      /* An empty Path attribute: RFC 6265 5.2.4 says ignore it, ours
         keeps the earlier/default path; tough lets the empty value
         win, and an empty cookie path then matches every request path
         in tough. */
      const emptyPathNames = new Set(
        seq.filter(([h]) => /;\s*path\s*=\s*(;|$)/i.test(h)).map(([h]) => headerName(h)),
      );
      if (emptyPathNames.size > 0 && involved.size > 0 && [...involved].every((nm) => emptyPathNames.has(nm))) continue;

      /* tough-cookie collapses a host-only cookie and a Domain cookie
         of the same name into one identity; RFC 6265 5.3 step 11 keeps
         them distinct, so ours legitimately holds BOTH. Anything else
         ours holds on top of the reference is a real finding. */
      const collapseLegit = oursOnly.length > 0 && refOnly.length === 0 && oursOnly.every((nm) =>
        seq.some(([h]) => headerName(h) === nm && /;\s*domain\s*=/i.test(h)) &&
        seq.some(([h]) => headerName(h) === nm && !/;\s*domain\s*=/i.test(h)));
      if (collapseLegit) continue;

      unexplained.push(`seq=${JSON.stringify(seq)} probe=${probe}\n  ours=${JSON.stringify(o)}\n  ref =${JSON.stringify(r)}`);
    }
    expect(unexplained.slice(0, 10), "seed 0xc0ffee").toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* SameSite knob under torture                                          */
/* ------------------------------------------------------------------ */

describe("SameSite knob torture", () => {
  beforeEach(() => setSameSitePolicy("approx"));

  it("schemeful same-site: http initiator is cross-site to https target", () => {
    admit("https://x.site.co.uk/", "st=1; SameSite=Strict");
    expect(ours("https://x.site.co.uk/a", { initiator: "http://y.site.co.uk/b" })).toBe("");
    expect(ours("https://x.site.co.uk/a", { initiator: "https://y.site.co.uk/b" })).toBe("st=1");
  });

  it("ports do not split the site; scheme does", () => {
    admit("https://a.example/", "st=1; SameSite=Strict");
    expect(ours("https://a.example:8443/x", { initiator: "https://a.example:9999/y" })).toBe("st=1");
    expect(ours("https://a.example/x", { initiator: "http://a.example/y" })).toBe("");
  });

  it("cross-site initiator drops strict, keeps lax only on navigation", () => {
    admit("https://x.example/", "st=1; SameSite=Strict");
    admit("https://x.example/", "lx=1; SameSite=Lax");
    admit("https://x.example/", "nn=1; SameSite=None; Secure");
    expect(ours("https://x.example/a", { initiator: "https://evil.org/b" })).toBe("nn=1");
    expect(ours("https://x.example/a", { initiator: "https://evil.org/b", navigation: true })).toBe("lx=1; nn=1");
  });

  it("unknown initiator attaches (honest approximation)", () => {
    admit("https://x.example/", "st=1; SameSite=Strict");
    expect(ours("https://x.example/a", {})).toBe("st=1");
    expect(ours("https://x.example/a")).toBe("st=1");
  });

  it("IP hosts are their own site", () => {
    admit("https://127.0.0.1/", "st=1; SameSite=Strict");
    expect(ours("https://127.0.0.2/x", { initiator: "https://127.0.0.1/y" })).toBe("");
    expect(ours("https://127.0.0.1/x", { initiator: "https://127.0.0.1:8443/y" })).toBe("st=1");
  });
});
