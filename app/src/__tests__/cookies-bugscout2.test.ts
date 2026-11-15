/* Cookie-jar bug-scout #2 (#614 family): five defects found by a
   second spec sweep against RFC 6265 5.1.1 and RFC 6265bis
   (draft-ietf-httpbis-rfc6265bis, storage model + attribute steps).
   Each pin asserts the spec behavior; the fix rides the same PR. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySetCookie,
  parseCookieDate,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieRead,
  jarSnapshot,
} from "../cookies";

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

/** bis 5.6 Expires/Max-Age steps 3-6 + Cookie Lifetime Limits: a
    lifetime longer than 400 days (34560000 seconds) MUST be reduced
    to the limit. Chrome caps at 400 days since M104. */
const AGE_LIMIT_MS = 34560000 * 1000;

function expectCapped(expires: number, before: number): void {
  expect(expires).toBeGreaterThanOrEqual(before + AGE_LIMIT_MS);
  expect(expires).toBeLessThanOrEqual(Date.now() + AGE_LIMIT_MS + 2000);
}

describe("bugscout2: 5.1.1 year windowing applies to the year-value (RFC 6265 5.1.1 steps 3-4)", () => {
  it("zero-padded 3- and 4-digit years window like 2-digit ones", () => {
    /* The windowing rules speak of the year-VALUE, not the token
       length: 69 -> 2069 and 70 -> 1970 regardless of digits. */
    expect(parseCookieDate("Wed, 09 Jun 069 10:18:14 GMT")).toBe(Date.UTC(2069, 5, 9, 10, 18, 14));
    expect(parseCookieDate("Wed, 09 Jun 0069 10:18:14 GMT")).toBe(Date.UTC(2069, 5, 9, 10, 18, 14));
    expect(parseCookieDate("Thu, 01 Jan 0070 00:00:00 GMT")).toBe(Date.UTC(1970, 0, 1));
    expect(parseCookieDate("Wed, 09 Jun 0099 10:18:14 GMT")).toBe(Date.UTC(1999, 5, 9, 10, 18, 14));
  });

  it("non-padded years outside the window fail closed (unchanged)", () => {
    expect(parseCookieDate("Wed, 09 Jun 999 10:18:14 GMT")).toBeNull();
    expect(parseCookieDate("Wed, 09 Jun 1500 10:18:14 GMT")).toBeNull();
    /* day-of-month out of range fails the whole date (5.1.1 step 5) */
    expect(parseCookieDate("Sun, 32 Jun 2021 10:18:14 GMT")).toBeNull();
    expect(parseCookieDate("Sun, 99 Jun 2021 10:18:14 GMT")).toBeNull();
    /* leap seconds cannot be represented */
    expect(parseCookieDate("Wed, 09 Jun 2021 10:18:60 GMT")).toBeNull();
  });
});

describe("bugscout2: Domain=. degrades to host-only (bis 5.6 steps 7+10)", () => {
  it("a Domain value that is empty after the leading-dot strip is ignored", () => {
    /* bis: cookie-domain = attribute-value minus ONE leading dot; an
       empty domain-attribute keeps host-only-flag true. The old TS
       body minted a PARENT-SCOPED domain cookie instead: every
       subdomain of the setter received it. */
    const r = applySetCookie("https://accounts.example.com/", resp(["k=1; Domain=."]));
    expect(r[0].stored).toBe(true);
    const list = [...jarSnapshot().values()][0];
    expect(list[0].hostOnly).toBe(true);
    expect(list[0].domain).toBe("accounts.example.com");
    expect(cookieHeaderFor("https://accounts.example.com/")).toBe("k=1");
    /* the leak: a sibling subdomain must never see it */
    expect(cookieHeaderFor("https://x.accounts.example.com/")).toBeNull();
    expect(documentCookieRead("https://x.accounts.example.com/")).toBe("");
  });

  it("a multi-dot Domain still fails the domain gate (unchanged)", () => {
    const r = applySetCookie("https://accounts.example.com/", resp(["k=1; Domain=.."]));
    expect(r[0].stored).toBe(false);
    expect(r[0].rejected).toBe("domain");
  });
});

