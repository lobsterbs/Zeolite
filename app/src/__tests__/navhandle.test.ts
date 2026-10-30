import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uDecode,
  b64uEncode,
  buildNavHandleUrl,
  decodeClientUrl,
  decodeNavHandle,
  decodeNavHandlePath,
  decodePath,
  encodeDest,
  encodeNavHandle,
  mintableDest,
  NAVH,
  setRouteKey,
  setRouteKeys,
  setScheme,
} from "../codec";
import { NAV, navEncode } from "../bootstrap/navguard";
import { challengeReanchorUrl, derefSelfRoute, navhTailDest, navpResolve } from "../request";
import { PAGE_MESSAGES, senderIsHostPage, senderIsProxiedPath } from "../cpgate";

/* Issue #63 (#54 design D): the opaque initial-navigation handle.
   The host asks the SW for a handle over zl:navHandle and navigates a
   frame to /__zl_navh__/<token>, so the initial embed never carries
   the destination decodably. These tests pin the codec contract:
   roundtrip, TTL expiry, tamper-failure, restart/rotation survival,
   and the disjointness from route tokens in both directions. The
   gate tests pin the #41 side: zl:navHandle must never join
   PAGE_MESSAGES, so a proxied page cannot mint handles. */

const KEY_A = b64uEncode(new Uint8Array(16).map((_, i) => i));
const KEY_B = b64uEncode(new Uint8Array(16).map((_, i) => 255 - i));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(null);
});

