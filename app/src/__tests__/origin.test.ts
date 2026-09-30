import { describe, expect, it } from "vitest";
import { senderVirtualOrigin, virtualOriginHeaders } from "../origin";
import { encodeDest, setScheme } from "../codec";

describe("virtualOriginHeaders (issue #23: upstream Origin / Sec-Fetch-Site)", () => {
  const PAGE = "https://chatgpt.com/";
  const API = "https://chatgpt.com/backend-api/consent";

  it("synthesizes the page origin on a same-origin POST", () => {
    expect(virtualOriginHeaders(PAGE, API, "POST", "same-origin")).toEqual({
      origin: "https://chatgpt.com",
      secFetchSite: "same-origin",
    });
  });

  it("sends no Origin on a same-origin GET", () => {
    expect(virtualOriginHeaders(PAGE, API, "GET", "same-origin")).toEqual({ secFetchSite: "same-origin" });
  });

  it("cross-origin CORS GET carries the initiator origin and cross-site", () => {
    expect(virtualOriginHeaders(PAGE, "https://cdn.other/lib.js", "GET", "cors")).toEqual({
      origin: "https://chatgpt.com",
      secFetchSite: "cross-site",
    });
  });

  it("cross-origin no-cors GET carries no Origin", () => {
    expect(virtualOriginHeaders(PAGE, "https://cdn.other/lib.js", "GET", "no-cors")).toEqual({
      secFetchSite: "cross-site",
    });
  });

  it("cross-origin no-cors POST (form) carries the initiator origin", () => {
    expect(virtualOriginHeaders("https://a.site/x", "https://b.other/y", "POST", "no-cors")).toEqual({
      origin: "https://a.site",
      secFetchSite: "cross-site",
    });
  });

  it("sibling subdomains are same-site", () => {
    expect(virtualOriginHeaders("https://a.site/x", "https://b.a.site/y", "GET", "no-cors")).toEqual({
      secFetchSite: "same-site",
    });
  });

  it("unknown initiator fails closed: no headers at all", () => {
    expect(virtualOriginHeaders(undefined, API, "POST", "cors")).toEqual({});
    expect(virtualOriginHeaders(null, API, "POST", "cors")).toEqual({});
    expect(virtualOriginHeaders("", API, "POST", "cors")).toEqual({});
  });

  it("unparseable or non-http targets fail closed", () => {
    expect(virtualOriginHeaders(PAGE, "not a url", "POST", "same-origin")).toEqual({});
    expect(virtualOriginHeaders(PAGE, "data:text/plain,hi", "GET", "cors")).toEqual({});
  });

  it("non-http initiator fails closed", () => {
    expect(virtualOriginHeaders("blob:https://engine.host/x", API, "POST", "same-origin")).toEqual({});
  });
});

describe("senderVirtualOrigin (bug-scout: control-message sender verification)", () => {
  const ENGINE = "https://engine.host";

  it("recovers the sender's virtual origin from its client route", () => {
    setScheme("/zl/", "b64u");
    const route = "https://engine.host" + encodeDest("https://example.com/page");
    expect(senderVirtualOrigin(route, ENGINE)).toBe("https://example.com");
  });

  it("ignores the query tail of a client route", () => {
    setScheme("/zl/", "b64u");
    const route = "https://engine.host" + encodeDest("https://example.com/page") + "?x=1";
    expect(senderVirtualOrigin(route, ENGINE)).toBe("https://example.com");
  });

  it("fails closed without a client URL", () => {
    setScheme("/zl/", "b64u");
    expect(senderVirtualOrigin(undefined, ENGINE)).toBeNull();
    expect(senderVirtualOrigin(null, ENGINE)).toBeNull();
    expect(senderVirtualOrigin("", ENGINE)).toBeNull();
  });

  it("fails closed for a client outside the engine routes", () => {
    setScheme("/zl/", "b64u");
    expect(senderVirtualOrigin("https://engine.host/", ENGINE)).toBeNull();
    expect(senderVirtualOrigin("https://engine.host/devtools.html", ENGINE)).toBeNull();
  });

  it("fails closed for a foreign-origin sender", () => {
    setScheme("/zl/", "b64u");
    const route = "https://evil.example" + encodeDest("https://example.com/page");
    expect(senderVirtualOrigin(route, ENGINE)).toBeNull();
  });

  it("fails closed when the route does not decode to an http(s) destination", () => {
    setScheme("/zl/", "b64u");
    const route = "https://engine.host" + encodeDest("data:text/plain,hi");
    expect(senderVirtualOrigin(route, ENGINE)).toBeNull();
  });
});
