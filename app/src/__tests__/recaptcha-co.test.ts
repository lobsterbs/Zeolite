import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualRecaptchaCo } from "../request";

/* #112: the recaptcha co= seam. Pure logic only for the no-referrer
   cases; the decode-chain describe below pins the referrer paths. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const b64 = (s: string) => btoa(s).replace(/=+$/, (p) => ".".repeat(p.length));
const anchor = (co: string) =>
  "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=KEY&co=" + co + "&hl=en&v=V";

describe("virtualRecaptchaCo (#112)", () => {
  it("does not invent a page origin without a referrer or client context (#436)", () => {
    const input = anchor(b64(ENGINE + ":443"));
    expect(virtualRecaptchaCo(input, "", ENGINE)).toBe(input);
  });

  it("uses known client context for the bare engine origin form", () => {
    expect(virtualRecaptchaCo(anchor(b64(ENGINE)), "", ENGINE, "https://shop.example/login"))
      .toBe(anchor(b64("https://shop.example:443")));
  });

  it("leaves a co= naming another origin alone", () => {
    const inUrl = anchor(b64("https://example.com:443"));
    expect(virtualRecaptchaCo(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("leaves non-recaptcha hosts, paths and co-less queries alone", () => {
    expect(virtualRecaptchaCo("https://www.google.com/search?q=hi&co=x", "", ENGINE))
      .toBe("https://www.google.com/search?q=hi&co=x");
    expect(virtualRecaptchaCo("https://example.com/recaptcha/enterprise/anchor?ar=1", "", ENGINE))
      .toBe("https://example.com/recaptcha/enterprise/anchor?ar=1");
  });
});

/* #113 follow-up: the page origin must survive every route family the
   engine serves documents from (keyed route, nav handle, legacy /zl/
   cold start), or co= flips between origins across loads and the
   site-key domain check becomes load-dependent. */
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://www.google.com/search?q=x";

describe("virtualRecaptchaCo referrer decode (#113)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites co= through a keyed engine-route referrer", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualRecaptchaCo(anchor(b64(ENGINE + ":443")), ref, ENGINE))
      .toBe(anchor(b64("https://www.google.com:443")));
  });

  it("rewrites co= through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/wiki/Page";
    expect(virtualRecaptchaCo(anchor(b64(ENGINE + ":443")), ref, ENGINE))
      .toBe(anchor(b64("https://www.google.com:443")));
  });

  it("rewrites co= through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualRecaptchaCo(anchor(b64(ENGINE + ":443")), ref, ENGINE))
      .toBe(anchor(b64("https://www.google.com:443")));
  });

  it("keeps unknown embedding identity unchanged when the referrer does not decode", () => {
    const input = anchor(b64(ENGINE + ":443"));
    expect(virtualRecaptchaCo(input, ENGINE + "/zl/garbage!!", ENGINE)).toBe(input);
  });
});
