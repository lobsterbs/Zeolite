import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  NAVH_TTL_MS,
  queryHandleToken,
  referrerDest,
  setRouteKey,
  setScheme,
} from "../codec";

/* #708 reopened (the bare-src bscframe class, live on pin 211): a
   query-shape committed page (real path + zlNavh in the search) must
   name its virtual home at the referrer seam. Google's sign-in page,
   committed at the engine-origin root with its zlNavh in the search,
   creates its botguard frame with a relative src="/_/bscframe" that no
   rewriter arm minted, so the parser-initiated subframe navigation
   arrives context-less: no client id carries a context, and the
   referrer's pathname is the bare committed path, not an engine route.
   referrerDest returned null, the SW answered the honest escape
   (same-origin unknown home), and the content origin's SPA catch-all
   served the shell into the botguard frame - a page-visible bot tell.
   The query-handle arm decodes the referrer's live MAC-verified token,
   peels any prel tail on the referrer's own path, strips the token from
   the resolved home, and fails closed on impostors, wrong-key tokens,
   expired tokens and engine-shaped referrer pathnames. */

const ENGINE = "https://lobsterbrowse-content.example.com";
const SITE = "https://accounts.google.com";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i + 1));

/* The committed referrer form: the engine's own mint, token included.
   Returns the full referrer URL string plus its raw token. */
function committedRef(dest: string): { ref: string; tok: string } {
  const url = buildQueryHandleUrl(dest, NAVH_TTL_MS);
  if (url === null) throw new Error("mint failed (no route key)");
  const full = ENGINE + url;
  const tok = queryHandleToken(new URL(full).search);
  if (tok === null) throw new Error("minted URL carries no zlNavh");
  return { ref: full, tok };
}

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY);
});

afterEach(() => {
  setRouteKey(null);
  setScheme("/j/");
  vi.useRealTimers();
});

describe("referrerDest query-handle referrer (#708 bare-src class)", () => {
  it("resolves the bare /_/bscframe subframe src against the engine-root page's home (the captured shape)", () => {
    /* the live sign-in shape: the page sits at the origin root, its
       token names accounts.google.com, and the botguard frame's bare
       src resolves against that virtual home */
    const { ref } = committedRef(SITE + "/");
    expect(new URL(ref).pathname).toBe("/");
    expect(referrerDest(ref, "/_/bscframe")).toBe(SITE + "/_/bscframe");
  });

  it("resolves a deep committed page and keeps directory semantics for relative tails", () => {
    const { ref } = committedRef(
      SITE + "/v3/signin/identifier?dsh=S-1:2&flowEntry=ServiceLogin",
    );
    expect(referrerDest(ref, "/_/bscframe")).toBe(SITE + "/_/bscframe");
    expect(referrerDest(ref, "img/logo.png")).toBe(
      SITE + "/v3/signin/img/logo.png",
    );
  });

  it("strips the token from the resolved home and keeps the page's real query", () => {
    const { ref } = committedRef(SITE + "/v3/signin/identifier?dsh=S-1:2");
    const home = referrerDest(ref, "");
    expect(home).toContain("dsh=S-1:2");
    expect(home).not.toContain("zlNavh=");
  });

  it("peels a prel tail on the referrer's own committed path", () => {
    const { tok } = committedRef(SITE + "/_/bscframe");
    const ref =
      ENGINE +
      "/_/bscframe/__zl_prel__/" +
      encodeURIComponent("/x") +
      "?zlNavh=" +
      tok;
    expect(referrerDest(ref, "img/y.png")).toBe(SITE + "/img/y.png");
  });

  it("fails closed on a tampered token", () => {
    const { ref, tok } = committedRef(SITE + "/");
    const bad = ref.replace(tok, tok.slice(0, -2) + (tok.endsWith("aa") ? "bb" : "aa"));
    expect(referrerDest(bad, "/_/bscframe")).toBeNull();
  });

  it("fails closed on an expired token (the referrer arm is live-only)", () => {
    /* mint at the real clock, then advance past the TTL: the referrer
       arm must not grant reach a live page no longer has */
    const { ref } = committedRef(SITE + "/");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + NAVH_TTL_MS + 60_000);
    expect(referrerDest(ref, "/_/bscframe")).toBeNull();
  });

  it("fails closed on an engine-shaped referrer pathname (the path arms own it)", () => {
    const { tok } = committedRef(SITE + "/");
    expect(referrerDest(ENGINE + "/j/AAAA?zlNavh=" + tok, "/x")).toBeNull();
  });
});
