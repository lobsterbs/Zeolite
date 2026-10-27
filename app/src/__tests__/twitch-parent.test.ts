import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualTwitchParent } from "../request";

/* The Twitch parent= seam (#506, the #112 co= class): the embed
   library builds parent= from window.location.hostname
   (LegacyUnforgeable), so a virtualized page names the engine
   hostname and Twitch refuses the iframe. Pass-through cases
   first; the referrer cases below pin every route family the
   engine serves documents from. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const player = (parent: string) =>
  "https://player.twitch.tv/?channel=somechannel&parent=" +
  encodeURIComponent(parent) +
  "&muted=false";
const chat = (parent: string) =>
  "https://embed.twitch.tv/embed/somechannel/chat?parent=" +
  encodeURIComponent(parent);
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://www.example.com/watch";

describe("virtualTwitchParent (#506 twitch class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites a parent= that names the engine origin to the page hostname", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualTwitchParent(player(ENGINE), ref, ENGINE))
      .toBe(player("www.example.com"));
  });

  it("rewrites the chat embed path and port-suffixed engine forms", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualTwitchParent(chat("lobsterbrowse-beta.onrender.com:443"), ref, ENGINE))
      .toBe(chat("www.example.com"));
  });

  it("rewrites every engine-valued occurrence (one parent key per domain)", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const two =
      "https://player.twitch.tv/?channel=x&parent=" +
      encodeURIComponent(ENGINE) +
      "&parent=" +
      encodeURIComponent("lobsterbrowse-beta.onrender.com");
    const want =
      "https://player.twitch.tv/?channel=x&parent=www.example.com&parent=www.example.com";
    expect(virtualTwitchParent(two, ref, ENGINE)).toBe(want);
  });

  it("leaves a parent= naming a real domain alone (statically authored embeds)", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = player("www.example.com");
    expect(virtualTwitchParent(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-twitch hosts and non-player paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const otherHost = "https://player.example.tv/?parent=" + encodeURIComponent(ENGINE);
    expect(virtualTwitchParent(otherHost, ref, ENGINE)).toBe(otherHost);
    const deep = "https://player.twitch.tv/sub/path?parent=" + encodeURIComponent(ENGINE);
    expect(virtualTwitchParent(deep, ref, ENGINE)).toBe(deep);
    const lib = "https://embed.twitch.tv/embed/v1.js";
    expect(virtualTwitchParent(lib, ref, ENGINE)).toBe(lib);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/watch";
    expect(virtualTwitchParent(player(ENGINE), ref, ENGINE))
      .toBe(player("www.example.com"));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualTwitchParent(player(ENGINE), ref, ENGINE))
      .toBe(player("www.example.com"));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualTwitchParent(player(ENGINE), ref, ENGINE))
      .toBe(player("www.example.com"));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    const inUrl = player(ENGINE);
    expect(virtualTwitchParent(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualTwitchParent(inUrl, "", ENGINE)).toBe(inUrl);
  });
});