describe("navigation handle codec (#63)", () => {
  it("roundtrips a mintable destination as an opaque token", () => {
    setRouteKey(KEY_A);
    const dest = "https://secret.example/private?q=1";
    const token = encodeNavHandle(dest)!;
    expect(token).toBeTruthy();
    /* #144: the payload carries the origin only; the path and query
       ride as the visible handle-URL suffix. */
    expect(decodeNavHandle(token)).toBe("https://secret.example");
    /* the handle URL mints its own token (the expiry is embedded, so
       two mints differ); pin the shape and the decodable suffix */
    const url = buildNavHandleUrl(dest)!;
    expect(url.startsWith(NAVH + "/")).toBe(true);
    expect(url.endsWith("/private?q=1")).toBe(true);
    expect(decodeNavHandle(url.slice(NAVH.length + 1).split("/")[0])).toBe("https://secret.example");
    expect(decodeNavHandlePath(token + "/private")).toBe("https://secret.example/private");
    expect(decodeNavHandle(token + "/private")).toBeNull();
    /* The token never carries the destination decodably: the payload
       is keystream-XORed, so the legacy decode of the tail bytes
       reveals nothing. */
    expect(new TextDecoder().decode(b64uDecode(token)!)).not.toContain("secret.example");
  });

  it("expires past its TTL window", () => {
    setRouteKey(KEY_A);
    const token = encodeNavHandle("https://example.com/", -1)!;
    expect(decodeNavHandle(token)).toBeNull();
  });

  it("refuses without a route key or a non-mintable destination", () => {
    expect(encodeNavHandle("https://example.com/")).toBeNull();
    setRouteKey(KEY_A);
    expect(encodeNavHandle("/relative")).toBeNull();
    expect(encodeNavHandle("javascript:alert(1)")).toBeNull();
  });

  it("fails closed on a tampered token", () => {
    setRouteKey(KEY_A);
    const bytes = b64uDecode(encodeNavHandle("https://example.com/")!)!;
    bytes[20] ^= 0xff;
    expect(decodeNavHandle(b64uEncode(bytes))).toBeNull();
  });

  it("survives a SW restart and a key rotation (decode walks history)", () => {
    setRouteKey(KEY_A);
    const token = encodeNavHandle("https://rotate.example/page")!;
    /* Restart with rotation: the fresh worker mints under KEY_B but
       loads the full history, so a handle minted before either event
       still navigates - nothing was persisted, nothing strands. */
    setRouteKeys([KEY_B, KEY_A]);
    expect(decodeNavHandle(token)).toBe("https://rotate.example");
    /* A history that never held the minting key fails closed. */
    setRouteKeys([KEY_B]);
    expect(decodeNavHandle(token)).toBeNull();
  });

  it("is disjoint from route tokens in both directions", () => {
    setRouteKey(KEY_A);
    /* A route token's payload is an http(s) URL, never the handle
       tag: the NAVH route must not accept it. */
    const routeTail = encodeDest("https://example.com/").slice("/j/".length).split(/[?#]/)[0];
    expect(decodeNavHandle(routeTail)).toBeNull();
    /* A handle token's payload is the navh tag, never http(s): the
       engine route must not accept it either. */
    const handleToken = encodeNavHandle("https://example.com/")!;
    expect(decodePath("/j/" + handleToken)).toBeNull();
  });
});

describe("navHandle sender gate (#41/#63)", () => {
  it("zl:navHandle is not a page-facing control message", () => {
    expect(PAGE_MESSAGES.has("zl:navHandle")).toBe(false);
    /* The page-facing surface itself stays as pinned by #54/#41. */
    expect(PAGE_MESSAGES.has("zl:mint")).toBe(true);
    expect(PAGE_MESSAGES.has("zl:getNetLog")).toBe(false);
  });

  it("classifies proxied-path senders, not host pages", () => {
    expect(senderIsProxiedPath("/j/abc")).toBe(true); // engine route
    expect(senderIsProxiedPath("/")).toBe(false); // host page (the embedder app)
    expect(senderIsProxiedPath("/index.html")).toBe(false);
    expect(senderIsProxiedPath(NAV + "/tail")).toBe(true); // navguard marker
    expect(senderIsProxiedPath("/zl-ext/id/page.html")).toBe(true); // extension page
    expect(senderIsProxiedPath("/zl-cs/id/script.js")).toBe(true); // content script
  });

  it("mintableDest still bounds handle destinations", () => {
    expect(mintableDest("https://example.com/")).toBe(true);
    expect(mintableDest("ftp://example.com/")).toBe(false);
  });
});

describe("navhTailDest (#143 follow-up: opaque-route relative recovery)", () => {
  const PAGE = "https://github.com/lobsterbs/Zeolite";
  const never = (_t: string): string | null => null;

  it("resolves a token-bearing suffix against the token origin (#144)", () => {
    setRouteKey(KEY_A);
    /* #144: the token carries the origin only; the tail is the real
       page path from the root. */
    const tok = encodeNavHandle(PAGE)!;
    expect(navhTailDest(tok + "/lobsterbs/Zeolite/latest-commit", null, true, decodeNavHandle)).toBe(
      "https://github.com/lobsterbs/Zeolite/latest-commit",
    );
  });

  it("resolves an expired token head's suffix against the context origin (#395)", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!; /* expired */
    /* #395: the tail after an expired token head is a full path from
       the root. The old page-path append base treated the document
       path as a directory and doubled it
       (/dir/page/dir/assets/x.js 404'd upstream). */
    expect(navhTailDest(tok + "/dir/assets/x.js", "https://h.example/dir/page", true, never)).toBe(
      "https://h.example/dir/assets/x.js",
    );
    /* the context path and query never leak into the base */
    expect(
      navhTailDest(tok + "/dir/assets/x.js", "https://h.example/dir/page?tab=1", true, never),
    ).toBe("https://h.example/dir/assets/x.js");
  });

  it("resolves an expired new-shape tail as an absolute path via the context (#144)", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!; /* expired */
    expect(
      navhTailDest(tok + "/lobsterbs/Zeolite/latest-commit", PAGE + "?tab=readme", true, decodeNavHandle),
    ).toBe("https://github.com/lobsterbs/Zeolite/latest-commit");
  });

  /* #395: the query-strip and trailing-slash append-base cases died
     with the page-path base; the origin base needs neither. */

  it("returns null for a token-shaped suffix tail with no context and a dead token", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!;
    expect(navhTailDest(tok + "/latest-commit", null, true, never)).toBeNull();
  });

  it("resolves a non-token tail with ordinary URL (directory) semantics", () => {
    expect(navhTailDest("img/x.png", "https://example.com/a/b/page.html", false, never)).toBe(
      "https://example.com/a/b/img/x.png",
    );
  });

  it("keeps the honest null for a token-shaped bare tail even with a context", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!; /* expired */
    expect(navhTailDest(tok, PAGE, true, decodeNavHandle)).toBeNull();
  });

  it("preserves percent-encoding in the suffix (#395 origin base)", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!;
    expect(navhTailDest(tok + "/a%20b.png", PAGE, true, never)).toBe(
      "https://github.com/a%20b.png",
    );
  });
});

