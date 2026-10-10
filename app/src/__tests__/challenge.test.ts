import { describe, expect, it } from "vitest";
import { isPassChallenge } from "../cookies";
import { b64uEncode, encodeDest, encodeDestLegacy, passChallengeRedirFixed, setRouteKey } from "../codec";

/* Issue #52: detect-only recognition of the Anubis pass-challenge
   endpoint. The engine never solves challenges; this is the seam that
   lets the SW flag a solved challenge handing cookies back. */
describe("isPassChallenge (#52)", () => {
  it("recognizes the pass-challenge endpoint on any host", () => {
    expect(isPassChallenge("https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge")).toBe(true);
    expect(isPassChallenge("http://host.example/.within.website/x/cmd/anubis/api/pass-challenge?redir=%2F")).toBe(true);
    expect(isPassChallenge("https://anubis.example/.within.website/x/cmd/anubis/api/pass-challenge#")).toBe(true);
  });

  it("rejects lookalikes and extra path segments", () => {
    expect(isPassChallenge("https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge/extra")).toBe(false);
    expect(isPassChallenge("https://startpage.com/x/cmd/anubis/api/pass-challenge")).toBe(false);
    expect(isPassChallenge("https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge-other")).toBe(false);
    expect(isPassChallenge("https://startpage.com/")).toBe(false);
  });

  it("handles non-URLs honestly", () => {
    expect(isPassChallenge("")).toBe(false);
    expect(isPassChallenge("not a url")).toBe(false);
  });
});

/* The #52 handoff gap the server-side bridge closes for /r/: the
   rewriter maps the challenge page's return URL into an engine route,
   and the upstream anubis deployment rejects a redir outside its
   allowlist (redirect_domain_not_allowed), failing verification right
   after the challenge completes. passChallengeRedirFixed decodes the
   route and carries the plaintext upstream URL instead. */
describe("passChallengeRedirFixed (#52 handoff)", () => {
  const ORIGIN = "https://proxy.example";
  const pc = (redir: string) =>
    "https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge?redir=" +
    encodeURIComponent(redir);

  it("rewrites a legacy engine route redir to the upstream URL", () => {
    const route = encodeDestLegacy("https://startpage.com/sp/search");
    const fixed = passChallengeRedirFixed(pc(route), ORIGIN);
    expect(fixed).not.toBeNull();
    expect(new URL(fixed!).searchParams.get("redir")).toBe("https://startpage.com/sp/search");
  });

  it("keeps the route-carried query on the upstream URL", () => {
    const route = encodeDestLegacy("https://startpage.com/sp/search") + "?query=test";
    const fixed = passChallengeRedirFixed(pc(route), ORIGIN);
    expect(new URL(fixed!).searchParams.get("redir")).toBe(
      "https://startpage.com/sp/search?query=test",
    );
  });

  it("decodes a keyed route redir with the active key", () => {
    setRouteKey(b64uEncode(crypto.getRandomValues(new Uint8Array(16))));
    const route = encodeDest("https://startpage.com/sp/search");
    const fixed = passChallengeRedirFixed(pc(route), ORIGIN);
    expect(new URL(fixed!).searchParams.get("redir")).toBe("https://startpage.com/sp/search");
    setRouteKey(null);
  });

  it("returns null for non-engine redirs and non-URLs", () => {
    expect(passChallengeRedirFixed(pc("/sp/search"), ORIGIN)).toBeNull();
    expect(
      passChallengeRedirFixed("https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge", ORIGIN),
    ).toBeNull();
    expect(passChallengeRedirFixed("not a url", ORIGIN)).toBeNull();
  });
});

/* anubis >= 1.26 emits redir as window.location.href: an ABSOLUTE
   URL on the engine origin carrying the rewritten route. The live
   startpage case: redir must decode through the same pipeline and
   hand anubis its own-origin page URL. */
describe("passChallengeRedirFixed (absolute engine URL, anubis 1.26+)", () => {
  const ORIGIN = "https://proxy.example";
  const pcAbs = (route: string) =>
    "https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge?redir=" +
    encodeURIComponent(ORIGIN + route);

  it("rewrites an absolute engine-origin URL redir to the upstream URL", () => {
    const route = encodeDestLegacy("https://www.startpage.com/sp/search?query=eiffel+tower");
    const fixed = passChallengeRedirFixed(pcAbs(route), ORIGIN);
    expect(fixed).not.toBeNull();
    expect(new URL(fixed!).searchParams.get("redir")).toBe(
      "https://www.startpage.com/sp/search?query=eiffel+tower",
    );
  });

  it("keeps a query carried on the absolute route", () => {
    const route = encodeDestLegacy("https://startpage.com/sp/search") + "?query=test";
    const fixed = passChallengeRedirFixed(pcAbs(route), ORIGIN);
    expect(new URL(fixed!).searchParams.get("redir")).toBe(
      "https://startpage.com/sp/search?query=test",
    );
  });

  it("refuses an absolute redir on a foreign origin", () => {
    const route = encodeDestLegacy("https://startpage.com/sp/search");
    const foreign =
      "https://startpage.com/.within.website/x/cmd/anubis/api/pass-challenge?redir=" +
      encodeURIComponent("https://evil.example" + route);
    expect(passChallengeRedirFixed(foreign, ORIGIN)).toBeNull();
  });
});
