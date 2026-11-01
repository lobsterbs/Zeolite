import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualDisqusPageUrl } from "../request";

/* The Disqus embed t_u=/t_i= seam (#565, the #112 co= class): the
   Universal Embed Code loader names the page URL from the document
   URL (LegacyUnforgeable), so the iframe request carries the engine
   origin and Disqus rejects it against the forum's Trusted Domains
   ("We were unable to load Disqus"). Pass-through cases first; the
   referrer rows pin every route family the engine serves documents
   from, mirroring ogs-origin.test.ts. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const embed = (tu: string, ti?: string) =>
  "https://disqus.com/embed/comments/?base=default&f=someforum&t_u=" +
  encodeURIComponent(tu) +
  (ti === undefined ? "" : "&t_i=" + encodeURIComponent(ti)) +
  "&t_d=Title&s_o=default";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://www.example.org/blog/post-1?utm=x";

describe("virtualDisqusPageUrl (#565 disqus class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites a t_u= naming the engine route to the page url", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(embed(PAGE));
  });

  it("rewrites the explicit-port engine origin form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = embed(ENGINE + ":443" + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(embed(PAGE));
  });

  it("rewrites a bare engine-origin t_u=", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualDisqusPageUrl(embed(ENGINE), ref, ENGINE)).toBe(embed(PAGE));
  });

  it("rewrites a URL-valued t_i= alongside t_u=", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = embed(ENGINE, ENGINE + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(embed(PAGE, PAGE));
  });

  it("leaves a t_i= identifier that is not a URL alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = embed(ENGINE, "article-1");
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(embed(PAGE, "article-1"));
  });

  it("leaves a t_u= naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = embed("https://www.tunetheweb.com/blog/x");
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-disqus hosts and non-embed paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const other = "https://www.example.org/embed/comments/?t_u=" + encodeURIComponent(ENGINE);
    expect(virtualDisqusPageUrl(other, ref, ENGINE)).toBe(other);
    const api = "https://disqus.com/api/3.0/threads/list.json?t_u=" + encodeURIComponent(ENGINE);
    expect(virtualDisqusPageUrl(api, ref, ENGINE)).toBe(api);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    const ref = ENGINE + "/__zl_navh__/" + token + "/blog/post-1?utm=x";
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(embed(PAGE));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(embed(PAGE));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, ref, ENGINE)).toBe(embed(PAGE));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    setRouteKey(KEY);
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualDisqusPageUrl(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("rewrites through the initiator context when given", () => {
    setRouteKey(KEY);
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDisqusPageUrl(inUrl, "", ENGINE, PAGE)).toBe(embed(PAGE));
  });
});
