import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  b64uEncode,
  referrerDest,
  setRouteKey,
  setScheme,
} from "../codec";
import { forwardedHeaders } from "../request";

/* #425/#633: the navguard popup marker (/__zl_nav__/<b64u of the full
   destination>) is an engine route that decodeClientUrl resolves, but
   the Referer seam in forwardedHeaders only walked decodePath / NAVH /
   query-handle / legacy-/zl/ arms. A subresource issued from a page
   parked on a marker route (pane navigations keep the in-place marker
   serve) therefore went upstream Referer-less and logged "engine-route
   referrer did not decode; Referer omitted" - Google's sign-in backend
   answers a Referer-less identifier RPC with the generic rejection.
   The marker arm must decode the b64u payload to its http(s)
   destination and union the marker URL's own search (mergeRouteSearch
   semantics), and fail closed on a tampered payload. */

const ENGINE = "https://lobsterbrowse-content.example.com";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const NAV = "/__zl_nav__";
const IDENT =
  "https://accounts.google.com/v3/signin/identifier?dsh=S-1761130629:1793778643509732&flowName=GlifWebSignIn&flowEntry=ServiceLogin&passive=true";

const marker = (dest: string) => NAV + "/" + b64uEncode(new TextEncoder().encode(dest));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY);
});

afterEach(() => {
  setRouteKey(null);
  setScheme("/j/");
  vi.unstubAllGlobals();
});

describe("forwardedHeaders NAV-marker referrer (#425)", () => {
  it("derives the Referer from a marker-referrer page, query intact", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const req = new Request(ENGINE + "/j/AAAA", {
      method: "POST",
      referrer: ENGINE + marker(IDENT),
    });
    const out = forwardedHeaders(req, "https://accounts.google.com/batchexecute?rpcids=MI613e");
    expect(out.get("referer")).toBe(IDENT);
  });

  it("unions the marker URL's own search onto the decoded payload", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const req = new Request(ENGINE + "/j/AAAA", {
      method: "GET",
      referrer: ENGINE + marker("https://accounts.google.com/signin") + "?sso_reload=true",
    });
    const out = forwardedHeaders(req, "https://accounts.google.com/x");
    expect(out.get("referer")).toBe("https://accounts.google.com/signin?sso_reload=true");
  });

  it("fails closed on a tampered marker payload (Referer omitted, never guessed)", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const bad = marker("https://evil.example/");
    const req = new Request(ENGINE + "/j/AAAA", {
      method: "POST",
      referrer: ENGINE + bad.slice(0, -2) + (bad.endsWith("aa") ? "bb" : "aa"),
    });
    const out = forwardedHeaders(req, "https://accounts.google.com/batchexecute");
    expect(out.get("referer")).toBeNull();
  });

  it("fails closed on a non-http marker payload", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const req = new Request(ENGINE + "/j/AAAA", {
      method: "POST",
      referrer: ENGINE + marker("javascript:alert(1)"),
    });
    const out = forwardedHeaders(req, "https://accounts.google.com/batchexecute");
    expect(out.get("referer")).toBeNull();
  });
});

describe("referrerDest NAV-marker referrer (#425)", () => {
  it("resolves a relative tail against the marker's decoded home", () => {
    expect(referrerDest(ENGINE + marker(IDENT), "/batchexecute?rpcids=MI613e")).toBe(
      "https://accounts.google.com/batchexecute?rpcids=MI613e",
    );
    expect(referrerDest(ENGINE + marker(IDENT), "img/logo.png")).toBe(
      "https://accounts.google.com/v3/signin/img/logo.png",
    );
  });

  it("fails closed on a tampered marker referrer", () => {
    const bad = marker("https://accounts.google.com/");
    expect(referrerDest(ENGINE + bad.slice(0, -2) + "zz", "/x")).toBeNull();
  });
});
