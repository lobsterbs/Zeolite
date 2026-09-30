import { describe, expect, it } from "vitest";
import { virtualOriginHeaders } from "../origin";

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
