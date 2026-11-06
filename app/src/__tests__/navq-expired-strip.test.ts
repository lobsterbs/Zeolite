import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  decodeClientUrl,
  decodeQueryHandle,
  queryHandleToken,
  setRouteKey,
  setScheme,
} from "../codec";

/* #633: #558 stripped only LIVE origin-only zlNavh tokens, so a
   token past NAVH_TTL_MS (120 s) that still rode a re-minted
   destination was kept as an "impostor" and stacked one identical
   param per navigation cycle (the Google sign-in capture: three
   concatenated zlNavh tokens on one committed URL, then nested inside
   Google's own continue param). The fixed contract: expired engine
   tokens strip like live ones at the mint and never ride the decoded
   destination; page-authored impostors keep the documented ride. */

const ENGINE = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY);
});

afterEach(() => {
  setRouteKey(null);
  setScheme("/j/");
});

const expiredTok = () =>
  queryHandleToken(new URL(buildQueryHandleUrl("https://x.example/p?a=1", -1)!, ENGINE).search)!;
const liveTok = () =>
  queryHandleToken(new URL(buildQueryHandleUrl("https://x.example/live", 60_000)!, ENGINE).search)!;

describe("expired zlNavh strip (#633)", () => {
  it("the mint strips expired tokens; a decoded destination never re-stacks them", () => {
    const tok = expiredTok();
    /* the byte-exact capture shape: two stacked identical tokens plus
       a live one on the same committed search */
    const dest =
      "https://x.example/p?a=1&b=2&zlNavh=" + tok + "&zlNavh=" + tok + "&zlNavh=" + liveTok();
    const committed = buildQueryHandleUrl(dest)!;
    const cu = new URL(committed, ENGINE);
    expect(cu.searchParams.getAll("zlNavh")).toHaveLength(1);
    expect(cu.searchParams.get("a")).toBe("1");
    expect(cu.searchParams.get("b")).toBe("2");
  });

  it("the mint still strips a live token (#558 parity)", () => {
    const dest = "https://x.example/p?a=1&zlNavh=" + liveTok();
    const cu = new URL(buildQueryHandleUrl(dest)!, ENGINE);
    expect(cu.searchParams.getAll("zlNavh")).toHaveLength(1);
  });

  it("an impostor zlNavh param keeps riding at the mint", () => {
    const dest = "https://x.example/p?x=1&zlNavh=pagevalue";
    const cu = new URL(buildQueryHandleUrl(dest)!, ENGINE);
    const all = cu.searchParams.getAll("zlNavh");
    expect(all).toHaveLength(2);
    expect(all).toContain("pagevalue");
  });

  it("decodeQueryHandle drops an expired token; the live token names the page", () => {
    const u = new URL(
      "/p?a=1&zlNavh=" + expiredTok() + "&zlNavh=" + liveTok() + "&b=2",
      ENGINE,
    );
    expect(decodeQueryHandle(u)?.destination).toBe("https://x.example/p?a=1&b=2");
  });

  it("an all-expired search still fails closed (never an origin)", () => {
    const u = new URL("/p?zlNavh=" + expiredTok(), ENGINE);
    expect(decodeQueryHandle(u)).toBeNull();
    expect(decodeClientUrl(u)).toBeNull();
  });

  it("a page-authored impostor keeps riding the decoded destination (ride contract)", () => {
    const u = new URL(
      "/p?a=1&zlNavh=pagevalue&zlNavh=" + liveTok() + "&b=2",
      ENGINE,
    );
    expect(decodeQueryHandle(u)?.destination).toBe(
      "https://x.example/p?a=1&zlNavh=pagevalue&b=2",
    );
  });
});
