import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CookieJar } from "tough-cookie";

import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieRead,
  jarSnapshot,
} from "../cookies";

/* #634/#431 repro: the MSAL login chain replayed through the engine
   cookie jar, hop by hop, exactly the way request.ts drives it in the
   redirect hop loop:

     applySetCookie(hopUrl, jarHeaders(resp))   // capture this hop
     cookieHeaderFor(next, reqCtx)              // attach to the next hop

   Chain (representative of the observed Microsoft flow):
     1. login.microsoftonline.com/common/oauth2/v2.0/authorize -> 302
        with a batch of Set-Cookie headers, including cross-domain SSO
        cookies (Domain=.live.com / .microsoft.com) that MUST be
        honestly rejected (RFC 6265 5.3: a Domain must scope the
        response host) and same-site cookies that MUST be stored.
        Location: login.live.com/Me.htm?v=3
     2. login.live.com/Me.htm?v=3 -> 302 with .live.com cookies,
        Location back to login.microsoftonline.com.
     3. The final authorize leg must carry every cookie that scopes
        login.microsoftonline.com.

   Every step is asserted against tough-cookie (the RFC reference
   implementation) fed the same sequence. */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

function admit(url: string, headers: string[]) {
  return applySetCookie(url, resp(headers));
}

function ours(url: string): string {
  return cookieHeaderFor(url) ?? "";
}

const AUTHORIZE =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20&response_type=code";
const ME_HTM = "https://login.live.com/Me.htm?v=3";
const AUTHORIZE_2 =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20&sso_reload=true";

/* The Set-Cookie batch login.microsoftonline.com answers the authorize
   request with: session SSO cookies scoped to its own registrable
   domain, plus the cross-domain SSO cookies that produced the four
   "domain does not scope response host" warnings in #431. */
const HOP1_SETCOOKIE = [
  "ESTSSC=abc123; Domain=.login.microsoftonline.com; Path=/; Secure; SameSite=None",
  "ESTSAUTH=xyz; Domain=.login.microsoftonline.com; Path=/; Secure; HttpOnly; SameSite=Lax",
  "CCState=state1; Domain=.microsoftonline.com; Path=/; Secure",
  "LoginAttempts=1; Path=/; Secure; HttpOnly",
  /* cross-domain SSO attempts: a browser rejects these too */
  "SSOLive=1; Domain=.live.com; Path=/; Secure; SameSite=None",
  "SSOMs=1; Domain=.microsoft.com; Path=/; Secure",
];

const HOP2_SETCOOKIE = [
  "MSPRequ=req1; Domain=.live.com; Path=/; Secure",
  "MSPAuth=tok; Path=/; Secure; HttpOnly",
  "Profile=pf; Domain=.login.live.com; Path=/; Secure",
  /* cross-domain from the live.com side: must be rejected too */
  "BackToMso=1; Domain=.microsoftonline.com; Path=/; Secure",
];

