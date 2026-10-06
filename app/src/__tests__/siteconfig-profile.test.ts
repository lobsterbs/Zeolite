import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../fingerprint";
import { ruleFor, ruleProfile, type SiteRules } from "../siteconfig";

/* #80: per-site FingerprintProfiles are siteconfig data. ruleProfile
   is the whole resolution pipeline minus the SW-side script compile
   (siteProfileFor in sw.ts); these tests pin the data path. */
const rules: SiteRules = {
  "coherent.test": { fingerprint: { userAgent: DEFAULT_PROFILE.userAgent } },
  "bad.test": { fingerprint: { userAgent: "curl/8.0" } },
  "bound.test": { fingerprint: { userAgent: DEFAULT_PROFILE.userAgent, engines: ["epoxy"] } },
  "plain.test": { block: ["ads.example"] },
};

describe("ruleProfile (#80 per-site fingerprint data)", () => {
  it("resolves a coherent rule profile", () => {
    const p = ruleProfile(ruleFor(rules, "https://www.coherent.test/x"), "libcurl");
    expect(p?.platform).toBe("Win32");
    expect(p?.userAgent).toBe(DEFAULT_PROFILE.userAgent);
  });

  it("longest host-suffix match carries the profile", () => {
    expect(ruleProfile(ruleFor(rules, "https://deep.sub.coherent.test/"), "libcurl")).not.toBeNull();
  });

  it("null for absent data, no match, invalid data, or the wrong engine; never throws", () => {
    expect(ruleProfile(ruleFor(rules, "https://plain.test/"), "libcurl")).toBeNull();
    expect(ruleProfile(ruleFor(rules, "https://nomatch.example/"), "libcurl")).toBeNull();
    expect(ruleProfile(ruleFor(rules, "https://bad.test/"), "libcurl")).toBeNull();
    expect(ruleProfile(ruleFor(rules, "https://bound.test/"), "libcurl")).toBeNull();
    expect(ruleProfile(ruleFor(rules, "https://bound.test/"), "epoxy")).not.toBeNull();
    expect(ruleProfile({}, "libcurl")).toBeNull();
    expect(ruleProfile({ fingerprint: 42 }, "libcurl")).toBeNull();
    expect(ruleProfile({ fingerprint: {} }, "libcurl")).toBeNull();
  });
});
