import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKdl } from "../kdl";
import { rulesFromNodes, ruleFor, locationPolicy } from "../siteconfig";

describe("location rewrite policy (#456)", () => {
  it("preserves legacy behavior unless configured", () => {
    expect(locationPolicy({})).toEqual({ mode: "legacy", maxBytes: 2097152 });
  });
  it("parses bounded hybrid and off controls using the owning page rule", () => {
    const rules = rulesFromNodes(parseKdl('site "example.com" { location-rewrite "hybrid" max-bytes=65536 }\nsite "private.example.com" { location-rewrite "off" }'));
    expect(locationPolicy(ruleFor(rules, "https://example.com/page"))).toEqual({ mode: "hybrid", maxBytes: 65536 });
    expect(locationPolicy(ruleFor(rules, "https://private.example.com/page")).mode).toBe("off");
    expect(locationPolicy(ruleFor(rules, "https://cdn.other/script.js")).mode).toBe("legacy");
  });
  it("rejects invalid modes and caps instead of silently enabling a policy", () => {
    for (const spec of ['"auto"', '"hybrid" max-bytes=0', '"hybrid" max-bytes=4194305', '"hybrid" max-bytes=1.5']) {
      const rules = rulesFromNodes(parseKdl('site "example.com" { location-rewrite ' + spec + ' }'));
      expect(locationPolicy(ruleFor(rules, "https://example.com")).mode).toBe("legacy");
    }
  });
  it("ships hybrid for the #432 play2048.co class only (#456 Wave 2)", () => {
    const kdl = readFileSync(new URL("../../public/siteconfig.kdl", import.meta.url), "utf8");
    const rules = rulesFromNodes(parseKdl(kdl));
    expect(Object.keys(rules)).toEqual(["play2048.co", "accounts.google.com"]);
    expect(locationPolicy(ruleFor(rules, "https://play2048.co/"))).toEqual({ mode: "hybrid", maxBytes: 4 * 1024 * 1024 });
    expect(locationPolicy(ruleFor(rules, "https://www.play2048.co/game"))).toEqual({ mode: "hybrid", maxBytes: 4 * 1024 * 1024 });
    /* Every other origin keeps the legacy default. */
    expect(locationPolicy(ruleFor(rules, "https://example.com/")).mode).toBe("legacy");
    /* #725: virtual-origin reporting ships for the Google sign-in
       origin only. */
    expect(ruleFor(rules, "https://accounts.google.com/").locationOrigin).toBe("virtual");
    expect(ruleFor(rules, "https://www.accounts.google.com/signin").locationOrigin).toBe("virtual");
    expect(ruleFor(rules, "https://play2048.co/").locationOrigin).toBeUndefined();
    expect(ruleFor(rules, "https://example.com/").locationOrigin).toBeUndefined();
  });

  it("parses and rejects location-origin modes (#725)", () => {
    const rules = rulesFromNodes(parseKdl('site "a.com" { location-origin "virtual" }\nsite "b.org" { location-origin "native" }\nsite "c.io" { location-origin "bogus" }'));
    expect(ruleFor(rules, "https://a.com/").locationOrigin).toBe("virtual");
    expect(ruleFor(rules, "https://b.org/").locationOrigin).toBe("native");
    /* A bad mode skips the child, never a silently enabled one. */
    expect(ruleFor(rules, "https://c.io/").locationOrigin).toBeUndefined();
  });
});
