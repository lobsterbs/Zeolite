import { beforeEach, describe, expect, it } from "vitest";
import { b64uEncode, encodeDest, setRouteKey, setScheme } from "../codec";
import { virtualTelegramOrigin } from "../request";

/* The Telegram Login widget seam (#509, the #112 co= class): the
   widget loader builds oauth.telegram.org/auth with an origin=
   parameter from window.location.origin (LegacyUnforgeable), so a
   virtualized page names the engine origin, Telegram matches it
   against the bot pre-registered Allowed URLs, and the login
   answers NOT_AUTHORIZED. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const PAGE = "https://www.example.com/login";

const auth = (origin: string) =>
  "https://oauth.telegram.org/auth?bot_id=123456789&origin=" +
  encodeURIComponent(origin) +
  "&request_access=write&lang=en&return_to=" +
  encodeURIComponent(PAGE);

const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

describe("virtualTelegramOrigin (#509 telegram class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites an origin= naming the engine origin to the page origin", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualTelegramOrigin(auth(ENGINE), ref, ENGINE))
      .toBe(auth("https://www.example.com"));
  });

  it("rewrites port-suffixed engine forms and leaves every other param untouched", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const out = virtualTelegramOrigin(auth(ENGINE + ":443"), ref, ENGINE);
    expect(out).toBe(auth("https://www.example.com"));
    expect(out).toContain("bot_id=123456789");
    expect(out).toContain("request_access=write");
    expect(out).toContain("lang=en");
    expect(out).toContain("return_to=" + encodeURIComponent(PAGE));
  });

  it("leaves an origin= naming a real domain alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = auth("https://www.example.com");
    expect(virtualTelegramOrigin(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-telegram hosts and non-auth paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const otherHost = "https://oauth.example.org/auth?origin=" + encodeURIComponent(ENGINE);
    expect(virtualTelegramOrigin(otherHost, ref, ENGINE)).toBe(otherHost);
    const deep = "https://oauth.telegram.org/widgets/auth?origin=" + encodeURIComponent(ENGINE);
    expect(virtualTelegramOrigin(deep, ref, ENGINE)).toBe(deep);
    const lib = "https://telegram.org/js/telegram-widget.js";
    expect(virtualTelegramOrigin(lib, ref, ENGINE)).toBe(lib);
  });

  it("fails closed without a usable referrer or initiator", () => {
    setRouteKey(KEY);
    const inUrl = auth(ENGINE);
    expect(virtualTelegramOrigin(inUrl, "", ENGINE)).toBe(inUrl);
  });
});