describe("handle URL shape (#144: opaque host, visible path)", () => {
  it("mints NAVH/<token>/<real path> with the query and fragment on the route (#543)", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://secret.example/dir/page.html?q=1#frag")!;
    expect(url.startsWith(NAVH + "/")).toBe(true);
    expect(url.endsWith("/dir/page.html?q=1#frag")).toBe(true);
    /* the host never appears; the path and the fragment do - the
       #144 opacity decision keeps the host out, and #543 keeps the
       fragment on the committed URL so location.hash and fragment
       scroll match the direct control */
    expect(url).not.toContain("secret.example");
    /* the SW decode reads pathname+search only: the fragment never
       reaches the network target (fragments are never sent upstream) */
    const tok = url.slice(NAVH.length + 1).split("/")[0];
    expect(decodeNavHandlePath(tok + "/dir/page.html")).toBe("https://secret.example/dir/page.html");
  });

  it("decodeClientUrl joins the committed fragment (#543)", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://example.com/dir/page.html#sec")!;
    const d = decodeClientUrl(new URL(url, "https://engine.example"));
    expect(d).toBe("https://example.com/dir/page.html#sec");
    /* a payload fragment without a native one survives unchanged
       (the pre-#543 marker shape) */
    const m = navEncode("https://example.com/p#old");
    const dm = decodeClientUrl(new URL("https://engine.example" + m, "https://engine.example"));
    expect(dm).toBe("https://example.com/p#old");
  });

  it("omits the suffix for a bare-origin destination", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://example.com/")!;
    expect(url.startsWith(NAVH + "/")).toBe(true);
    expect(url.slice(NAVH.length + 1)).not.toContain("/");
    expect(decodeNavHandle(url.slice(NAVH.length + 1))).toBe("https://example.com");
  });

  it("resolves a suffix tail to the full destination", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle("https://example.com/dir/page.html")!;
    expect(decodeNavHandlePath(tok)).toBe("https://example.com");
    expect(decodeNavHandlePath(tok + "/dir/page.html")).toBe("https://example.com/dir/page.html");
  });

  it("keeps the honest null for expired or garbage tails", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle("https://example.com/x", -1)!;
    expect(decodeNavHandlePath(tok)).toBeNull();
    expect(decodeNavHandlePath("garbage!!/x")).toBeNull();
  });
});

describe("client-URL destination derivation (#151)", () => {
  it("resolves a /j/ route client to its destination", () => {
    setRouteKey(KEY_A);
    const path = encodeDest("https://example.com/dir/page.html?q=1");
    expect(decodeClientUrl(new URL("http://engine.example" + path))).toBe("https://example.com/dir/page.html?q=1");
  });

  it("resolves a NAVH client to its destination, not the token payload", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://example.com/dir/page.html?q=1")!;
    const u = new URL("http://engine.example" + url);
    expect(u.pathname.startsWith(NAVH + "/")).toBe(true);
    expect(decodeClientUrl(u)).toBe("https://example.com/dir/page.html?q=1");
  });

  it("falls back to the legacy /zl/ route when the prefix does not match (#107 phase 2)", () => {
    /* The content-origin SW never receives zl:config, so its prefix
       stays "/j/"; the LB split-origin navigation embeds legacy
       /zl/<b64u> routes there. decodePath refuses the tail; the
       reserved "zl" segment must still decode. */
    const tail = b64uEncode(
      new TextEncoder().encode("https://example.com/dir/page.html?q=1"),
    );
    expect(decodeClientUrl(new URL("http://engine.example/zl/" + tail))).toBe(
      "https://example.com/dir/page.html?q=1",
    );
  });

  it("keeps the honest null for undecodable clients", () => {
    setRouteKey(KEY_A);
    expect(decodeClientUrl(new URL("http://engine.example/not-a-route"))).toBeNull();
    const expired = buildNavHandleUrl("https://example.com/x", -1)!;
    expect(decodeClientUrl(new URL("http://engine.example" + expired))).toBeNull();
  });

  it("never coerces an undecodable client into the truthy string null", () => {
    setRouteKey(null);
    const u = new URL("http://engine.example/__zl_navh__/AAAAAAAAAAAAAAAA");
    expect(decodeClientUrl(u)).toBeNull();
    expect(decodeClientUrl(u) === "null").toBe(false);
  });

  it("classifies NAVH pages as proxied senders", () => {
    expect(senderIsProxiedPath(NAVH + "/token-abc")).toBe(true);
  });
});

