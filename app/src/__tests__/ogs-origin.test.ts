import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualOgsOrigin } from "../request";

/* The Google apps widget origin= seam (#112 co= class): page JS
   builds origin= from window.location.origin (LegacyUnforgeable),
   so the widget names the engine origin and Google never renders
   it. Pass-through cases first; the referrer its below pin every
   route family the engine serves documents from. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const widget = (origin: string) =>
  "https://ogs.google.com/widget/app/so?eom=1&awwd=1&origin=" +
  encodeURIComponent(origin) + "&cn=app&pid=1&hl=en";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://www.google.com/search?q=x";

describe("virtualOgsOrigin (#112 ogs class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites an origin= that names the engine origin to the page origin", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualOgsOrigin(widget(ENGINE), ref, ENGINE))
      .toBe(widget("https://www.google.com"));
  });

  it("rewrites the explicit-port engine origin form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualOgsOrigin(widget(ENGINE + ":443"), ref, ENGINE))
      .toBe(widget("https://www.google.com"));
  });

  it("leaves an origin= naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget("https://example.com");
    expect(virtualOgsOrigin(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-ogs hosts and non-widget paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const serp = "https://www.google.com/search?q=hi&origin=" + encodeURIComponent(ENGINE);
    expect(virtualOgsOrigin(serp, ref, ENGINE)).toBe(serp);
    const other = "https://ogs.google.com/other?origin=" + encodeURIComponent(ENGINE);
    expect(virtualOgsOrigin(other, ref, ENGINE)).toBe(other);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/search";
    expect(virtualOgsOrigin(widget(ENGINE), ref, ENGINE))
      .toBe(widget("https://www.google.com"));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualOgsOrigin(widget(ENGINE), ref, ENGINE))
      .toBe(widget("https://www.google.com"));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualOgsOrigin(widget(ENGINE), ref, ENGINE))
      .toBe(widget("https://www.google.com"));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    const inUrl = widget(ENGINE);
    expect(virtualOgsOrigin(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualOgsOrigin(inUrl, "", ENGINE)).toBe(inUrl);
  });

  /* #703 wild reopen: the injector appends the page's zlNavh query
     handle to the engine-origin URL page JS builds, so the widget URL
     itself carries the MAC-verified page origin while the referrer is
     the strict-policy origin form and the client context is absent
     (or engine-shaped). The repair reads the riding token; no token or
     a non-verifying token fails closed. */
  it("repairs origin= from a zlNavh handle riding the widget URL (#703 wild)", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    const wild = widget(ENGINE) + "&dm=&zlNavh=" + token;
    expect(virtualOgsOrigin(wild, ENGINE + "/", ENGINE))
      .toBe(widget("https://www.google.com") + "&dm=&zlNavh=" + token);
  });

  it("discards an engine-origin initiator and repairs from the handle instead", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    const wild = widget(ENGINE) + "&zlNavh=" + token;
    expect(virtualOgsOrigin(wild, "", ENGINE, ENGINE + "/guest-host.html"))
      .toBe(widget("https://www.google.com") + "&zlNavh=" + token);
  });

  it("repairs from an expired riding handle (#633 derived-context trust)", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE, -1)!;
    const wild = widget(ENGINE) + "&zlNavh=" + token;
    expect(virtualOgsOrigin(wild, "", ENGINE))
      .toBe(widget("https://www.google.com") + "&zlNavh=" + token);
  });

  it("fails closed when the riding zlNavh does not MAC-verify", () => {
    setRouteKey(KEY);
    const wild = widget(ENGINE) + "&zlNavh=not-a-token";
    expect(virtualOgsOrigin(wild, "", ENGINE)).toBe(wild);
  });
});
