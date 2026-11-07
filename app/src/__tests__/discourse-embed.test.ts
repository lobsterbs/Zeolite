import { beforeEach, describe, expect, it } from "vitest";
import { b64uEncode, buildNavHandleUrl, encodeDest, setRouteKey, setScheme } from "../codec";
import { virtualDiscourseEmbed } from "../request";

/* The Discourse embed_url= seam (#640, the #112 co= class): the
   official embed.js every Discourse forum serves names the page
   URL from window.location.href (LegacyUnforgeable), so the
   /embed/comments iframe request carries the engine route and
   the embeddable_hosts allowlist of the forum fails closed with
   the embed_error view. Pass-through cases first; the referrer
   rows pin the route families the engine serves documents from,
   mirroring disqus-page-url.test.ts. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const FORUM = "https://forum.example.com";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const PAGE = "https://www.example.org/blog/post-1?utm=x";
const embed = (eu: string) =>
  FORUM + "/embed/comments?embed_url=" + encodeURIComponent(eu) + "&discourse_username=u";

describe("virtualDiscourseEmbed (#640 discourse class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites an embed_url naming the engine route to the page url", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDiscourseEmbed(inUrl, ref, ENGINE)).toBe(embed(PAGE));
  });

  it("rewrites the explicit-port engine origin form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualDiscourseEmbed(embed(ENGINE + ":443" + encodeDest(PAGE)), ref, ENGINE)).toBe(embed(PAGE));
  });

  it("rewrites /embed/status as well as /embed/comments", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = FORUM + "/embed/status?embed_url=" + encodeURIComponent(ENGINE + encodeDest(PAGE));
    expect(virtualDiscourseEmbed(inUrl, ref, ENGINE)).toBe(
      FORUM + "/embed/status?embed_url=" + encodeURIComponent(PAGE),
    );
  });

  it("recovers the page url from a nav-handle referrer", () => {
    setRouteKey(KEY);
    const ref = ENGINE + buildNavHandleUrl(PAGE)!;
    expect(virtualDiscourseEmbed(embed(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(embed(PAGE));
  });

  it("leaves an embed_url naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = embed("https://other.example/page");
    expect(virtualDiscourseEmbed(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves other paths and a missing embed_url alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const other = FORUM + "/embed/list?embed_url=" + encodeURIComponent(ENGINE);
    expect(virtualDiscourseEmbed(other, ref, ENGINE)).toBe(other);
    const bare = FORUM + "/embed/comments?topic_id=1";
    expect(virtualDiscourseEmbed(bare, ref, ENGINE)).toBe(bare);
  });

  it("fails closed without a decodable referrer or key", () => {
    setRouteKey(KEY);
    const inUrl = embed(ENGINE + encodeDest(PAGE));
    expect(virtualDiscourseEmbed(inUrl, "", ENGINE)).toBe(inUrl);
    /* The /j/ route family decodes keyless (its shape is the
       visible carrier), so the keyless row pins the keyed handle
       family: the referrer names a handle minted under KEY, and
       clearing the key leaves nothing decodable. */
    const href = ENGINE + buildNavHandleUrl(PAGE)!;
    setRouteKey(null);
    expect(virtualDiscourseEmbed(inUrl, href, ENGINE)).toBe(inUrl);
  });
});
