import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/* #634/#431 codec-seam repro: the exact route shapes captured in the
   Microsoft login flow, decoded through the engine codec:

   1. The escaped nav marker: /__zl_nav__/<b64u(authorize URL)> with the
      page-JS `?sso_reload=true` decoration appended (the captured
      1175-char single-segment payload that HTTP.sys rejected with 400).
   2. The query-handle shape: real authorize pathname + full authorize
      query + zlNavh token (the in-frame chain's referrer/origin source
      for the virtualAuthorizeRedirect seams).
   3. The outer-search append onto a token-encoded query (the
      AADSTS900144 strand): mergeRouteSearch unions, never drops.
*/

import {
  b64uEncode,
  buildQueryHandleUrl,
  decodeClientUrl,
  decodeQueryHandle,
  encodeDest,
  setRouteKey,
  setScheme,
} from "../codec";
import { mergeRouteSearch } from "../request";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i + 1));

/* The captured MSAL authorize request (client_id etc., ~1175 chars as
   one path segment once b64u'd). */
const AUTHORIZE =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" +
  "?client_id=9199bf20-a13f-4107-85dc-02114787ef48" +
  "&scope=https%3A%2F%2Foutlook.office.com%2F.default%20openid%20profile%20offline_access" +
  "&redirect_uri=https%3A%2F%2Foutlook.office.com%2Fmail%2F" +
  "&response_mode=fragment&client_info=1&prompt=select_account" +
  "&response_type=code&code_challenge=bfJ_J-MyfOWsqJcA1R6SusvOCUKeS9H5NgJDaDy3d88&code_challenge_method=S256";

const b64u = (s: string) => b64uEncode(new TextEncoder().encode(s));

beforeEach(() => {
  setScheme("b64u");
  setRouteKey(KEY);
});
afterEach(() => {
  setRouteKey(null);
  setScheme("b64u");
});

describe("MSAL route shapes through the codec (#634/#431)", () => {
  it("decodes the escaped /__zl_nav__ marker payload and unions its search (the HTTP.sys 400 shape)", () => {
    const markerUrl = ORIGIN + "/__zl_nav__/" + b64u(AUTHORIZE) + "?sso_reload=true";
    expect(markerUrl.split("/").pop()!.length).toBeGreaterThan(260); // the 400 trigger
    const d = decodeClientUrl(new URL(markerUrl));
    expect(d).toBe(AUTHORIZE + "?sso_reload=true");
  });

  it("decodes a keyed /zl/ route for the long authorize URL", () => {
    const route = ORIGIN + encodeDest(AUTHORIZE);
    expect(decodeClientUrl(new URL(route))).toBe(AUTHORIZE);
  });

  it("decodes the query-handle shape: real path + full query + zlNavh token", () => {
    const q = buildQueryHandleUrl(AUTHORIZE);
    expect(q).not.toBeNull();
    const u = new URL(ORIGIN + q!);
    const decoded = decodeQueryHandle(u);
    expect(decoded).not.toBeNull();
    expect(decoded!.destination).toBe(AUTHORIZE);
    expect(decodeClientUrl(u)).toBe(AUTHORIZE);
  });

  it("keeps the token-encoded authorize query when page JS appends ?iframe-request-id (AADSTS900144 strand)", () => {
    const dest = AUTHORIZE + "&iframe-request-id=cf4f4f92";
    expect(mergeRouteSearch(AUTHORIZE, "?iframe-request-id=cf4f4f92")).toBe(dest);
    /* union semantics: a conflicting outer key wins per key, others
       survive (a conflict rebuilds via URLSearchParams, so compare
       parsed params, not raw bytes) */
    const merged = mergeRouteSearch(AUTHORIZE, "?prompt=none&x=1");
    const p = new URL(merged).searchParams;
    expect(p.get("prompt")).toBe("none");
    expect(p.get("x")).toBe("1");
    expect(p.get("client_id")).toBe("9199bf20-a13f-4107-85dc-02114787ef48");
    expect(p.get("code_challenge_method")).toBe("S256");
  });
});
