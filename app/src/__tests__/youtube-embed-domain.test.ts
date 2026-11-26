import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualYouTubeEmbedDomain } from "../request";

/* The YouTube live_chat embed_domain seam (#721, the #112 co=
   class): page loaders build embed_domain= from
   window.location.hostname (LegacyUnforgeable), so a
   virtualized page names the engine hostname and YouTube
   refuses the chat iframe (the embed_domain must match the
   embedding page's URL). Pass-through cases first; the
   referrer cases pin every route family the engine serves
   documents from. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const chat = (domain: string) =>
  "https://www.youtube.com/live_chat?v=abc123&embed_domain=" +
  encodeURIComponent(domain) +
  "&dark_theme=1";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://www.youtube.com/watch?v=abc123";

describe("virtualYouTubeEmbedDomain (#721 live_chat class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites an embed_domain= naming the engine origin to the page hostname", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualYouTubeEmbedDomain(chat(ENGINE), ref, ENGINE))
      .toBe(chat("www.youtube.com"));
  });

  it("rewrites the bare hostname and port-suffixed engine forms", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualYouTubeEmbedDomain(chat("lobsterbrowse-beta.onrender.com"), ref, ENGINE))
      .toBe(chat("www.youtube.com"));
    expect(virtualYouTubeEmbedDomain(chat("lobsterbrowse-beta.onrender.com:443"), ref, ENGINE))
      .toBe(chat("www.youtube.com"));
  });

  it("rewrites a third-party embedding page to its own hostname", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest("https://www.example.com/stream");
    expect(virtualYouTubeEmbedDomain(chat("lobsterbrowse-beta.onrender.com"), ref, ENGINE))
      .toBe(chat("www.example.com"));
  });

  it("leaves an embed_domain= naming a real domain alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = chat("www.example.com");
    expect(virtualYouTubeEmbedDomain(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-live_chat paths and other youtube hosts alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const watch = "https://www.youtube.com/watch?v=abc123&embed_domain=" + encodeURIComponent(ENGINE);
    expect(virtualYouTubeEmbedDomain(watch, ref, ENGINE)).toBe(watch);
    const m = "https://m.youtube.com/live_chat?v=abc123&embed_domain=" + encodeURIComponent(ENGINE);
    expect(virtualYouTubeEmbedDomain(m, ref, ENGINE)).toBe(m);
    const api = "https://www.youtube.com/youtubei/v1/player?key=x&embed_domain=" + encodeURIComponent(ENGINE);
    expect(virtualYouTubeEmbedDomain(api, ref, ENGINE)).toBe(api);
  });

  it("passes through when embed_domain is absent or not engine-valued elsewhere", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const noParam = "https://www.youtube.com/live_chat?v=abc123&dark_theme=1";
    expect(virtualYouTubeEmbedDomain(noParam, ref, ENGINE)).toBe(noParam);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/watch";
    expect(virtualYouTubeEmbedDomain(chat(ENGINE), ref, ENGINE))
      .toBe(chat("www.youtube.com"));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualYouTubeEmbedDomain(chat(ENGINE), ref, ENGINE))
      .toBe(chat("www.youtube.com"));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualYouTubeEmbedDomain(chat(ENGINE), ref, ENGINE))
      .toBe(chat("www.youtube.com"));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    const inUrl = chat(ENGINE);
    expect(virtualYouTubeEmbedDomain(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualYouTubeEmbedDomain(inUrl, "", ENGINE)).toBe(inUrl);
  });
});