describe("parent-relative route resolution (#101/#157)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("resolves a scheme-route parent with its tail", () => {
    setRouteKey(KEY_A);
    const parent = encodeDest("https://example.com/dir/page.html");
    expect(navpResolve(parent + "/__zl_prel__/" + encodeURIComponent("/img/logo.png"))).toBe("https://example.com/img/logo.png");
  });

  it("resolves a NAVH handle parent with its tail", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://example.com/dir/page.html")!;
    const path = url.split("?")[0] + "/__zl_prel__/" + encodeURIComponent("/error/e.gif?x=1");
    expect(navpResolve(path)).toBe("https://example.com/error/e.gif?x=1");
  });

  it("recovers an expired NAVH parent for its prel tail (#393)", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle("https://example.com/dir/page.html", -1)!; /* expired */
    const path =
      "/__zl_navh__/" + tok + "/dir/page.html/__zl_prel__/" + encodeURIComponent("/img/logo.png");
    expect(navpResolve(path)).toBe("https://example.com/img/logo.png");
  });

  it("keeps the honest null for a tampered expired NAVH parent (#393)", () => {
    setRouteKey(KEY_A);
    const bytes = b64uDecode(encodeNavHandle("https://example.com/dir/page.html", -1)!)!;
    bytes[20] ^= 0xff;
    const path =
      "/__zl_navh__/" +
      b64uEncode(bytes) +
      "/dir/page.html/__zl_prel__/" +
      encodeURIComponent("/img/logo.png");
    expect(navpResolve(path)).toBeNull();
  });

  it("resolves a NAV navigation-route parent with its tail", () => {
    const path =
      NAV +
      "/" +
      b64uEncode(new TextEncoder().encode("https://example.com/nav")) +
      "/__zl_prel__/" +
      encodeURIComponent("/a/b");
    expect(navpResolve(path)).toBe("https://example.com/a/b");
  });

  it("keeps the honest null for bad parents and malformed escapes", () => {
    setRouteKey(KEY_A);
    expect(navpResolve("/not-a-route/__zl_prel__/%2F")).toBeNull();
    expect(navpResolve("/j/abc/__zl_prel__/%zz")).toBeNull();
    expect(navpResolve("/j/abc")).toBeNull();
  });

  /* #157/#159: an absolute engine-origin tail strips to its path and
     re-resolves against the parent destination (pages re-state site
     paths through location.origin). */
  it("strips an engine-origin absolute tail to the site path", () => {
    setRouteKey(KEY_A);
    const parent = encodeDest("https://example.com/dir/page.html");
    expect(
      navpResolve(parent + "/__zl_prel__/" + encodeURIComponent("https://engine.host/img/logo.png"), "https://engine.host"),
    ).toBe("https://example.com/img/logo.png");
  });

  it("keeps a cross-origin absolute tail absolute", () => {
    setRouteKey(KEY_A);
    const parent = encodeDest("https://example.com/dir/page.html");
    expect(
      navpResolve(parent + "/__zl_prel__/" + encodeURIComponent("https://cdn.example.net/lib.js"), "https://engine.host"),
    ).toBe("https://cdn.example.net/lib.js");
  });

  it("strips the engine-origin tail on a NAVH parent too", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://example.com/dir/page.html")!;
    const path = url.split("?")[0] + "/__zl_prel__/" + encodeURIComponent("https://engine.host/error/e.gif?x=1");
    expect(navpResolve(path, "https://engine.host")).toBe("https://example.com/error/e.gif?x=1");
  });
});


/* #202: the tail after a handle token never escapes the minted
   origin. Separator-led and absolute tails are the honest null; a
   "//" pathname survives only through builder-side percent
   escaping. */
