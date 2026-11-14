import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualGoogleFrameOrigin } from "../request";

/* #653/#654: only the verified page origin may replace a payframe /
   iframerpc origin= that currently names the engine. No invented
   origin or registration bypass. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const PAGE = "https://shop.example/products?id=1";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const payframe = (origin: string) =>
  "https://pay.google.com/gp/p/ui/payframe?origin=" + encodeURIComponent(origin) + "&mid=ABC123";
const iframerpc = (origin: string) =>
  "https://accounts.google.com/o/oauth2/iframerpc?action=checkOrigin&client_id=test-client" +
  "&origin=" + encodeURIComponent(origin) + "&login_hint=x";

describe("virtualGoogleFrameOrigin (#653/#654)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("corrects the Google Pay payframe origin through an authenticated keyed route", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGoogleFrameOrigin(payframe(ENGINE), ref, ENGINE))
      .toBe(payframe("https://shop.example"));
  });

  it("corrects the OAuth iframerpc origin through an authenticated keyed route", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGoogleFrameOrigin(iframerpc(ENGINE), ref, ENGINE))
      .toBe(iframerpc("https://shop.example"));
  });

  it.each([":443", ":80"])("corrects an explicit engine port %s on both endpoints", port => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGoogleFrameOrigin(payframe(ENGINE + port), ref, ENGINE))
      .toBe(payframe("https://shop.example"));
    expect(virtualGoogleFrameOrigin(iframerpc(ENGINE + port), ref, ENGINE))
      .toBe(iframerpc("https://shop.example"));
  });

  it("keeps mid=, client_id= and action= untouched while repairing origin=", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const fixedPay = virtualGoogleFrameOrigin(payframe(ENGINE), ref, ENGINE);
    expect(fixedPay).toContain("mid=ABC123");
    const fixedRpc = virtualGoogleFrameOrigin(iframerpc(ENGINE), ref, ENGINE);
    expect(fixedRpc).toContain("action=checkOrigin");
    expect(fixedRpc).toContain("client_id=test-client");
    expect(fixedRpc).toContain("login_hint=x");
  });

  it("uses verified virtual initiator context even when referrer is absent", () => {
    expect(virtualGoogleFrameOrigin(payframe(ENGINE), "", ENGINE, PAGE))
      .toBe(payframe("https://shop.example"));
    expect(virtualGoogleFrameOrigin(iframerpc(ENGINE), "", ENGINE, PAGE))
      .toBe(iframerpc("https://shop.example"));
  });

  it("handles nav-handle and query-shape referrers on both endpoints", () => {
    setRouteKey(KEY);
    const handle = encodeNavHandle(PAGE)!;
    const nav = ENGINE + "/__zl_navh__/" + handle + "/products";
    expect(virtualGoogleFrameOrigin(payframe(ENGINE), nav, ENGINE))
      .toBe(payframe("https://shop.example"));
    const query = buildQueryHandleUrl(PAGE);
    expect(query).not.toBeNull();
    expect(virtualGoogleFrameOrigin(iframerpc(ENGINE), ENGINE + query!, ENGINE))
      .toBe(iframerpc("https://shop.example"));
  });

  it("handles a legacy /zl/ referrer on both endpoints", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualGoogleFrameOrigin(payframe(ENGINE), ref, ENGINE))
      .toBe(payframe("https://shop.example"));
    expect(virtualGoogleFrameOrigin(iframerpc(ENGINE), ref, ENGINE))
      .toBe(iframerpc("https://shop.example"));
  });

  it("keeps user-chosen origins, malformed values, and unverified context unchanged", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    for (const value of [
      payframe("https://user-chosen.example"),
      iframerpc("https://user-chosen.example"),
      payframe(ENGINE).replace(encodeURIComponent(ENGINE), "%GG"),
    ]) expect(virtualGoogleFrameOrigin(value, ref, ENGINE)).toBe(value);
    const unknown = payframe(ENGINE);
    expect(virtualGoogleFrameOrigin(unknown, "", ENGINE)).toBe(unknown);
    expect(virtualGoogleFrameOrigin(unknown, ENGINE + "/zl/invalid!!", ENGINE)).toBe(unknown);
  });

  it("repairs a parent= parameter naming the engine on the same endpoints", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    /* platform.js builds n.parent = location.protocol + "//" +
       location.host on the same iframe family; the same engine-value
       gate applies. */
    const both = payframe(ENGINE) + "&parent=" + encodeURIComponent(ENGINE);
    const fixed = payframe("https://shop.example") + "&parent=" + encodeURIComponent("https://shop.example");
    expect(virtualGoogleFrameOrigin(both, ref, ENGINE)).toBe(fixed);
  });

  it("does not alter other hosts, other paths, or fragment values", () => {
    const ref = PAGE;
    for (const url of [
      payframe(ENGINE).replace("pay.google.com", "pay.google.com.attacker.example"),
      payframe(ENGINE).replace("pay.google.com", "pay.example.com"),
      payframe(ENGINE).replace("/gp/p/ui/payframe", "/gp/p/ui/other"),
      iframerpc(ENGINE).replace("/o/oauth2/iframerpc", "/o/oauth2/other"),
      iframerpc(ENGINE).replace("/o/oauth2/iframerpc", "/gsi/iframe/select"),
      "https://pay.google.com/gp/p/ui/payframe#origin=" + encodeURIComponent(ENGINE),
      "not a url",
    ]) expect(virtualGoogleFrameOrigin(url, ref, ENGINE, PAGE)).toBe(url);
  });
});
