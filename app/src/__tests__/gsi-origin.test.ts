import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualGsiOrigin } from "../request";

/* #483: only the verified page origin may replace GIS parameters that
   currently name the engine. No invented origin or OAuth bypass. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const PAGE = "https://shop.example/products?id=1";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const gis = (key: "origin" | "ss_domain", origin: string, path = "/gsi/iframe/select") =>
  "https://accounts.google.com" + path + "?client_id=test-client&" +
  key + "=" + encodeURIComponent(origin) + "&prompt=1";

describe("virtualGsiOrigin (#483)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("corrects the One Tap origin through an authenticated keyed route", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGsiOrigin(gis("origin", ENGINE), ref, ENGINE))
      .toBe(gis("origin", "https://shop.example"));
  });

  it.each([":443", ":80"])("corrects an explicit engine port %s", port => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGsiOrigin(gis("origin", ENGINE + port), ref, ENGINE))
      .toBe(gis("origin", "https://shop.example"));
  });

  it("handles the OAuth button ss_domain field and both fields in one request", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const button = gis("ss_domain", ENGINE, "/gsi/button");
    expect(virtualGsiOrigin(button, ref, ENGINE))
      .toBe(gis("ss_domain", "https://shop.example", "/gsi/button"));
    const both = gis("origin", ENGINE, "/gsi/select") + "&ss_domain=" + encodeURIComponent(ENGINE);
    const fixed = gis("origin", "https://shop.example", "/gsi/select") +
      "&ss_domain=" + encodeURIComponent("https://shop.example");
    expect(virtualGsiOrigin(both, ref, ENGINE)).toBe(fixed);
  });

  it("uses verified virtual initiator context even when referrer is absent", () => {
    const url = gis("origin", ENGINE);
    expect(virtualGsiOrigin(url, "", ENGINE, PAGE)).toBe(gis("origin", "https://shop.example"));
  });

  it("handles nav-handle and query-shape referrers", () => {
    setRouteKey(KEY);
    const handle = encodeNavHandle(PAGE)!;
    const nav = ENGINE + "/__zl_navh__/" + handle + "/products";
    expect(virtualGsiOrigin(gis("origin", ENGINE), nav, ENGINE))
      .toBe(gis("origin", "https://shop.example"));
    const query = buildQueryHandleUrl(PAGE);
    expect(query).not.toBeNull();
    expect(virtualGsiOrigin(gis("origin", ENGINE), ENGINE + query, ENGINE))
      .toBe(gis("origin", "https://shop.example"));
  });

  it("handles a legacy /zl/ referrer", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualGsiOrigin(gis("origin", ENGINE), ref, ENGINE))
      .toBe(gis("origin", "https://shop.example"));
  });

  it("keeps user-chosen origins, malformed values, and unverified context unchanged", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    for (const value of [
      gis("origin", "https://user-chosen.example"),
      gis("origin", ENGINE).replace(encodeURIComponent(ENGINE), "%GG"),
      gis("ss_domain", "https://different.example"),
    ]) expect(virtualGsiOrigin(value, ref, ENGINE)).toBe(value);
    const unknown = gis("origin", ENGINE);
    expect(virtualGsiOrigin(unknown, "", ENGINE)).toBe(unknown);
    expect(virtualGsiOrigin(unknown, ENGINE + "/zl/invalid!!", ENGINE)).toBe(unknown);
  });

  it("only changes engine-origin values when a request mixes unrelated fields", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const url = gis("origin", "https://registered.example") + "&ss_domain=" + encodeURIComponent(ENGINE);
    expect(virtualGsiOrigin(url, ref, ENGINE))
      .toBe(gis("origin", "https://registered.example") + "&ss_domain=" + encodeURIComponent("https://shop.example"));
  });

  it("does not alter other hosts, other paths, or fragment values", () => {
    const ref = PAGE;
    const input = gis("origin", ENGINE);
    for (const url of [
      input.replace("accounts.google.com", "accounts.google.com.attacker.example"),
      input.replace("accounts.google.com", "www.google.com"),
      input.replace("/gsi/iframe/select", "/gsiOther/iframe/select"),
      input.replace("/gsi/iframe/select", "/oauth2/authorize"),
      input.replace("/gsi/iframe/select", "/gsi"),
      "https://accounts.google.com/gsi/button#origin=" + encodeURIComponent(ENGINE),
      "not a url",
    ]) expect(virtualGsiOrigin(url, ref, ENGINE, PAGE)).toBe(url);
  });
});
