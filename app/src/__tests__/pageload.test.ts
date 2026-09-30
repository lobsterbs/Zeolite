import { describe, expect, it } from "vitest";
import { initScript, siteToken } from "../pageload";

const DEST = "https://real.site/deep/page?q=1";
const DEST2 = "https://other.site/";

describe("siteToken (issue #32)", () => {
  it("is stable per site across pages and reloads", () => {
    expect(siteToken(DEST)).toBe(siteToken("https://real.site/other"));
    expect(siteToken(DEST)).toBe(siteToken(DEST));
  });

  it("differs between sites and never reveals the origin", () => {
    const a = siteToken(DEST);
    const b = siteToken(DEST2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9]+$/);
    expect(a).not.toContain("real.site");
  });

  it("falls back to one stable token for opaque destinations", () => {
    expect(siteToken("about:blank")).toBe(siteToken("data:text/plain,hi"));
    expect(siteToken("")).toMatch(/^[a-z0-9]+$/);
  });
});

describe("initScript (issue #32)", () => {
  it("injects the opaque site identity, never the destination", () => {
    const s = initScript(DEST, null);
    expect(s).toMatch(/^<script>window\.__ZL=\{"site":"[a-z0-9]+"\};<\/script>$/);
    expect(s).not.toContain("real.site");
    expect(s).not.toContain(DEST);
  });

  it("rides the fingerprint profile on the same first chunk", () => {
    const s = initScript(DEST, "/*fp*/");
    expect(s).toBe(
      '<script>window.__ZL={"site":"' + siteToken(DEST) + '"};</script><script>/*fp*/</script>',
    );
  });
});
