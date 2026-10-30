import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  decodeQueryHandle,
  setRouteKey,
  setScheme,
} from "../codec";

/* Issue #558: the committed query-route URL stacked identical zlNavh
   handles, one per navigation cycle (the google.com homepage committed
   URL read ?zlNavh=A&zlNavh=A&zx=<ts>&zlNavh=A live in the beta). The
   decode removed only the FIRST MAC-verifying occurrence, so a live
   token rode the decoded destination's search; the next commit minted
   a fresh token for that destination and appended it on top - and
   because the token MACs the origin and the TTL bucket, the re-mint
   reproduced the SAME token bytes, so the committed URL grew one
   identical zlNavh per cycle. These tests pin both ends of the loop:
   the decode strips EVERY verifying occurrence (page-authored
   impostors keep riding, the documented contract), and the mint never
   re-emits a search that still carries a live one. */

const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i + 7));
const ORIGIN = "https://www.google.com";

function qCommit(dest: string): string {
  const r = buildQueryHandleUrl(dest);
  if (r === null) throw new Error("mint failed (no route key?)");
  return r;
}

beforeEach(() => {
  setScheme("/zl/");
  setRouteKey(KEY);
});

describe("#558 stacked query handles", () => {
  it("decode strips every verifying occurrence of the token", () => {
    const c0 = qCommit(ORIGIN + "/");
    expect(c0.startsWith("/?zlNavh=")).toBe(true);
    const tok = c0.slice("/?zlNavh=".length);
    /* the stacked form seen live: the same token three times around
       google's zx cache-buster */
    const stacked =
      "/?zlNavh=" + tok + "&zlNavh=" + tok + "&zx=1793398559777&zlNavh=" + tok;
    const d = decodeQueryHandle(new URL("https://engine.example" + stacked));
    expect(d).not.toBeNull();
    expect(d!.destination).toBe(ORIGIN + "/?zx=1793398559777");
  });

  it("mint never re-emits a search that still carries a live token", () => {
    const c0 = qCommit(ORIGIN + "/?a=1");
    /* a page that joins its own committed search into a new
       destination: the live token rides the destination query */
    const dest2 = ORIGIN + c0;
    const c1 = qCommit(dest2);
    const n = c1.split("zlNavh=").length - 1;
    expect(n).toBe(1);
    /* and the decoded destination is the clean one */
    const d = decodeQueryHandle(new URL("https://engine.example" + c1));
    expect(d).not.toBeNull();
    expect(d!.destination).toBe(ORIGIN + "/?a=1");
  });

  it("a page-authored impostor zlNavh survives mint and decode byte-for-byte", () => {
    const dest = ORIGIN + "/search?q=x&zlNavh=not-a-token";
    const c = qCommit(dest);
    expect(c).toContain("zlNavh=not-a-token");
    const d = decodeQueryHandle(new URL("https://engine.example" + c));
    expect(d).not.toBeNull();
    expect(d!.destination).toBe(ORIGIN + "/search?q=x&zlNavh=not-a-token");
  });
});
