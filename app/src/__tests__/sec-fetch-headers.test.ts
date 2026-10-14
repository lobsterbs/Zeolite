import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forwardedHeaders } from "../request";
import { PROXY_INJECTED_HEADERS, applyChUa, secFetchHeaders } from "../origin";

/* 2026-10-14 report: Sec-Fetch headers are BUILT from the virtual
   facts, never copied from the engine request. The exact sets a real
   browser sends, including the first-navigation set that used to be
   silence. */

describe("secFetchHeaders", () => {
  it("first navigation without initiator: none/navigate/document/?1 + UIR", () => {
    const sf = secFetchHeaders(undefined, "https://target.example/", "GET", "navigate", "document");
    expect(sf).toEqual({
      site: "none",
      mode: "navigate",
      dest: "document",
      user: "?1",
      upgradeInsecureRequests: true,
    });
  });

  it("subframe navigation keeps its destination", () => {
    const sf = secFetchHeaders(undefined, "https://target.example/", "GET", "navigate", "iframe");
    expect(sf.dest).toBe("iframe");
    expect(sf.user).toBe("?1");
  });

  it("navigation with a cross-site initiator reports cross-site", () => {
    const sf = secFetchHeaders(
      "https://a.example/page",
      "https://b.example/",
      "GET",
      "navigate",
      "document",
    );
    expect(sf.site).toBe("cross-site");
    expect(sf.mode).toBe("navigate");
  });

  it("navigation with a same-origin initiator reports same-origin", () => {
    const sf = secFetchHeaders(
      "https://a.example/page",
      "https://a.example/other",
      "GET",
      "navigate",
      "document",
    );
    expect(sf.site).toBe("same-origin");
  });

  it("subresource: mode and destination from the request, site from the initiator", () => {
    const sf = secFetchHeaders("https://a.example/", "https://b.example/x", "GET", "cors", "");
    expect(sf).toEqual({ site: "cross-site", mode: "cors", dest: "empty" });
  });

  it("subresource with unknown initiator fails closed on site (no header)", () => {
    const sf = secFetchHeaders(null, "https://b.example/x", "GET", "no-cors", "script");
    expect(sf.site).toBeUndefined();
    expect(sf.mode).toBe("no-cors");
    expect(sf.dest).toBe("script");
    expect(sf.user).toBeUndefined();
    expect(sf.upgradeInsecureRequests).toBeUndefined();
  });

  it("worker destinations keep their destination", () => {
    const sf = secFetchHeaders("https://a.example/", "https://a.example/w.js", "GET", "same-origin", "worker");
    expect(sf.dest).toBe("worker");
  });
});

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CHROMIUM_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/124.0.0.0 Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0";

describe("applyChUa", () => {
  it("Chromium UA: brand list with matching major, mobile ?0, platform", () => {
    const h = new Headers();
    applyChUa(h, CHROME_WIN);
    expect(h.get("sec-ch-ua")).toContain('"Chromium";v="124"');
    expect(h.get("sec-ch-ua")).toContain('"Google Chrome";v="124"');
    expect(h.get("sec-ch-ua")).toContain("Not_A Brand");
    expect(h.get("sec-ch-ua-mobile")).toBe("?0");
    expect(h.get("sec-ch-ua-platform")).toBe('"Windows"');
  });

  it("Chromium-only UA: no Google Chrome brand", () => {
    const h = new Headers();
    applyChUa(h, CHROMIUM_LINUX);
    expect(h.get("sec-ch-ua")).toContain('"Chromium";v="124"');
    expect(h.get("sec-ch-ua")).not.toContain("Google Chrome");
    expect(h.get("sec-ch-ua-platform")).toBe('"Linux"');
  });

  it("Firefox UA: hints absent (a Chrome UA without hints is a bot signal; so is a Firefox UA with Chromium hints)", () => {
    const h = new Headers({ "sec-ch-ua": '"stale" ', "sec-ch-ua-mobile": "?1" });
    applyChUa(h, FIREFOX);
    expect(h.get("sec-ch-ua")).toBeNull();
    expect(h.get("sec-ch-ua-mobile")).toBeNull();
    expect(h.get("sec-ch-ua-platform")).toBeNull();
  });

  it("Android mobile UA reports mobile ?1", () => {
    const h = new Headers();
    applyChUa(
      h,
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    );
    expect(h.get("sec-ch-ua-mobile")).toBe("?1");
    expect(h.get("sec-ch-ua-platform")).toBe('"Android"');
  });
});


describe("forwardedHeaders strips proxy-injected hop headers (#160)", () => {
  /* forwardedHeaders resolves the virtual referrer against
     self.location.origin; the node test env has no self. */
  const prevSelf = (globalThis as Record<string, unknown>).self;
  beforeAll(() => {
    (globalThis as Record<string, unknown>).self = {
      location: { origin: "https://engine.example" },
    };
  });
  afterAll(() => {
    if (prevSelf === undefined) delete (globalThis as Record<string, unknown>).self;
    else (globalThis as Record<string, unknown>).self = prevSelf;
  });

  it("never forwards x-forwarded-* to the upstream", () => {
    const req = new Request("https://engine.example/__zl_navh__/x", {
      method: "GET",
      headers: {
        "x-forwarded-for": "10.0.0.1",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "engine.example",
        "x-forwarded-port": "443",
        "x-real-ip": "10.0.0.1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
    });
    const out = forwardedHeaders(req, "https://target.example/", undefined);
    for (const h of PROXY_INJECTED_HEADERS) {
      expect(out.get(h)).toBeNull();
    }
    /* Sec-Fetch is never copied from the engine request: the input's
       "same-origin" value must not survive, and with no initiator
       the rebuilt set for a cors request stays omitted. */
    expect(out.get("sec-fetch-site")).toBeNull();
    /* The rest of the client surface passes through. */
    expect(out.get("user-agent")).toContain("Chrome/");
  });
});
