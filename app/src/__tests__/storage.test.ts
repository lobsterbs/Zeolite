import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOpaqueUrl } from "../codec";
import {
  cookiesResetForTests,
  documentCookieRead,
  documentCookieWrite,
} from "../cookies";

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

describe("opaque URL passthrough (1.5)", () => {
  it("treats blob, data and about as browser-native", () => {
    expect(isOpaqueUrl(new URL("blob:https://engine.example/uuid"))).toBe(true);
    expect(isOpaqueUrl(new URL("data:text/plain,hi"))).toBe(true);
    expect(isOpaqueUrl(new URL("about:blank"))).toBe(true);
  });

  it("routes http and https through the engine", () => {
    expect(isOpaqueUrl(new URL("https://example.com/"))).toBe(false);
    expect(isOpaqueUrl(new URL("http://example.com/"))).toBe(false);
  });
});

describe("document.cookie virtualization (1.5)", () => {
  it("round-trips name=value through the jar", () => {
    const r = documentCookieWrite("https://a.example/x/y", "sid=1");
    expect(r.stored).toBe(true);
    expect(documentCookieRead("https://a.example/other")).toBe("sid=1");
  });

  it("ignores the HttpOnly attribute on script writes", () => {
    documentCookieWrite("https://a.example/", "x=2; HttpOnly");
    expect(documentCookieRead("https://a.example/")).toBe("x=2");
  });

  it("shows every origin cookie regardless of path", () => {
    documentCookieWrite("https://a.example/deep/dir/page", "p=3; Path=/deep/dir");
    expect(documentCookieRead("https://a.example/elsewhere")).toBe("p=3");
  });

  it("deletes via max-age=0", () => {
    documentCookieWrite("https://a.example/", "d=1");
    const r = documentCookieWrite("https://a.example/", "d=1; Max-Age=0");
    expect(r.deleted).toBe(true);
    expect(documentCookieRead("https://a.example/")).toBe("");
  });

  it("isolates virtual origins", () => {
    documentCookieWrite("https://a.example/", "a=1");
    documentCookieWrite("https://b.example/", "b=2");
    expect(documentCookieRead("https://a.example/")).toBe("a=1");
    expect(documentCookieRead("https://b.example/")).toBe("b=2");
  });

  it("hides Secure cookies from insecure documents", () => {
    documentCookieWrite("https://a.example/", "s=1; Secure");
    expect(documentCookieRead("https://a.example/")).toBe("s=1");
    expect(documentCookieRead("http://a.example/")).toBe("");
  });

  it("attaches Domain cookies to subdomains only inside their jar", () => {
    documentCookieWrite("https://a.example/", "k=1; Domain=a.example");
    expect(documentCookieRead("https://sub.a.example/")).toBe("k=1");
    expect(documentCookieRead("https://b.example/")).toBe("");
  });

  it("never admits a cookie for a foreign domain", () => {
    const r = documentCookieWrite("https://a.example/", "e=1; Domain=evil.com");
    expect(r.stored).toBe(false);
    expect(r.rejected).toBe("domain");
    expect(documentCookieRead("https://a.example/")).toBe("");
  });
});
