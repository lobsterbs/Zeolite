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

/* The Google Identity Services origin=/ss_domain= seam (#483, the
   #112 co= class): page JS builds the value from
   window.location.origin (LegacyUnforgeable), so Google's
   client/origin validation sees the engine origin and the One Tap
   prompt never renders. Pass-through cases first; the referrer
   cases below pin every route family the engine serves documents
   from. Mirrors ogs-origin.test.ts. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const oneTap = (origin: string) =>
  "https://accounts.google.com/gsi/iframe/select?itmul=1&origin=" +
  encodeURIComponent(origin) + "&as=SLHf&hl=en";
const button = (ssDomain: string) =>
  "https://accounts.google.com/gsi/button?theme=outline&client_id=abc.apps.googleusercontent.com&iframe_id=gsi_1&ss_domain=" +
  encodeURIComponent(ssDomain);
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://www.example.com/login";

describe("virtualGsiOrigin (#483 gsi class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites an origin= that names the engine origin to the page origin", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGsiOrigin(oneTap(ENGINE), ref, ENGINE))
      .toBe(oneTap("https://www.example.com"));
  });

  it("rewrites the explicit-port engine origin forms too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGsiOrigin(oneTap(ENGINE + ":443"), ref, ENGINE))
      .toBe(oneTap("https://www.example.com"));
    expect(virtualGsiOrigin(oneTap(ENGINE + ":80"), ref, ENGINE))
      .toBe(oneTap("https://www.example.com"));
  });

  it("rewrites the ss_domain= oauth2 button form", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGsiOrigin(button(ENGINE), ref, ENGINE))
      .toBe(button("https://www.example.com"));
  });

  it("leaves a value naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = oneTap("https://other.example");
    expect(virtualGsiOrigin(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-gsi hosts and non-gsi paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const serp = "https://www.google.com/search?q=hi&origin=" + encodeURIComponent(ENGINE);
    expect(virtualGsiOrigin(serp, ref, ENGINE)).toBe(serp);
    const other = "https://accounts.google.com/o/oauth2/auth?origin=" + encodeURIComponent(ENGINE);
    expect(virtualGsiOrigin(other, ref, ENGINE)).toBe(other);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/login";
    expect(virtualGsiOrigin(oneTap(ENGINE), ref, ENGINE))
      .toBe(oneTap("https://www.example.com"));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualGsiOrigin(oneTap(ENGINE), ref, ENGINE))
      .toBe(oneTap("https://www.example.com"));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualGsiOrigin(oneTap(ENGINE), ref, ENGINE))
      .toBe(oneTap("https://www.example.com"));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    const inUrl = oneTap(ENGINE);
    expect(virtualGsiOrigin(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualGsiOrigin(inUrl, "", ENGINE)).toBe(inUrl);
  });
});
