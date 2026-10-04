import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uDecode,
  b64uEncode,
  decodeNavHandle,
  decodePath,
  encodeDest,
  encodeNavHandle,
  mintableDest,
  setRouteKey,
  setRouteKeys,
  setScheme,
} from "../codec";
import { NAV } from "../bootstrap/navguard";
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
    expect(decodeNavHandle(token)).toBe(dest);
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
    expect(decodeNavHandle(token)).toBe("https://rotate.example/page");
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