describe("MSAL chain cookie scoping (#634/#431 repro)", () => {
  it("stores same-site cookies and honestly rejects cross-domain ones on hop 1", () => {
    const results = admit(AUTHORIZE, HOP1_SETCOOKIE);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("ESTSSC")?.stored).toBe(true);
    expect(byName.get("ESTSAUTH")?.stored).toBe(true);
    expect(byName.get("CCState")?.stored).toBe(true);
    expect(byName.get("LoginAttempts")?.stored).toBe(true);
    /* the four #431 warnings: honest RFC 6265 5.3 rejections */
    expect(byName.get("SSOLive")?.rejected).toBe("domain");
    expect(byName.get("SSOMs")?.rejected).toBe("domain");
    expect(byName.get("SSOLive")?.stored).toBe(false);
  });

  it("sends nothing from microsoftonline.com to login.live.com, matching tough-cookie", () => {
    admit(AUTHORIZE, HOP1_SETCOOKIE);
    const refJar = new CookieJar();
    for (const header of HOP1_SETCOOKIE) try { refJar.setCookieSync(header, AUTHORIZE, { http: true }) } catch { /* tough-cookie rejects cross-domain too */ };

    expect(ours(ME_HTM)).toBe(refJar.getCookieStringSync(ME_HTM, { http: true }));
    expect(ours(ME_HTM)).toBe("");
  });

  it("hop 2: .live.com cookies store, cross-domain ones reject, and the return hop carries the microsoftonline.com session", () => {
    admit(AUTHORIZE, HOP1_SETCOOKIE);

    const results2 = admit(ME_HTM, HOP2_SETCOOKIE);
    const byName2 = new Map(results2.map((r) => [r.name, r]));
    expect(byName2.get("MSPRequ")?.stored).toBe(true);
    expect(byName2.get("MSPAuth")?.stored).toBe(true);
    expect(byName2.get("Profile")?.stored).toBe(true);
    expect(byName2.get("BackToMso")?.rejected).toBe("domain");

    /* next hop back to login.microsoftonline.com: the full hop-1 set
       must ride along, in 5.4 order, and nothing live.com-scoped */
    const refJar = new CookieJar();
    for (const header of HOP1_SETCOOKIE) try { refJar.setCookieSync(header, AUTHORIZE, { http: true }) } catch { /* tough-cookie rejects cross-domain too */ };
    for (const header of HOP2_SETCOOKIE) try { refJar.setCookieSync(header, ME_HTM, { http: true }) } catch { /* tough-cookie rejects cross-domain too */ };

    const expected = refJar.getCookieStringSync(AUTHORIZE_2, { http: true });
    const got = ours(AUTHORIZE_2);
    expect(got).toBe(expected);
    expect(got).toContain("ESTSSC=abc123");
    expect(got).toContain("ESTSAUTH=xyz");
    expect(got).toContain("CCState=state1");
    expect(got).not.toContain("MSPRequ");
    expect(got).not.toContain("MSPAuth");
  });

  it("Domain=.microsoftonline.com scopes subdomains of microsoftonline.com but not live.com (oracle-pinned)", () => {
    admit(AUTHORIZE, HOP1_SETCOOKIE);
    const refJar = new CookieJar();
    for (const header of HOP1_SETCOOKIE) try { refJar.setCookieSync(header, AUTHORIZE, { http: true }) } catch { /* tough-cookie rejects cross-domain too */ };

    for (const url of [
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://device.login.microsoftonline.com/foo",
      "https://login.live.com/Me.htm?v=3",
      "https://login.microsoft.com/",
    ]) {
      expect(ours(url)).toBe(refJar.getCookieStringSync(url, { http: true }));
    }
  });

  it("document.cookie on the login.live.com document sees only live.com non-HttpOnly cookies", () => {
    admit(AUTHORIZE, HOP1_SETCOOKIE);
    admit(ME_HTM, HOP2_SETCOOKIE);
    expect(documentCookieRead(ME_HTM)).toBe("MSPRequ=req1; Profile=pf");
    expect(documentCookieRead(AUTHORIZE_2)).toBe("ESTSSC=abc123; CCState=state1");
  });

  it("jar snapshot keeps the cookies bucketed under their setting origin", () => {
    admit(AUTHORIZE, HOP1_SETCOOKIE);
    admit(ME_HTM, HOP2_SETCOOKIE);
    const snap = jarSnapshot();
    const all = [...snap.values()].flat();
    expect(all.filter((c) => c.domain === "login.microsoftonline.com").map((c) => c.name).sort())
      .toEqual(["ESTSAUTH", "ESTSSC", "LoginAttempts"].sort());
    expect(all.filter((c) => c.domain === "microsoftonline.com").map((c) => c.name)).toEqual(["CCState"]);
    expect(all.filter((c) => c.domain === "live.com").map((c) => c.name)).toEqual(["MSPRequ"]);
  });
});