describe("NAVH tail origin binding (#202)", () => {
  it("rejects separator-led and absolute tails off the minted origin", () => {
    setRouteKey(KEY_A);
    const token = encodeNavHandle("https://site.example/")!;
    expect(decodeNavHandlePath(token + "//evil.example/steal")).toBeNull();
    expect(decodeNavHandlePath(token + "///evil.example/steal")).toBeNull();
    expect(decodeNavHandlePath(token + "/\\evil.example/x")).toBeNull();
    expect(decodeNavHandlePath(token + "/https://evil.example/x")).toBeNull();
    expect(decodeNavHandlePath(token + "https://evil.example/x")).toBeNull();
  });

  it("round-trips a double-slash pathname via builder-side escaping", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://site.example//evil.example/x")!;
    expect(url).not.toContain("//evil");
    expect(decodeClientUrl(new URL("http://engine.example" + url))).toBe(
      "https://site.example//evil.example/x",
    );
  });

  it("keeps ordinary tails and documents the %2F trade", () => {
    setRouteKey(KEY_A);
    const token = encodeNavHandle("https://site.example/")!;
    expect(decodeNavHandlePath(token + "/dir/page.html")).toBe(
      "https://site.example/dir/page.html",
    );
    /* ponytail: a genuine "%2F"-initial path decodes to the "//"
       form; the double-slash pathname is the real-world case. */
    const url = buildNavHandleUrl("https://example.com/%2Ffoo")!;
    expect(decodeClientUrl(new URL("http://engine.example" + url))).toBe(
      "https://example.com//foo",
    );
  });
});



describe("senderIsHostPage (#170: the host gate fails closed)", () => {
  const O = "http://engine.example";
  it("accepts only the engine's host pages", () => {
    expect(senderIsHostPage(O + "/", O)).toBe(true);
    expect(senderIsHostPage(O + "/index.html", O)).toBe(true);
    expect(senderIsHostPage(O + "/devtools.html", O)).toBe(true);
    /* The LB adapter is a single-page app at "/": query strings do not
       change the pathname. */
    expect(senderIsHostPage(O + "/?view=browser", O)).toBe(true);
    /* #107 phase 2: the LB split-origin boot page, embedded on the
       content origin; its relay/wisp/embedder registration is
       host-only control traffic and must pass the gate. */
    expect(senderIsHostPage(O + "/zlsw-register", O)).toBe(true);
  });
  it("refuses proxied routes and extension code", () => {
    expect(senderIsHostPage(O + "/j/abc", O)).toBe(false);
    expect(senderIsHostPage(O + "/zl-ext/x.js", O)).toBe(false);
    expect(senderIsHostPage(O + "/zl-cs/x.js", O)).toBe(false);
    expect(senderIsHostPage(O + NAVH + "/token", O)).toBe(false);
  });
  it("fails closed on opaque, unknown or cross-origin senders", () => {
    expect(senderIsHostPage("about:blank", O)).toBe(false);
    expect(senderIsHostPage("about:srcdoc", O)).toBe(false);
    expect(senderIsHostPage("blob:" + O + "/uuid", O)).toBe(false);
    expect(senderIsHostPage("data:text/html,hi", O)).toBe(false);
    expect(senderIsHostPage(O + "/app/unknown", O)).toBe(false);
    expect(senderIsHostPage("https://evil.example/", O)).toBe(false);
  });
});

/* The prel peel: a handle route carrying a #101 re-anchor tail is
   the newer virtual state, SW-side parity with vloc's fromNative.
   Live class (google.com/ai): vloc minted a prel-of-prel (the page
   re-emitted its own opaque route), navpResolve stripped the outer
   layer and decodeNavHandlePath read the remaining tail verbatim,
   serving the engine markers upstream as a Google 404. */
