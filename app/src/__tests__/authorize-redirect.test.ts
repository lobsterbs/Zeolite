import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  encodeDest,
  encodeNavHandle,
  setRouteKey,
  setScheme,
} from "../codec";
import { isAuthorizeTokenEndpoint, virtualAuthorizeRedirect, virtualAuthorizeTokenBody, dedupeMsAuthorizeIframeRequestId } from "../request";

/* The MSAL/AAD redirect_uri seam (#431, the #112 co= class): MSAL
   computes redirect_uri from window.location.origin
   (LegacyUnforgeable), so an authorize request names the engine
   origin and the OAuth round-trip lands on a native engine-origin
   URL the proxy never re-enters. Pass-through cases first; the
   referrer arms below pin every route family the engine serves
   documents from. */
const ENGINE = "https://lobsterbrowse-content-ocbg.onrender.com";
const PAGE = "https://outlook.office.com/mail/";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const ENC = new TextEncoder();
const auth = (redirect: string) =>
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20-a13f-4107-85dc-02114787ef48&redirect_uri=" +
  encodeURIComponent(redirect) +
  "&response_mode=fragment&response_type=code&code_challenge=abc&code_challenge_method=S256";

describe("virtualAuthorizeRedirect (#431 MSAL class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites a redirect_uri naming the engine origin, preserving path and query", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/?x=1"), ref, ENGINE))
      .toBe(auth("https://outlook.office.com/mail/?x=1"));
  });

  it("rewrites the explicit default-port engine form too", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualAuthorizeRedirect(auth(ENGINE + ":443/mail/"), ref, ENGINE))
      .toBe(auth("https://outlook.office.com/mail/"));
  });

  it("leaves a redirect_uri naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = auth("https://contoso.com/mail/");
    expect(virtualAuthorizeRedirect(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-authorize paths and non-Microsoft hosts alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const token =
      "https://login.microsoftonline.com/common/oauth2/v2.0/token?redirect_uri=" +
      encodeURIComponent(ENGINE + "/mail/");
    expect(virtualAuthorizeRedirect(token, ref, ENGINE)).toBe(token);
    const live = "https://login.live.com/Me.htm?v=3&redirect_uri=" + encodeURIComponent(ENGINE);
    expect(virtualAuthorizeRedirect(live, ref, ENGINE)).toBe(live);
  });

  it("rewrites through a nav-handle referrer", () => {
    setRouteKey(KEY);
    const token = encodeNavHandle(PAGE)!;
    /* #144: the handle carries the real path as a visible suffix */
    const ref = ENGINE + "/__zl_navh__/" + token + "/mail/";
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/"), ref, ENGINE))
      .toBe(auth("https://outlook.office.com/mail/"));
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/"), ref, ENGINE))
      .toBe(auth("https://outlook.office.com/mail/"));
  });

  it("rewrites through a legacy /zl/ referrer (cold-start seam)", () => {
    const ref = ENGINE + "/zl/" + b64uEncode(ENC.encode(PAGE));
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/"), ref, ENGINE))
      .toBe(auth("https://outlook.office.com/mail/"));
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    const inUrl = auth(ENGINE + "/mail/");
    expect(virtualAuthorizeRedirect(inUrl, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inUrl);
    expect(virtualAuthorizeRedirect(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("rewrites through an expired nav-handle path referrer (#634 arm A)", () => {
    setRouteKey(KEY);
    /* the page parked past NAVH_TTL_MS (or was orphaned by a worker
       re-evaluation): the MAC-verified handle still names the app
       origin, the live decode alone loses it and the authorize
       request went upstream unvirtualized (the captured Outlook
       run). ReferrerOrigin must recover the expired handle. */
    const token = encodeNavHandle(PAGE, -1)!;
    const ref = ENGINE + "/__zl_navh__/" + token + "/mail/";
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/"), ref, ENGINE))
      .toBe(auth("https://outlook.office.com/mail/"));
  });

  it("rewrites through an expired query-shape referrer (#634 arm A)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE, -1);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/"), ref, ENGINE))
      .toBe(auth("https://outlook.office.com/mail/"));
  });

  it("passes through when the parent is a Microsoft login host (#634 arm B replay)", () => {
    setRouteKey(KEY);
    /* the auto-replayed sso_reload flow: the stored authorize page
       itself is the initiating client, so the recovered parent
       origin is a login host that never registered the
       redirect_uri. A rewrite would mint an invalid value the ESTS
       hop rejects; the seam fails closed instead. */
    const h = buildQueryHandleUrl(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc",
    );
    expect(h).not.toBeNull();
    const inUrl = auth(ENGINE + "/mail/");
    expect(virtualAuthorizeRedirect(inUrl, ENGINE + h, ENGINE)).toBe(inUrl);
  });
});

/* #634: the token exchange presents the SAME redirect_uri the
   authorize step used (RFC 6749 4.1.3; AAD answers AADSTS50011
   otherwise). The #431 seam rewrites the authorize request, so the
   urlencoded POST body value must be rewritten identically or every
   seam-touched login dies at the exchange. */
