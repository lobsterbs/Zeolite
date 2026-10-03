import { describe, expect, it } from "vitest";
import { httpsUpgraded } from "../config";

/* Issue #53: the pure transform behind the SW's opt-in HTTPS
   upgrade. The SW applies it at the destination choke point and
   per redirect hop; these tests pin its exact contract. */
describe("httpsUpgraded (#53)", () => {
  it("upgrades http:// destinations only when enabled", () => {
    expect(httpsUpgraded("http://example.com/", true)).toBe("https://example.com/");
    expect(httpsUpgraded("http://example.com/a?b=c", true)).toBe("https://example.com/a?b=c");
    expect(httpsUpgraded("http://host:8080/x", true)).toBe("https://host:8080/x");
  });

  it("keeps everything untouched when disabled", () => {
    expect(httpsUpgraded("http://example.com/", false)).toBe("http://example.com/");
  });

  it("never touches non-http destinations", () => {
    expect(httpsUpgraded("https://example.com/", true)).toBe("https://example.com/");
    expect(httpsUpgraded("about:blank", true)).toBe("about:blank");
    expect(httpsUpgraded("", true)).toBe("");
    expect(httpsUpgraded("/j/abc123", true)).toBe("/j/abc123");
  });

  it("does not upgrade http-lookalikes or non-lowercase schemes", () => {
    expect(httpsUpgraded("httpx://example.com/", true)).toBe("httpx://example.com/");
    expect(httpsUpgraded("HTTP://example.com/", true)).toBe("HTTP://example.com/");
  });
});
