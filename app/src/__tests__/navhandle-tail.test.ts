import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  b64uEncode,
  buildNavHandleUrl,
  buildQueryHandleUrl,
  decodeNavHandle,
  decodeNavHandlePath,
  encodeNavHandle,
  NAVH,
  queryHandleToken,
  setRouteKey,
  setScheme,
} from "../codec";
import { forwardedHeaders } from "../request";

/* #612: a navguard NAV marker inside a NAVH handle tail is an
   engine route the page re-anchored, never a site path - composing
   the minted origin with the marker dialed
   <site>/__zl_nav__/<b64> upstream (the google.com 404). #633: an
   expired handle whose MAC still verifies recovers derived context
   (Referer, initiator, widget page-url params) through
   opts.expired - the #385 trust - while committed decode stays
   live-only. */
const ENGINE = "https://lobsterbrowse-content.example.com";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));
const DEST = "https://www.google.com/";
const MARKED = "https://www.google.com/webhp?hl=en";
const marker = (dest: string) => "__zl_nav__/" + b64uEncode(new TextEncoder().encode(dest));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY);
});

describe("decodeNavHandlePath marker tails (#612)", () => {
  it("decodes a navguard marker tail instead of composing a site path", () => {
    const url = buildNavHandleUrl(DEST)!;
    const tail = url.slice(NAVH.length + 1) + "/" + marker(MARKED);
    expect(decodeNavHandlePath(tail)).toBe(MARKED);
  });

  it("decodes a marker inside a peeled prel virtual path", () => {
    const url = buildNavHandleUrl("https://www.google.com/maps")!;
    const tail =
      url.slice(NAVH.length + 1).split("?")[0] +
      "/real/__zl_prel__/" +
      encodeURIComponent("/" + marker(MARKED));
    expect(decodeNavHandlePath(tail)).toBe(MARKED);
  });

  it("keeps composing a marker-shaped tail that does not decode", () => {
    const url = buildNavHandleUrl(DEST)!;
    const tail = url.slice(NAVH.length + 1) + "/__zl_nav__/%zz";
    const res = decodeNavHandlePath(tail);
    expect(res).toBeTruthy();
    expect(res!.startsWith("https://www.google.com/")).toBe(true);
    expect(res!.indexOf("__zl_nav__/%zz") > 0).toBe(true);
  });
});

describe("expired handle context recovery (#633)", () => {
  it("keeps committed decode refusing expired tokens", () => {
    const token = encodeNavHandle("https://secret.example", -1)!;
    expect(token).toBeTruthy();
    expect(decodeNavHandle(token)).toBeNull();
    expect(decodeNavHandlePath(token + "/private")).toBeNull();
  });

  it("recovers destination and tail for derived context", () => {
    const token = encodeNavHandle("https://secret.example", -1)!;
    expect(decodeNavHandle(token, {expired: true})).toBe("https://secret.example");
    expect(decodeNavHandlePath(token + "/private", {expired: true})).toBe("https://secret.example/private");
  });
});

describe("forwardedHeaders expired-navh referrer (#633)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives the Referer from an expired handle", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const token = encodeNavHandle("https://accounts.example", -1)!;
    const ref = ENGINE + NAVH + "/" + token + "/signin?state=1";
    const req = new Request(ENGINE + "/x", { method: "POST", referrer: ref });
    const out = forwardedHeaders(req, "https://accounts.example/rpc");
    expect(out.get("referer")).toBe("https://accounts.example/signin?state=1");
  });

  it("keeps omitting the Referer for a tampered handle", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const token = encodeNavHandle("https://accounts.example", -1)!;
    const bad = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const ref = ENGINE + NAVH + "/" + bad + "/signin?state=1";
    const req = new Request(ENGINE + "/x", { method: "POST", referrer: ref});
    const out = forwardedHeaders(req, "https://accounts.example/rpc");
    expect(out.get("referer")).toBeNull();
  });
});

describe("forwardedHeaders expired query-route referrer (#633)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives the Referer from an expired committed query route", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const committed = new URL(buildQueryHandleUrl("https://accounts.example/signin?state=1", -1)!, ENGINE).href;
    const req = new Request(ENGINE + "/x", { method: "POST", referrer: committed });
    const out = forwardedHeaders(req, "https://accounts.example/rpc");
    expect(out.get("referer")).toBe("https://accounts.example/signin?state=1");
  });

  it("keeps omitting the Referer for a tampered query-route token", () => {
    vi.stubGlobal("self", { location: { origin: ENGINE } });
    const u = new URL(buildQueryHandleUrl("https://accounts.example/signin", -1)!, ENGINE);
    const tok = queryHandleToken(u.search)!;
    u.searchParams.set("zlNavh", tok.slice(0, -2) + (tok.endsWith("aa") ? "bb" : "aa"));
    const req = new Request(ENGINE + "/x", { method: "POST", referrer: u.href });
    const out = forwardedHeaders(req, "https://accounts.example/rpc");
    expect(out.get("referer")).toBeNull();
  });
});
