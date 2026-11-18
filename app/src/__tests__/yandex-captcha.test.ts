import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualYandexCaptchaUrl } from "../request";

/* The Yandex SmartCaptcha seam (#673, the #112 co= class, the
   #433 hCaptcha host= sibling): the widget pages read
   window.location.host and location.href (LegacyUnforgeable) into
   host=/href=, so a virtualized page names the engine origin and
   the widget renders the wrong-domain error instead of the
   challenge. The helpers pin the issue's URL shapes:
   captcha-api.yandex.ru and smartcaptcha.yandexcloud.net widget
   pages. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://shop.example/account?next=%2Fmail&x=1";
const widget = (host: string, href: string) =>
  "https://captcha-api.yandex.ru/checkbox.ru.4e04c3350896cfb6.html?sitekey=fixture&hl=ru&host=" +
  encodeURIComponent(host) + "&href=" + encodeURIComponent(href);

describe("virtualYandexCaptchaUrl (#673 smartcaptcha class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites host= and href= that name the engine to the page values", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualYandexCaptchaUrl(widget(ENGINE, ENGINE + encodeDest(PAGE)), ref, ENGINE))
      .toBe(widget("shop.example", PAGE));
  });

  it("rewrites only host= when href= names another origin", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget(ENGINE, "https://widget.example.net/x");
    expect(virtualYandexCaptchaUrl(inUrl, ref, ENGINE)).toBe(widget("shop.example", "https://widget.example.net/x"));
  });

  it("rewrites the explicit-port engine host form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualYandexCaptchaUrl(widget(ENGINE + ":443", ENGINE + encodeDest(PAGE)), ref, ENGINE))
      .toBe(widget("shop.example", PAGE));
  });

  it("rewrites the smartcaptcha.yandexcloud.net host and the advanced page", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl =
      "https://smartcaptcha.yandexcloud.net/advanced.en.4e04c3350896cfb6.html?sitekey=fixture&host=" +
      encodeURIComponent(ENGINE);
    expect(virtualYandexCaptchaUrl(inUrl, ref, ENGINE)).toBe(
      "https://smartcaptcha.yandexcloud.net/advanced.en.4e04c3350896cfb6.html?sitekey=fixture&host=" +
        encodeURIComponent("shop.example"),
    );
  });

  it("rewrites the backend and challenge widget pages too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const backend =
      "https://captcha-api.yandex.ru/backend.fc789ceda4f18585.html?host=" + encodeURIComponent(ENGINE);
    expect(virtualYandexCaptchaUrl(backend, ref, ENGINE)).toBe(
      "https://captcha-api.yandex.ru/backend.fc789ceda4f18585.html?host=" + encodeURIComponent("shop.example"),
    );
    const challenge =
      "https://captcha-api.yandex.ru/challenge-abc123.html?host=" + encodeURIComponent(ENGINE);
    expect(virtualYandexCaptchaUrl(challenge, ref, ENGINE)).toBe(
      "https://captcha-api.yandex.ru/challenge-abc123.html?host=" + encodeURIComponent("shop.example"),
    );
  });

  it("leaves non-widget paths and other hosts alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const loader = "https://captcha-api.yandex.ru/captcha.js?host=" + encodeURIComponent(ENGINE);
    expect(virtualYandexCaptchaUrl(loader, ref, ENGINE)).toBe(loader);
    const check = "https://captcha-api.yandex.ru/check?host=" + encodeURIComponent(ENGINE);
    expect(virtualYandexCaptchaUrl(check, ref, ENGINE)).toBe(check);
    const other =
      "https://api.example.net/checkbox.ru.4e04c3350896cfb6.html?host=" + encodeURIComponent(ENGINE);
    expect(virtualYandexCaptchaUrl(other, ref, ENGINE)).toBe(other);
  });

  it("leaves a host= naming another host alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget("real.example.org", PAGE);
    expect(virtualYandexCaptchaUrl(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path and query on the route */
    const ref = ENGINE + "/__zl_navh__/" + token + "/account?next=%2Fmail&x=1";
    expect(virtualYandexCaptchaUrl(widget(ENGINE, ENGINE + encodeDest(PAGE)), ref, ENGINE))
      .toBe(widget("shop.example", PAGE));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualYandexCaptchaUrl(widget(ENGINE, ENGINE + encodeDest(PAGE)), ref, ENGINE))
      .toBe(widget("shop.example", PAGE));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualYandexCaptchaUrl(widget(ENGINE, ENGINE + encodeDest(PAGE)), ref, ENGINE))
      .toBe(widget("shop.example", PAGE));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    setRouteKey(KEY);
    const inUrl = widget(ENGINE, ENGINE + encodeDest(PAGE));
    expect(virtualYandexCaptchaUrl(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualYandexCaptchaUrl(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("rewrites through the initiator context when given", () => {
    setRouteKey(KEY);
    expect(virtualYandexCaptchaUrl(widget(ENGINE, ENGINE + encodeDest(PAGE)), "", ENGINE, PAGE))
      .toBe(widget("shop.example", PAGE));
  });
});
