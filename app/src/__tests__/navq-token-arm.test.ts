import { beforeEach, describe, expect, it } from "vitest";
import { makeRel, navqToken, NAVP } from "../bootstrap/navguard";
import { routeAnchor } from "../bootstrap/mint";
import { setRouteKey, setScheme } from "../codec";

/* #708/#511 (the bscframe class): a query-shape committed page
   (real path + zlNavh in the search) has no engine route prefix to
   anchor on. A 1-segment path ("/ServiceLogin") made makeRel's
   engPrefix undefined, so relative navigation-bound writes went BARE
   (the SW escape "same-origin unknown home" -> host static 404), and
   a deeper path minted a prel WITHOUT the token, so the SW could not
   decode the parent (bad route / ghost upstream). The token arm
   re-emits <real path>/__zl_prel__/<enc(input)>?zlNavh=<token>: the
   SW's committed-query decode owns the restore, MAC-verified. These
   tests pin the arm's honest never-re-emit set. */

const ENGINE = "https://engine.host";
const TOK = "mac-verified-token";

describe("navqToken (raw zlNavh extractor)", () => {
  it("extracts the raw token from a committed search", () => {
    expect(navqToken("?zlNavh=" + TOK)).toBe(TOK);
    expect(navqToken("?a=1&zlNavh=" + TOK + "&b=2")).toBe(TOK);
    expect(navqToken("zlNavh=" + TOK)).toBe(TOK);
  });
  it("returns null without the param or without a search", () => {
    expect(navqToken("")).toBeNull();
    expect(navqToken("?a=1&b=2")).toBeNull();
    /* an empty value is not a token (impostor fail-closed) */
    expect(navqToken("?zlNavh=")).toBeNull();
    expect(navqToken("?zlNavh=&a=1")).toBeNull();
  });
});

describe("makeRel token arm (#511 query-shape parents)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("re-emits a 1-segment parent with the token in the prel search", () => {
    /* the capture shape: a committed page at /ServiceLogin?zlNavh=tok */
    const rel = makeRel("/ServiceLogin", ENGINE, TOK)!;
    expect(rel("/gsi/iframe/select?theme=glif")).toBe(
      "/ServiceLogin" + NAVP + "/" + encodeURIComponent("/gsi/iframe/select?theme=glif") + "?zlNavh=" + TOK,
    );
  });

  it("re-emits a deeper parent through the token arm too (token wins over prefix)", () => {
    /* "/v3/signin/identifier" HAS an engPrefix, but the prel it mints
       must carry the token or the SW cannot decode the parent */
    const rel = makeRel("/v3/signin/identifier", ENGINE, TOK)!;
    expect(rel("/x/y?a=1")).toBe(
      "/v3/signin/identifier" + NAVP + "/" + encodeURIComponent("/x/y?a=1") + "?zlNavh=" + TOK,
    );
  });

  it("keeps the fragment raw off the prel tail (#543 contract)", () => {
    const rel = makeRel("/ServiceLogin", ENGINE, TOK)!;
    expect(rel("/x#f")).toBe(
      "/ServiceLogin" + NAVP + "/" + encodeURIComponent("/x") + "?zlNavh=" + TOK + "#f",
    );
  });

  it("stays null for a 1-segment parent without a token (the historical escape verdict)", () => {
    expect(makeRel("/ServiceLogin", ENGINE)!("/x/y")).toBeNull();
  });

  it("keeps the prefix arm byte-identical when no token is passed", () => {
    expect(makeRel("/j/abc", ENGINE)!("/x/y")).toBe("/j/abc" + NAVP + "/" + encodeURIComponent("/x/y"));
  });

  it("never activates the token arm for engine surfaces (routeAnchor refuses them)", () => {
    /* routeAnchor refuses engine-surface paths, so the token arm must
       never fire for one either: /zlsw (1-segment, no engPrefix) and
       /bootstrap.js both stay re-emit-free instead of minting a
       prel the SW would fail to decode. */
    expect(makeRel("/zlsw", ENGINE, TOK)!("/x/y")).toBeNull();
    expect(makeRel("/bootstrap.js", ENGINE, TOK)!("/x")).toBeNull();
  });

  it("never anchors the engine root, a marker parent or a token-shaped parent", () => {
    expect(makeRel("/", ENGINE, TOK)!("/x")).toBeNull();
    /* marker and scheme-token parents keep their own arms: the token
       arm must not pre-empt them */
    const marker = makeRel("/__zl_nav__/abc", ENGINE, TOK)!;
    expect(marker("/x/y")).toBe("/__zl_nav__/abc" + NAVP + "/" + encodeURIComponent("/x/y"));
  });

  it("excludes prel-carrying, scheme, protocol-relative and fragment inputs like the prefix arm", () => {
    const rel = makeRel("/ServiceLogin", ENGINE, TOK)!;
    expect(rel("/a/__zl_prel__/%2Fx")).toBeNull();
    expect(rel("https://other.example/x")).toBeNull();
    expect(rel("//other.example/x")).toBeNull();
    expect(rel("#frag")).toBeNull();
    expect(rel("")).toBeNull();
  });
});

describe("routeAnchor (#511 query-shape anchor)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("anchors a zlNavh-bearing page URL to its real path", () => {
    expect(routeAnchor(ENGINE + "/ServiceLogin?x=1&zlNavh=" + TOK)).toBe("/ServiceLogin");
  });

  it("stays undefined without the token (the demo page, devtools)", () => {
    expect(routeAnchor(ENGINE + "/ServiceLogin?x=1")).toBeUndefined();
    expect(routeAnchor(ENGINE + "/")).toBeUndefined();
  });

  it("refuses an engine-surface path even with a zlNavh-shaped param (impostor fail-closed)", () => {
    expect(routeAnchor(ENGINE + "/zlsw/devtools.html?zlNavh=impostor")).toBeUndefined();
    expect(routeAnchor(ENGINE + "/bootstrap.js?zlNavh=impostor")).toBeUndefined();
  });

  it("keeps the engine-route shapes (marker and scheme routes)", () => {
    expect(routeAnchor(ENGINE + "/__zl_nav__/abc")).toBe("/__zl_nav__/abc");
    expect(routeAnchor(ENGINE + "/j/aaaaaaaaaaaa/x")).toBe("/j/aaaaaaaaaaaa/x");
  });
});
