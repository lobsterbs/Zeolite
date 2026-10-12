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
import { NAV } from "../bootstrap/navguard";
import { navhTailDest } from "../request";
import { PAGE_MESSAGES, senderIsProxiedPath } from "../cpgate";

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

  it("appends via the context when the token expired (long-lived page)", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!; /* expired */
    expect(navhTailDest(tok + "/latest-commit", PAGE, true, decodeNavHandle)).toBe(
      "https://github.com/lobsterbs/Zeolite/latest-commit",
    );
  });

  it("resolves an expired new-shape tail as an absolute path via the context (#144)", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!; /* expired */
    expect(
      navhTailDest(tok + "/lobsterbs/Zeolite/latest-commit", PAGE + "?tab=readme", true, decodeNavHandle),
    ).toBe("https://github.com/lobsterbs/Zeolite/latest-commit");
  });

  it("strips the context URL query from the append base", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!;
    expect(navhTailDest(tok + "/latest-commit", PAGE + "?tab=readme", true, never)).toBe(
      "https://github.com/lobsterbs/Zeolite/latest-commit",
    );
  });

  it("keeps a trailing-slash context from doubling the slash", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!;
    expect(navhTailDest(tok + "/x.png", "https://example.com/dir/", true, never)).toBe(
      "https://example.com/dir/x.png",
    );
  });

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

  it("preserves percent-encoding in the suffix", () => {
    setRouteKey(KEY_A);
    const tok = encodeNavHandle(PAGE, -1)!;
    expect(navhTailDest(tok + "/a%20b.png", PAGE, true, never)).toBe(
      "https://github.com/lobsterbs/Zeolite/a%20b.png",
    );
  });
});

describe("handle URL shape (#144: opaque host, visible path)", () => {
  it("mints NAVH/<token>/<real path> with the query on the route", () => {
    setRouteKey(KEY_A);
    const url = buildNavHandleUrl("https://secret.example/dir/page.html?q=1#frag")!;
    expect(url.startsWith(NAVH + "/")).toBe(true);
    expect(url.endsWith("/dir/page.html?q=1")).toBe(true);
    /* the host never appears; the path does (the #144 decision) */
    expect(url).not.toContain("secret.example");
    expect(url).not.toContain("#");
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