describe("virtualAuthorizeTokenBody (#634 token half of #431)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  const body = (redirect: string) =>
    "grant_type=authorization_code&code=abc123&client_id=9199bf20-a13f-4107-85dc-02114787ef48&redirect_uri=" +
    encodeURIComponent(redirect) +
    "&code_verifier=vv";

  it("rewrites a body redirect_uri naming the engine origin, preserving path and query", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualAuthorizeTokenBody(body(ENGINE + "/mail/?x=1"), ref, ENGINE))
      .toBe(body("https://outlook.office.com/mail/?x=1"));
  });

  it("leaves a body redirect_uri naming another origin alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inBody = body("https://contoso.com/mail/");
    expect(virtualAuthorizeTokenBody(inBody, ref, ENGINE)).toBe(inBody);
  });

  it("passes through when the referrer never decodes (no invented fallback)", () => {
    const inBody = body(ENGINE + "/mail/");
    expect(virtualAuthorizeTokenBody(inBody, ENGINE + "/zl/garbage!!", ENGINE)).toBe(inBody);
    expect(virtualAuthorizeTokenBody(inBody, "", ENGINE)).toBe(inBody);
  });

  it("passes through when the body carries no redirect_uri or a malformed one", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualAuthorizeTokenBody("grant_type=refresh_token", ref, ENGINE)).toBe("grant_type=refresh_token");
    expect(virtualAuthorizeTokenBody("redirect_uri=%zz", ref, ENGINE)).toBe("redirect_uri=%zz");
  });

  it("rewrites through a query-shape referrer (Injector default)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const ref = ENGINE + h;
    expect(virtualAuthorizeTokenBody(body(ENGINE + "/mail/"), ref, ENGINE))
      .toBe(body("https://outlook.office.com/mail/"));
  });

  it("leaves the surrounding form fields byte-identical", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const out = virtualAuthorizeTokenBody(body(ENGINE + "/mail/"), ref, ENGINE);
    const inFields = body(ENGINE + "/mail/").split("&");
    const outFields = out.split("&");
    expect(outFields.length).toBe(inFields.length);
    expect(outFields[0]).toBe(inFields[0]);
    expect(outFields[1]).toBe(inFields[1]);
    expect(outFields[2]).toBe(inFields[2]);
    expect(outFields[4]).toBe(inFields[4]);
  });

  it("rewrites through an expired query-shape referrer (#634 arm A)", () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(PAGE, -1);
    expect(h).not.toBeNull();
    expect(virtualAuthorizeTokenBody(body(ENGINE + "/mail/"), ENGINE + h, ENGINE))
      .toBe(body("https://outlook.office.com/mail/"));
  });

  it("passes through when the parent is a Microsoft login host (#634 arm B replay)", () => {
    setRouteKey(KEY);
    /* the RFC 6749 4.1.3 consistency contract: when the authorize
       seam passes through on a login-host parent, the token seam
       must pass through on the same parent, never present a
       redirect_uri the authorize step did not use. */
    const h = buildQueryHandleUrl(
      "https://login.live.com/oauth20_authorize.srf?client_id=abc",
    );
    expect(h).not.toBeNull();
    const inBody = body(ENGINE + "/mail/");
    expect(virtualAuthorizeTokenBody(inBody, ENGINE + h, ENGINE)).toBe(inBody);
  });
});

describe("isAuthorizeTokenEndpoint (#634 shape gate)", () => {
  it("accepts the v2 token paths on the Microsoft host set", () => {
    expect(isAuthorizeTokenEndpoint("https://login.microsoftonline.com/common/oauth2/v2.0/token")).toBe(true);
    expect(isAuthorizeTokenEndpoint("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")).toBe(true);
    expect(isAuthorizeTokenEndpoint("https://login.microsoft.com/common/oauth2/v2.0/token")).toBe(true);
    expect(isAuthorizeTokenEndpoint("https://login.live.com/oauth20_token.srf")).toBe(true);
  });

  it("refuses authorize paths, other hosts and non-http schemes", () => {
    expect(isAuthorizeTokenEndpoint("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")).toBe(false);
    expect(isAuthorizeTokenEndpoint("https://contoso.com/oauth2/v2.0/token")).toBe(false);
    expect(isAuthorizeTokenEndpoint("javascript:alert(1)")).toBe(false);
    expect(isAuthorizeTokenEndpoint("not a url")).toBe(false);
  });
});

/* #706 (the white sign-in page): the ESTS ssoReload chain replays
   the authorize request from a stored login page, so the referrer
   decodes to a Microsoft login host and both the authorize and the
   token seams fail closed (#634 arm B) - the engine-origin
   redirect_uri rode upstream on every ESTS hop. The request's own
   MAC-verified zlNavh lineage names the root browsing context, and
   its established context names the origin the chain started from:
   the caller passes that home in, both seams rewrite to it
   together (RFC 6749 4.1.3), and any dishonest input (no home, a
   login-host home) keeps the fail-closed pass-through. */
