import { describe, expect, it } from "vitest";
import { csAuthOk, mintCsAuth } from "../serve";

/* #517/#336: content-script channel secrets. The bridge and the
   scripting listener authenticate every zl:ext post with a secret
   minted when their script was served; page scripts share the page's
   client id but never see the secret, so an unauthenticated post is
   a page forgery. These pins cover the binding, the scripting
   wildcard binding, the refusals, the LRU refresh and the cap. */

function flush(): void {
  for (let i = 0; i < 600; i++) mintCsAuth("flush-" + i, "e");
}

describe("#517 content-script channel secrets", () => {
  it("binds a secret to its client and extension", () => {
    const s = mintCsAuth("client-1", "ext-a");
    expect(csAuthOk("client-1", "ext-a", s)).toBe(true);
    expect(csAuthOk("client-2", "ext-a", s)).toBe(false);
    expect(csAuthOk("client-1", "ext-b", s)).toBe(false);
    expect(csAuthOk("client-1", "ext-a", "garbage")).toBe(false);
    expect(csAuthOk("client-1", "ext-a", "")).toBe(false);
    expect(csAuthOk(undefined, "ext-a", s)).toBe(false);
  });

  it("the scripting binding accepts any extension for its own client", () => {
    const s = mintCsAuth("client-1", null);
    expect(csAuthOk("client-1", "ext-a", s)).toBe(true);
    expect(csAuthOk("client-1", "ext-b", s)).toBe(true);
    expect(csAuthOk("client-2", "ext-a", s)).toBe(false);
  });

  it("a successful check refreshes the LRU order", () => {
    flush();
    const s1 = mintCsAuth("c1", "e1");
    /* csAuths is at cap with s1 the newest entry; the fillers age it
       until it is the oldest survivor. */
    for (let i = 0; i < 511; i++) mintCsAuth("filler-" + i, "e");
    expect(csAuthOk("c1", "e1", s1)).toBe(true);
    /* The check refreshed s1, so one more mint evicts a filler, not
       the secret. Without the refresh this would evict s1. */
    mintCsAuth("filler-final", "e");
    expect(csAuthOk("c1", "e1", s1)).toBe(true);
  });

  it("the oldest secret is evicted at the cap", () => {
    flush();
    const s = mintCsAuth("victim", "e");
    for (let i = 0; i < 512; i++) mintCsAuth("sweep-" + i, "e");
    expect(csAuthOk("victim", "e", s)).toBe(false);
  });
});
