import { describe, expect, it, beforeEach } from "vitest";
import { setScheme, encodeDestLegacy, decodePath } from "../codec";
import {
  destUpgraded,
  httpExemptAdd,
  httpExemptHas,
  isHttpsUpgrade,
  setHttpsUpgrade,
} from "../swstate";
import { httpProceedHref } from "../request";

/* LB #76 HTTPS-only: on by default, one proceed-anyway escape per
   cleartext host through the error-page link, session-scoped in
   the worker (never persisted). */

beforeEach(() => {
  setScheme("/j/");
  setHttpsUpgrade(true);
});

describe("HTTPS-only state (LB #76)", () => {
  it("defaults on", () => {
    expect(isHttpsUpgrade()).toBe(true);
  });

  it("upgrades cleartext destinations while the toggle is on", () => {
    expect(destUpgraded("http://example.com/a")).toBe("https://example.com/a");
    expect(destUpgraded("https://example.com/a")).toBe("https://example.com/a");
  });

  it("respects the host toggle off", () => {
    setHttpsUpgrade(false);
    expect(destUpgraded("http://example.com/a")).toBe("http://example.com/a");
  });

  it("keeps an exempted host on cleartext for the session", () => {
    httpExemptAdd("https://plain.example/x");
    expect(httpExemptHas("http://plain.example/y")).toBe(true);
    expect(httpExemptHas("http://sub.plain.example/y")).toBe(true);
    expect(httpExemptHas("http://other.example/")).toBe(false);
    expect(destUpgraded("http://plain.example/y")).toBe("http://plain.example/y");
    expect(destUpgraded("http://other.example/")).toBe("https://other.example/");
  });
});

describe("proceed-anyway link (LB #76)", () => {
  it("builds the zlHttpOk reload link for a cleartext engine route", () => {
    const enc = encodeDestLegacy("http://proceed.example/page");
    const href = httpProceedHref(new URL(enc, "https://w.example.org"));
    expect(href).toBe(enc + "?zlHttpOk=1");
  });

  it("carries an existing query and drops nothing else", () => {
    const enc = encodeDestLegacy("http://proceed.example/page");
    const href = httpProceedHref(new URL(enc + "?a=1", "https://w.example.org"));
    expect(href).toBe(enc + "?a=1&zlHttpOk=1");
  });

  it("offers nothing once the host is exempt, for https routes, or off", () => {
    const enc = encodeDestLegacy("http://proceed.example/page");
    httpExemptAdd("http://proceed.example/page");
    expect(httpProceedHref(new URL(enc, "https://w.example.org"))).toBeNull();
    const encS = encodeDestLegacy("https://proceed.example/page");
    expect(httpProceedHref(new URL(encS, "https://w.example.org"))).toBeNull();
    setHttpsUpgrade(false);
    expect(httpProceedHref(new URL(enc, "https://w.example.org"))).toBeNull();
  });
});

describe("loopback is never upgraded (HTTPS-only default vs local harnesses)", () => {
  it("potentially-trustworthy hosts stay http even with the toggle on", () => {
    for (const d of [
      "http://127.0.0.1:7101/dir/page.html",
      "http://localhost:6002/?url=x",
      "http://sub.localhost/a",
      "http://[::1]:8080/x",
    ]) {
      expect(destUpgraded(d)).toBe(d);
    }
  });

  it("remote http hosts still upgrade", () => {
    expect(destUpgraded("http://example.com/a")).toBe("https://example.com/a");
  });
});
