import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import {
  isCaptchafoxChallengeUrl,
  virtualCaptchafoxChallengeBody,
  virtualCaptchafoxSite,
} from "../request";

/* The CaptchaFox site= seam (#672, the #112 co= class): the widget
   loader builds site= from window.location.origin plus
   window.location.pathname, so a virtualized page names the engine
   route and the config endpoint answers 402 site-not-allowed. The
   helpers pin the issue's URL shape:
   api.captchafox.com/captcha/<sitekey>/config?site=<page URL>. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const config = (site: string) =>
  "https://api.captchafox.com/captcha/sk_fixture0000000000000000/config?site=" +
  encodeURIComponent(site);
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://shop.example/account?next=%2Fmail&x=1";
const HOST = "shop.example";

describe("virtualCaptchafoxSite (#672 captchafox class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites a site= naming the engine route to the page url", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualCaptchafoxSite(config(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(config(PAGE));
  });

  it("rewrites the explicit-port engine origin form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualCaptchafoxSite(config(ENGINE + ":443" + encodeDest(PAGE)), ref, ENGINE)).toBe(config(PAGE));
  });

  it("leaves a site= naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = config("https://widget.example.net/page");
    expect(virtualCaptchafoxSite(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-captchafox hosts and non-config paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const other = "https://api.example.net/captcha/sk_x/config?site=" + encodeURIComponent(ENGINE + encodeDest(PAGE));
    expect(virtualCaptchafoxSite(other, ref, ENGINE)).toBe(other);
    const challenge = "https://api.captchafox.com/captcha/sk_x/challenge?site=" + encodeURIComponent(ENGINE + encodeDest(PAGE));
    expect(virtualCaptchafoxSite(challenge, ref, ENGINE)).toBe(challenge);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/account?next=%2Fmail&x=1";
    expect(virtualCaptchafoxSite(config(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(config(PAGE));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualCaptchafoxSite(config(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(config(PAGE));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualCaptchafoxSite(config(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(config(PAGE));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    setRouteKey(KEY);
    const inUrl = config(ENGINE + encodeDest(PAGE));
    expect(virtualCaptchafoxSite(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualCaptchafoxSite(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("rewrites through the initiator context when given", () => {
    setRouteKey(KEY);
    expect(virtualCaptchafoxSite(config(ENGINE + encodeDest(PAGE)), "", ENGINE, PAGE)).toBe(config(PAGE));
  });
});

describe("virtualCaptchafoxChallengeBody (#672 body seam)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(KEY);
  });

  it("classifies only the challenge path as the body seam", () => {
    expect(isCaptchafoxChallengeUrl("https://api.captchafox.com/captcha/sk_x/challenge")).toBe(true);
    expect(isCaptchafoxChallengeUrl("https://api.captchafox.com/captcha/sk_x/config")).toBe(false);
    expect(isCaptchafoxChallengeUrl("https://api.example.net/captcha/sk_x/challenge")).toBe(false);
    expect(isCaptchafoxChallengeUrl("https://api.captchafox.com/captcha/sk_x/challenge/extra")).toBe(false);
  });

  it("repairs an engine host in a JSON body", () => {
    const ref = ENGINE + encodeDest(PAGE);
    const body = JSON.stringify({ sitekey: "sk_x", host: "lobsterbrowse-beta.onrender.com", v: 2 });
    const want = JSON.stringify({ sitekey: "sk_x", host: HOST, v: 2 });
    expect(virtualCaptchafoxChallengeBody(body, ref, ENGINE)).toBe(want);
  });

  it("leaves a JSON host the page genuinely chose alone", () => {
    const ref = ENGINE + encodeDest(PAGE);
    const body = JSON.stringify({ sitekey: "sk_x", host: "other.example" });
    expect(virtualCaptchafoxChallengeBody(body, ref, ENGINE)).toBe(body);
  });

  it("leaves malformed JSON alone", () => {
    const ref = ENGINE + encodeDest(PAGE);
    const body = "{not json";
    expect(virtualCaptchafoxChallengeBody(body, ref, ENGINE)).toBe(body);
  });

  it("repairs an engine host in a urlencoded body", () => {
    const ref = ENGINE + encodeDest(PAGE);
    const body = "sitekey=sk_x&host=lobsterbrowse-beta.onrender.com&v=2";
    expect(virtualCaptchafoxChallengeBody(body, ref, ENGINE)).toBe(
      "sitekey=sk_x&host=" + encodeURIComponent(HOST) + "&v=2",
    );
  });

  it("passes through when the referrer never decodes", () => {
    const body = JSON.stringify({ sitekey: "sk_x", host: "lobsterbrowse-beta.onrender.com" });
    expect(virtualCaptchafoxChallengeBody(body, ENGINE + "/zl/garbage!!", ENGINE)).toBe(body);
    expect(virtualCaptchafoxChallengeBody(body, "", ENGINE)).toBe(body);
  });
});