describe("authorize rootHome recovery (#706 ssoReload replay)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  const ROOT = "https://outlook.office.com";

  const body = (redirect: string) =>
    "grant_type=authorization_code&code=abc123&client_id=9199bf20-a13f-4107-85dc-02114787ef48&redirect_uri=" +
    encodeURIComponent(redirect) +
    "&code_verifier=vv";

  const loginParentRef = () => {
    setRouteKey(KEY);
    const h = buildQueryHandleUrl(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc",
    );
    expect(h).not.toBeNull();
    return ENGINE + h;
  };

  it("rewrites a login-host parent authorize to the root home, preserving path and query", () => {
    const ref = loginParentRef();
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/?x=1"), ref, ENGINE, undefined, ROOT))
      .toBe(auth(ROOT + "/mail/?x=1"));
  });

  it("keeps the fail-closed pass-through without a root home or with a login-host home", () => {
    const ref = loginParentRef();
    const inUrl = auth(ENGINE + "/mail/");
    expect(virtualAuthorizeRedirect(inUrl, ref, ENGINE, undefined, null)).toBe(inUrl);
    expect(virtualAuthorizeRedirect(inUrl, ref, ENGINE, undefined, "https://login.live.com")).toBe(inUrl);
    expect(virtualAuthorizeRedirect(inUrl, ref, ENGINE, undefined, "https://login.microsoftonline.com")).toBe(inUrl);
  });

  it("never recovers into a non-http root home", () => {
    const ref = loginParentRef();
    const inUrl = auth(ENGINE + "/mail/");
    expect(virtualAuthorizeRedirect(inUrl, ref, ENGINE, undefined, "ftp://outlook.office.com")).toBe(inUrl);
  });

  it("ignores a root home when the parent is healthy (the referrer arm wins)", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualAuthorizeRedirect(auth(ENGINE + "/mail/"), ref, ENGINE, undefined, ROOT))
      .toBe(auth("https://outlook.office.com/mail/"));
  });

  it("rewrites the token body to the same root home the authorize seam wrote", () => {
    const ref = loginParentRef();
    expect(virtualAuthorizeTokenBody(body(ENGINE + "/mail/?x=1"), ref, ENGINE, undefined, ROOT))
      .toBe(body(ROOT + "/mail/?x=1"));
  });

  it("keeps the body byte-identical when the root home is dishonest (RFC 6749 4.1.3)", () => {
    const ref = loginParentRef();
    const inBody = body(ENGINE + "/mail/");
    expect(virtualAuthorizeTokenBody(inBody, ref, ENGINE, undefined, null)).toBe(inBody);
    expect(virtualAuthorizeTokenBody(inBody, ref, ENGINE, undefined, "https://login.live.com")).toBe(inBody);
  });
});

/* #706 (AADSTS9000411): the ESTS sign-in document runs in-frame under
   the engine (window.top !== self), so its ssoReload boot loop
   appends one iframe-request-id per boot onto its own url and the
   committed url accumulates them across reload cycles; ESTS refuses
   the duplicated shape with the ConvergedError error document - the
   white page. The engine dedupes last-wins at the authorize
   destination (the boot minted the freshest id last). */
describe("dedupeMsAuthorizeIframeRequestId (#706 AADSTS9000411)", () => {
  const base =
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20-a13f-4107-85dc-02114787ef48&response_mode=fragment";

  it("keeps only the freshest (last) iframe-request-id", () => {
    const acc =
      base +
      "&iframe-request-id=id-1&iframe-request-id=id-2&iframe-request-id=id-3&iframe-request-id=id-4&iframe-request-id=id-5";
    const out = new URL(dedupeMsAuthorizeIframeRequestId(acc));
    expect(out.searchParams.getAll("iframe-request-id")).toEqual(["id-5"]);
    /* the surrounding params survive */
    expect(out.searchParams.get("client_id")).toBe("9199bf20-a13f-4107-85dc-02114787ef48");
    expect(out.searchParams.get("response_mode")).toBe("fragment");
  });

  it("passes a single-id url, a token path, another host and non-authorize paths byte-unchanged", () => {
    const single = base + "&iframe-request-id=id-1";
    expect(dedupeMsAuthorizeIframeRequestId(single)).toBe(single);
    const tokenPath = "https://login.microsoftonline.com/common/oauth2/v2.0/token?iframe-request-id=a&iframe-request-id=b";
    expect(dedupeMsAuthorizeIframeRequestId(tokenPath)).toBe(tokenPath);
    const otherHost = "https://contoso.com/oauth2/v2.0/authorize?iframe-request-id=a&iframe-request-id=b";
    expect(dedupeMsAuthorizeIframeRequestId(otherHost)).toBe(otherHost);
    expect(dedupeMsAuthorizeIframeRequestId("not a url")).toBe("not a url");
  });
});
