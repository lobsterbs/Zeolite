import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualHcaptchaHost } from "../request";

/* The hCaptcha host= seam (#112 co= class, #433): the SDK builds
   host= from window.location.hostname (LegacyUnforgeable), so a
   virtualized page names the engine host and hCaptcha's sitekey
   hostname validation rejects every widget render. Pass-through
   cases first; the referrer arms below pin every route family the
   engine serves documents from. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const frame = (host: string) =>
  "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html?frame=iframe&render=explicit&host=" +
  encodeURIComponent(host) + "&sitekey=10000000-ffff-ffff-ffff-000000000001&hl=en";
const config = (host: string) =>
  "https://api.hcaptcha.com/checksiteconfig?v=1&host=" +
  encodeURIComponent(host) + "&sitekey=10000000-ffff-ffff-ffff-000000000001&sc=1&swa=1&spst=0";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://www.google.com/search?q=x";

describe("virtualHcaptchaHost (#433 hcaptcha class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites a frame host= that names the engine host to the page hostname", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualHcaptchaHost(frame(ENGINE), ref, ENGINE))
      .toBe(frame("www.google.com"));
  });

  it("rewrites the checksiteconfig endpoint too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualHcaptchaHost(config(ENGINE), ref, ENGINE))
      .toBe(config("www.google.com"));
  });

  it("rewrites the explicit-port engine form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualHcaptchaHost(frame(ENGINE + ":443"), ref, ENGINE))
      .toBe(frame("www.google.com"));
  });

  it("leaves a host= naming another host alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = frame("example.com");
    expect(virtualHcaptchaHost(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-hcaptcha hosts and non-widget paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const serp = "https://www.google.com/search?q=hi&host=" + encodeURIComponent(ENGINE);
    expect(virtualHcaptchaHost(serp, ref, ENGINE)).toBe(serp);
    const other = "https://api.hcaptcha.com/other?host=" + encodeURIComponent(ENGINE);
    expect(virtualHcaptchaHost(other, ref, ENGINE)).toBe(other);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/search";
    expect(virtualHcaptchaHost(frame(ENGINE), ref, ENGINE))
      .toBe(frame("www.google.com"));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualHcaptchaHost(frame(ENGINE), ref, ENGINE))
      .toBe(frame("www.google.com"));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualHcaptchaHost(frame(ENGINE), ref, ENGINE))
      .toBe(frame("www.google.com"));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    const inUrl = frame(ENGINE);
    expect(virtualHcaptchaHost(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualHcaptchaHost(inUrl, "", ENGINE)).toBe(inUrl);
  });
});