describe("bugscout2: 400-day lifetime cap (bis Cookie Lifetime Limits + Expires/Max-Age steps)", () => {
  it("caps a huge Max-Age", () => {
    const before = Date.now();
    const r = applySetCookie("https://a.example/", resp(["k=1; Max-Age=34600000"]));
    expect(r[0].stored).toBe(true);
    expectCapped(r[0].cookie!.expires, before);
  });

  it("caps an absurd Max-Age to a finite expiry (the TS arm minted Infinity)", () => {
    const before = Date.now();
    const r = applySetCookie("https://a.example/", resp(["k=1; Max-Age=" + "9".repeat(320)]));
    expect(r[0].stored).toBe(true);
    expect(Number.isFinite(r[0].cookie!.expires)).toBe(true);
    expectCapped(r[0].cookie!.expires, before);
  });

  it("caps a far-future Expires", () => {
    const before = Date.now();
    const r = applySetCookie("https://a.example/", resp(["k=1; Expires=Wed, 09 Jun 9999 10:18:14 GMT"]));
    expect(r[0].stored).toBe(true);
    expectCapped(r[0].cookie!.expires, before);
  });

  it("leaves an under-cap Max-Age untouched (unchanged)", () => {
    const before = Date.now();
    const r = applySetCookie("https://a.example/", resp(["k=1; Max-Age=34559999"]));
    expect(r[0].stored).toBe(true);
    expect(r[0].cookie!.expires).toBeGreaterThanOrEqual(before + 34559999 * 1000 - 2000);
    expect(r[0].cookie!.expires).toBeLessThan(before + AGE_LIMIT_MS);
  });

  it("never caps deletions (unchanged)", () => {
    applySetCookie("https://a.example/", resp(["k=1"]));
    const r = applySetCookie("https://a.example/", resp(["k=1; Max-Age=0"]));
    expect(r[0].deleted).toBe(true);
  });
});

describe("bugscout2: leave secure cookies alone (bis 5.6 step 16)", () => {
  it("http cannot overwrite a Secure cookie of the same name", () => {
    applySetCookie("https://example.com/", resp(["sid=1; Secure; Path=/"]));
    const r = applySetCookie("http://example.com/", resp(["sid=2; Path=/"]));
    expect(r[0].stored).toBe(false);
    expect(r[0].rejected).toBeTruthy();
    expect(cookieHeaderFor("https://example.com/")).toBe("sid=1");
  });

  it("http cannot delete a Secure cookie either (the received cookie aborts)", () => {
    applySetCookie("https://example.com/", resp(["sid=1; Secure; Path=/"]));
    const r = applySetCookie("http://example.com/", resp(["sid=1; Path=/; Max-Age=0"]));
    expect(r[0].stored).toBe(false);
    expect(r[0].deleted).toBe(false);
    expect(cookieHeaderFor("https://example.com/")).toBe("sid=1");
  });

  it("the domain comparison runs both directions across the domain chain", () => {
    applySetCookie("https://sub.example.com/", resp(["sid=1; Secure; Domain=example.com; Path=/"]));
    const r = applySetCookie("http://other.example.com/", resp(["sid=2; Domain=example.com; Path=/"]));
    expect(r[0].stored).toBe(false);
    expect(cookieHeaderFor("https://sub.example.com/")).toBe("sid=1");
  });

  it("blocks when the new path path-matches the secure cookie's path", () => {
    applySetCookie("https://example.com/", resp(["tok=1; Secure; Path=/"]));
    const r = applySetCookie("http://example.com/", resp(["tok=2; Path=/deep"]));
    expect(r[0].stored).toBe(false);
  });

  it("allows a non-overlapping narrower scope (unchanged)", () => {
    applySetCookie("https://example.com/", resp(["tok=1; Secure; Path=/deep"]));
    const r = applySetCookie("http://example.com/", resp(["tok=2; Path=/"]));
    expect(r[0].stored).toBe(true);
  });

  it("https writers keep full power (step 16 needs a non-secure request-uri)", () => {
    applySetCookie("https://example.com/", resp(["sid=1; Secure; Path=/"]));
    const r = applySetCookie("https://example.com/", resp(["sid=2; Path=/"]));
    expect(r[0].stored).toBe(true);
    expect(cookieHeaderFor("https://example.com/")).toBe("sid=2");
  });
});

describe("bugscout2: a public-suffix Domain equal to the host degrades to host-only (bis 5.6 step 9)", () => {
  it("Domain=github.io on the github.io host stores host-only", () => {
    const r = applySetCookie("https://github.io/", resp(["k=1; Domain=github.io"]));
    expect(r[0].stored).toBe(true);
    const list = [...jarSnapshot().values()][0];
    expect(list[0].hostOnly).toBe(true);
    expect(cookieHeaderFor("https://github.io/")).toBe("k=1");
  });

  it("still refuses a public-suffix Domain from a subdomain (unchanged)", () => {
    const r = applySetCookie("https://sub.github.io/", resp(["k=1; Domain=github.io"]));
    expect(r[0].stored).toBe(false);
    expect(r[0].rejected).toBe("domain");
  });
});
