import { describe, expect, it } from "vitest";
import { contentScriptMatches, globToRegExp, resolveContentScripts } from "../content-scripts";
import type { ContentScriptSpec, ExtensionRecord } from "../types";

function spec(over: Partial<ContentScriptSpec> = {}): ContentScriptSpec {
  return {
    matches: ["<all_urls>"],
    exclude_matches: [],
    include_globs: [],
    exclude_globs: [],
    js: ["cs.js"],
    css: [],
    run_at: "document_idle",
    all_frames: false,
    match_about_blank: false,
    ...over,
  };
}

function ext(enabled: boolean, cs: ContentScriptSpec[]): ExtensionRecord {
  return {
    id: "b".repeat(32),
    name: "t",
    version: "1",
    manifestVersion: 2,
    manifest: {},
    geckoId: null,
    permissions: [],
    hostPermissions: [],
    optionalPermissions: [],
    contentScripts: cs,
    background: null,
    action: null,
    options: null,
    icons: {},
    webAccessibleResources: [],
    webAccessibleScoped: [],
    externallyConnectable: null,
    commands: {},
    contentSecurityPolicy: null,
    sidebarAction: null,
    state: "running",
    enabled,
    installTime: 0,
    lastError: null,
    unsupportedFields: [],
    warnings: [],
  };
}

describe("content-script matching", () => {
  it("compiles globs", () => {
    const re = globToRegExp("https://*.example.com/*");
    expect(re.test("https://a.example.com/x")).toBe(true);
    expect(re.test("https://other.com/x")).toBe(false);
  });
  it("honors all_frames", () => {
    const s = spec();
    expect(contentScriptMatches(s, "https://a.com/", false)).toBe(true);
    expect(contentScriptMatches(s, "https://a.com/", true)).toBe(false);
    expect(contentScriptMatches(spec({ all_frames: true }), "https://a.com/", true)).toBe(true);
  });
  it("honors exclude_matches and globs", () => {
    const s = spec({ exclude_matches: ["https://blocked.com/*"] });
    expect(contentScriptMatches(s, "https://blocked.com/", false)).toBe(false);
    expect(contentScriptMatches(s, "https://ok.com/", false)).toBe(true);
    expect(
      contentScriptMatches(spec({ include_globs: ["*special*"] }), "https://a.com/special/", false),
    ).toBe(true);
    expect(
      contentScriptMatches(spec({ include_globs: ["*special*"] }), "https://a.com/plain/", false),
    ).toBe(false);
  });
  it("resolveContentScripts skips disabled extensions", () => {
    const on = ext(true, [spec()]);
    const off = ext(false, [spec()]);
    const r = resolveContentScripts([on, off], "https://a.com/", false);
    expect(r).toHaveLength(1);
    expect(r[0]?.extId).toBe(on.id);
  });
});