describe("prel tail on the handle route (google.com/ai reload class)", () => {
  it("peels a prel tail to the newer virtual state", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle("https://example.com/ai")!;
    expect(
      decodeNavHandlePath(tok + "/ai/__zl_prel__/" + encodeURIComponent("/search?udm=50")),
    ).toBe("https://example.com/search?udm=50");
  });

  it("peels a stacked tail to the deepest virtual state", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle("https://example.com")!;
    const inner = "/__zl_navh__/" + tok + "/ai/__zl_prel__/" + encodeURIComponent("/search?q=1");
    const tail = "/__zl_navh__/" + tok + "/ai/__zl_prel__/" + encodeURIComponent(inner);
    expect(decodeNavHandlePath(tail.slice(NAVH.length + 1))).toBe(
      "https://example.com/search?q=1",
    );
  });

  it("resolves the evidenced reload URL through navpResolve + derefSelfRoute", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle("https://example.com")!;
    const inner =
      "/__zl_navh__/" + tok + "/ai/__zl_prel__/" + encodeURIComponent("/search?udm=50&aep=11");
    const path = "/__zl_navh__/" + tok + "/ai/__zl_prel__/" + encodeURIComponent(inner);
    const dest = navpResolve(path)!;
    expect(dest).toContain(NAVH);
    expect(derefSelfRoute(dest, "https://engine.example")).toBe(
      "https://example.com/search?udm=50&aep=11",
    );
  });

  it("keeps the honest null for a non-virtual prel tail", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle("https://example.com/dir")!;
    expect(
      decodeNavHandlePath(
        tok + "/sub/__zl_prel__/" + encodeURIComponent("https://evil.example/x"),
      ),
    ).toBeNull();
  });
});

describe("navpResolve (#508/#492-class parked prels and route candidates)", () => {
  it("resolves a prel against the handle-derived base when the parent is an engine path", () => {
    const path =
      "/.within.website/x/cmd/anubis/api/pass-challenge/__zl_prel__/" + encodeURIComponent("/sp/favicon?fqdn=x");
    expect(navpResolve(path, undefined, "https://example.com/sp/search?query=lawn")).toBe(
      "https://example.com/sp/favicon?fqdn=x",
    );
  });
  it("still fails closed without a fallback base on an undecodable parent", () => {
    const path = "/not-a-route/__zl_prel__/" + encodeURIComponent("/img/x.png");
    expect(navpResolve(path, undefined, null)).toBeNull();
    expect(navpResolve(path)).toBeNull();
  });
  it("decodes a route-shaped candidate directly instead of resolving it against the parent", () => {
    setRouteKey(KEY_A);
    const route = encodeDest("https://example.com/a/b.png");
    const path = "/x/__zl_prel__/" + encodeURIComponent(route);
    expect(navpResolve(path, undefined, "https://parent.example/")).toBe("https://example.com/a/b.png");
  });
  it("recovers a concatenated-token candidate (<token><plaintext>)", () => {
    setRouteKey(KEY_A);
    const glued = encodeDest("http://") + "www.startpage.com/sp/afs/ads/i/iframe.html";
    const path = "/x/__zl_prel__/" + encodeURIComponent(glued);
    expect(navpResolve(path, undefined, "https://example.com/")).toBe(
      "http://www.startpage.com/sp/afs/ads/i/iframe.html",
    );
  });
});
describe("challengeReanchorUrl (#492-class handoff re-anchor)", () => {
  it("mints a visible handle form for the repaired redir destination", () => {
    setRouteKey(KEY_A);
    const fixed =
      "https://anubis.test/x/cmd/anubis/api/pass-challenge?id=1&redir=" +
      encodeURIComponent("https://example.com/sp/search?query=lawn");
    const out = challengeReanchorUrl(fixed);
    expect(out).toBeTruthy();
    expect(out).toContain("/sp/search?query=lawn");
  });
  it("falls back to the plain opaque route without a route key", () => {
    setRouteKey(null);
    const fixed =
      "https://anubis.test/x/cmd/anubis/api/pass-challenge?redir=" + encodeURIComponent("https://example.com/sp/search");
    expect(challengeReanchorUrl(fixed)).toBe(encodeDest("https://example.com/sp/search"));
  });
  it("returns null for unrepairable shapes", () => {
    expect(challengeReanchorUrl("https://anubis.test/pass-challenge")).toBeNull();
    expect(challengeReanchorUrl("not a url")).toBeNull();
  });
});


describe("guest registration gate (#477 wave 3)", () => {
  it("the swshim forward types are page-facing; spawn and host stay host-only", () => {
    expect(PAGE_MESSAGES.has("zl:guestRegister")).toBe(true);
    expect(PAGE_MESSAGES.has("zl:guestUnregister")).toBe(true);
    expect(PAGE_MESSAGES.has("zl:guestSpawn")).toBe(false);
    expect(PAGE_MESSAGES.has("zl:guestHost")).toBe(false);
  });

  it("the guest-host page is a host page", () => {
    const O = "http://engine.example";
    expect(senderIsHostPage(O + "/guest-host.html", O)).toBe(true);
  });
});
