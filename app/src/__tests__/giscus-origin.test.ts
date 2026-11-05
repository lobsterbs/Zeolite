import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { virtualGiscusOrigin } from "../request";

/* The Giscus widget origin= seam (#637, the #112 co= class): the
   giscus.app client.js loader names the page in origin= (backLink=,
   mapping=url term=) from the cleaned location (LegacyUnforgeable),
   so the widget request carries the engine origin and giscus's
   strict-mode origins check refuses the iframe. The widget helper
   pins the issue's URL shape: a locale path segment ahead of
   /widget and percent-encoded parameters. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const widget = (origin: string, extra = "") =>
  "https://giscus.app/en/widget?origin=" +
  encodeURIComponent(origin) +
  (extra ? "&" + extra : "");
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const PAGE = "https://blog.example.org/post/giscus-test?hl=en";

describe("virtualGiscusOrigin (#637 giscus class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites an origin= naming the engine route to the page url", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGiscusOrigin(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites the explicit-port engine origin form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGiscusOrigin(widget(ENGINE + ":443" + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites a bare engine-origin origin=", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualGiscusOrigin(widget(ENGINE), ref, ENGINE)).toBe(widget(PAGE));
    const bare = "https://giscus.app/widget?origin=" + encodeURIComponent(ENGINE);
    expect(virtualGiscusOrigin(bare, ref, ENGINE)).toBe(
      "https://giscus.app/widget?origin=" + encodeURIComponent(PAGE),
    );
  });

  it("preserves the matched value's anchor", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget(ENGINE + encodeDest(PAGE) + "#comments");
    expect(virtualGiscusOrigin(inUrl, ref, ENGINE)).toBe(widget(PAGE + "#comments"));
  });

  it("rides backLink= and mapping=url term= when they name this deployment", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget(
      ENGINE + encodeDest(PAGE),
      "backLink=" +
        encodeURIComponent(ENGINE + encodeDest(PAGE)) +
        "&term=" +
        encodeURIComponent(ENGINE + encodeDest(PAGE)),
    );
    const want = widget(
      PAGE,
      "backLink=" + encodeURIComponent(PAGE) + "&term=" + encodeURIComponent(PAGE),
    );
    expect(virtualGiscusOrigin(inUrl, ref, ENGINE)).toBe(want);
  });

  it("leaves a term= that does not name this deployment alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget(ENGINE + encodeDest(PAGE), "term=" + encodeURIComponent("blog-post-1"));
    expect(virtualGiscusOrigin(inUrl, ref, ENGINE)).toBe(
      widget(PAGE, "term=" + encodeURIComponent("blog-post-1")),
    );
  });

  it("leaves an origin= naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget("https://widget.example.net/page");
    expect(virtualGiscusOrigin(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-giscus hosts and non-widget paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const other = "https://www.example.org/en/widget?origin=" + encodeURIComponent(ENGINE);
    expect(virtualGiscusOrigin(other, ref, ENGINE)).toBe(other);
    const api = "https://giscus.app/api/discussions?origin=" + encodeURIComponent(ENGINE);
    expect(virtualGiscusOrigin(api, ref, ENGINE)).toBe(api);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    const ref = ENGINE + "/__zl_navh__/" + token + "/post/giscus-test?hl=en";
    expect(virtualGiscusOrigin(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualGiscusOrigin(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualGiscusOrigin(widget(ENGINE + encodeDest(PAGE)), ref, ENGINE)).toBe(widget(PAGE));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    setRouteKey(KEY);
    const inUrl = widget(ENGINE + encodeDest(PAGE));
    expect(virtualGiscusOrigin(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualGiscusOrigin(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("rewrites through the initiator context when given", () => {
    setRouteKey(KEY);
    expect(virtualGiscusOrigin(widget(ENGINE + encodeDest(PAGE)), "", ENGINE, PAGE)).toBe(widget(PAGE));
  });
});
