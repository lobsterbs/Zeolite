import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualVkWidgetUrl } from "../request";

/* The VK Open API url=/location= seam (#669, the #112 co= class): the
   openapi.js loader names the embedding page in url= on the widget
   endpoints and in location= on the auth transport, so a virtualized
   page names the engine route and the widget renders the base-domain
   error. The helpers pin the issue's URL shapes. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const widget = (url: string) =>
  "https://vk.com/widget_comments.php?app=123&url=" + encodeURIComponent(url) + "&title=Fixture";
const poll = (url: string) =>
  "https://vk.com/al_widget_poll.php?app=123&poll_id=1&url=" + encodeURIComponent(url);
const auth = (location: string) =>
  "https://login.vk.com/?act=openapi&oauth=1&aid=123&location=" + encodeURIComponent(location);
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://blog.example.org/post/vk-test?hl=en";
const HOST = "blog.example.org";

describe("virtualVkWidgetUrl (#669 vk class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites a url= naming the engine route to the page url", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualVkWidgetUrl(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites the al_widget_ path family too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualVkWidgetUrl(poll(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(poll(PAGE));
  });

  it("rewrites the explicit-port engine origin form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualVkWidgetUrl(widget(ENGINE + ":443" + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites the auth transport location= to the page hostname", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualVkWidgetUrl(auth("lobsterbrowse-beta.onrender.com"), ref, ENGINE)).toBe(auth(HOST));
  });

  it("accepts the origin form of the auth location= too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualVkWidgetUrl(auth(ENGINE), ref, ENGINE)).toBe(auth(HOST));
  });

  it("leaves a url= naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget("https://widget.example.net/page");
    expect(virtualVkWidgetUrl(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves a location= naming another host alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = auth("other.example");
    expect(virtualVkWidgetUrl(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-widget vk.com paths and non-openapi login paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const feed = "https://vk.com/feed.php?url=" + encodeURIComponent(ENGINE + encodeDest(PAGE));
    expect(virtualVkWidgetUrl(feed, ref, ENGINE)).toBe(feed);
    const login = "https://login.vk.com/?act=login&location=" + encodeURIComponent("lobsterbrowse-beta.onrender.com");
    expect(virtualVkWidgetUrl(login, ref, ENGINE)).toBe(login);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/post/vk-test?hl=en";
    expect(virtualVkWidgetUrl(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualVkWidgetUrl(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualVkWidgetUrl(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    setRouteKey(KEY);
    const inUrl = widget(ENGINE + encodeDest(PAGE));
    expect(virtualVkWidgetUrl(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualVkWidgetUrl(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("rewrites through the initiator context when given", () => {
    setRouteKey(KEY);
    expect(virtualVkWidgetUrl(widget(ENGINE + encodeDest(PAGE)), "", ENGINE, PAGE)).toBe(widget(PAGE));
  });
});
