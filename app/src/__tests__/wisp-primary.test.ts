/* LobsterBrowse Settings: the active WISP server is the primary
   transport endpoint (zl:wispPrimary). Covers the pure endpoint
   normalization and the override state; the libcurl re-init is the
   transport's reset path and is exercised by the wisp route suites. */

import { afterEach, describe, expect, it } from "vitest";
import { normalizeWispUrl, primaryWispOverrideValue, primaryWispUrl, setPrimaryWispOverride } from "../config";
import { setPrimaryWisp } from "../transport";

describe("primary wisp endpoint (zl:wispPrimary)", () => {
  afterEach(() => {
    setPrimaryWispOverride(null);
  });

  it("accepts only ws:// and wss:// URLs", () => {
    expect(normalizeWispUrl("wss://anura.pro")).toBe("wss://anura.pro/");
    expect(normalizeWispUrl("  wss://example.com/wisp/ ")).toBe("wss://example.com/wisp/");
    expect(normalizeWispUrl("ws://localhost:6002/wisp/")).toBe("ws://localhost:6002/wisp/");
    expect(normalizeWispUrl("https://example.com/")).toBeNull();
    expect(normalizeWispUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeWispUrl("wss://")).toBeNull();
    expect(normalizeWispUrl("")).toBeNull();
  });

  it("an accepted override replaces the build-time endpoint; empty restores it", () => {
    const build = primaryWispUrl();
    expect(setPrimaryWisp("wss://anura.pro")).toBe(true);
    expect(primaryWispUrl()).toBe("wss://anura.pro/");
    expect(primaryWispOverrideValue()).toBe("wss://anura.pro/");
    expect(setPrimaryWisp("")).toBe(true);
    expect(primaryWispUrl()).toBe(build);
    expect(primaryWispOverrideValue()).toBeNull();
  });

  it("an invalid URL is refused and leaves the current endpoint unchanged", () => {
    setPrimaryWisp("wss://anura.pro");
    expect(setPrimaryWisp("https://evil.example/")).toBe(false);
    expect(primaryWispUrl()).toBe("wss://anura.pro/");
  });
});
