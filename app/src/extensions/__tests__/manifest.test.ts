import { describe, expect, it } from "vitest";
import { parseManifest } from "../manifest";

const mv2 = {
  manifest_version: 2,
  name: "Test Ext",
  version: "1.2.3",
  description: "fixture",
  permissions: ["storage", "tabs", "https://*.example.com/*"],
  content_scripts: [
    { matches: ["<all_urls>"], js: ["cs.js"], run_at: "document_start", all_frames: true },
    { js: ["x.js"] },
  ],
  background: { scripts: ["bg.js"] },
  browser_action: { default_popup: "popup.html", default_title: "T" },
  web_accessible_resources: ["public/*"],
  options_ui: { page: "opts.html", open_in_tab: true },
  something_unknown: { x: 1 },
};

describe("parseManifest MV2", () => {
  const { ok, parsed, diags } = parseManifest(mv2);
  it("accepts a valid MV2 manifest", () => {
    expect(ok).toBe(true);
    expect(parsed).not.toBeNull();
  });
  it("splits host patterns out of permissions", () => {
    expect(parsed?.permissions).toContain("storage");
    expect(parsed?.permissions).toContain("tabs");
    expect(parsed?.permissions).not.toContain("https://*.example.com/*");
    expect(parsed?.hostPermissions).toContain("https://*.example.com/*");
  });
  it("drops content_scripts entries without matches, with a warning", () => {
    expect(parsed?.contentScripts).toHaveLength(1);
    expect(diags.warnings.some((w) => w.includes("matches"))).toBe(true);
  });
  it("labels the MV2 action as browser_action", () => {
    expect(parsed?.action?.kind).toBe("browser_action");
    expect(parsed?.action?.defaultPopup).toBe("popup.html");
  });
  it("parses MV2 web_accessible_resources as globs", () => {
    expect(parsed?.webAccessibleResources).toEqual(["public/*"]);
  });
  it("parses options_ui", () => {
    expect(parsed?.options?.page).toBe("opts.html");
    expect(parsed?.options?.openInTab).toBe(true);
  });
  it("preserves and reports unknown fields", () => {
    expect(parsed?.unsupportedFields).toContain("something_unknown");
    expect((parsed?.manifest as Record<string, unknown>)["something_unknown"]).toEqual({ x: 1 });
  });
  it("parses background scripts", () => {
    expect(parsed?.background?.scripts).toEqual(["bg.js"]);
    expect(parsed?.background?.serviceWorker).toBeNull();
  });
});

describe("parseManifest MV3", () => {
  it("records a service worker background with a warning (Firefox runs scripts)", () => {
    const { ok, parsed, diags } = parseManifest({
      manifest_version: 3,
      name: "M3",
      version: "1.0",
      background: { service_worker: "sw.js" },
      host_permissions: ["https://example.com/*"],
    });
    expect(ok).toBe(true);
    expect(parsed?.background?.serviceWorker).toBe("sw.js");
    expect(diags.warnings.some((w) => w.includes("service_worker"))).toBe(true);
  });
  it("parses MV3 web_accessible_resources objects", () => {
    const { parsed, diags } = parseManifest({
      manifest_version: 3,
      name: "M3",
      version: "1.0",
      web_accessible_resources: [
        { resources: ["r/*"], matches: ["https://example.com/*"] },
        { resources: ["open/*"] },
      ],
    });
    /* #51: entries with matches are scoped, not open globs; entries
       without matches warn that they stay glob-exposed. */
    expect(parsed?.webAccessibleResources).toEqual(["open/*"]);
    expect(parsed?.webAccessibleScoped).toEqual([
      { resources: ["r/*"], matches: ["https://example.com/*"] },
    ]);
    expect(diags.warnings.some((w) => w.includes("without matches"))).toBe(true);
  });
  it("labels the MV3 action as action", () => {
    const { parsed } = parseManifest({
      manifest_version: 3,
      name: "M3",
      version: "1.0",
      action: { default_popup: "p.html" },
    });
    expect(parsed?.action?.kind).toBe("action");
  });
  it("reads the gecko id and version bounds from browser_specific_settings", () => {
    const { parsed, diags } = parseManifest({
      manifest_version: 3,
      name: "M3",
      version: "1.0",
      browser_specific_settings: {
        gecko: { id: "{12345678-1234-1234-1234-123456789abc}", strict_min_version: "109.0", strict_max_version: "128.*" },
      },
    });
    expect(parsed?.geckoId).toBe("{12345678-1234-1234-1234-123456789abc}");
    expect(parsed?.geckoMinVersion).toBe("109.0");
    /* "128.*" is a Firefox-legal bound but not purely dotted: recorded
       as-is with a warning, the engine does not enforce the range. */
    expect(parsed?.geckoMaxVersion).toBe("128.*");
    expect(diags.warnings.some((w) => w.includes("strict_max_version"))).toBe(true);
  });
  it("accepts JID-shaped gecko ids and dotted bounds", () => {
    const { parsed, ok } = parseManifest({
      manifest_version: 2,
      name: "J",
      version: "1.0",
      browser_specific_settings: {
        gecko: { id: "add-on@example.org", strict_min_version: "102", strict_max_version: "115.0.1" },
      },
    });
    expect(ok).toBe(true);
    expect(parsed?.geckoId).toBe("add-on@example.org");
    expect(parsed?.geckoMinVersion).toBe("102");
    expect(parsed?.geckoMaxVersion).toBe("115.0.1");
  });
  it("rejects a malformed gecko id with a Firefox-style error", () => {
    const { ok, diags } = parseManifest({
      manifest_version: 3,
      name: "Bad",
      version: "1.0",
      browser_specific_settings: { gecko: { id: "not an id" } },
    });
    expect(ok).toBe(false);
    expect(diags.errors.some((e) => e.includes("browser_specific_settings.gecko.id"))).toBe(true);
  });
  it("warns on unsupported bss engines and gecko keys", () => {
    const { diags } = parseManifest({
      manifest_version: 2,
      name: "W",
      version: "1.0",
      browser_specific_settings: { gecko: { id: "w@example.org", unknown_key: 1 }, safari: {} },
    });
    expect(diags.warnings.some((w) => w.includes("unsupported key 'unknown_key'"))).toBe(true);
    expect(diags.warnings.some((w) => w.includes("engine 'safari'"))).toBe(true);
  });
  it("parses and records theme and dictionaries (#524)", () => {
    const { parsed, diags } = parseManifest({
      manifest_version: 2,
      name: "Theme",
      version: "1.0",
      theme: { colors: { frame: "#000000" }, images: {}, properties: { color_scheme: "dark" } },
      dictionaries: ["en", "de"],
      developer: { name: "Dev" },
    });
    expect(parsed?.theme?.colors).toEqual({ frame: "#000000" });
    expect(diags.unsupportedFields).not.toContain("theme");
    expect(diags.unsupportedFields).not.toContain("developer");
  });
  it("records dictionaries as a locale -> path map", () => {
    const { parsed } = parseManifest({
      manifest_version: 2,
      name: "Dict",
      version: "1.0",
      dictionaries: { en: "dictionaries/en.dic", de: "dictionaries/de.dic" },
    });
    expect(parsed?.dictionaries).toEqual({ en: "dictionaries/en.dic", de: "dictionaries/de.dic" });
  });
});

describe("parseManifest validation", () => {
  it("rejects bad manifest_version", () => {
    const { ok, diags } = parseManifest({ manifest_version: 1, name: "x", version: "1" });
    expect(ok).toBe(false);
    expect(diags.errors.some((e) => e.includes("manifest_version"))).toBe(true);
  });
  it("rejects missing name and version", () => {
    const { ok, diags } = parseManifest({ manifest_version: 2 });
    expect(ok).toBe(false);
    expect(diags.errors.some((e) => e.startsWith("name:"))).toBe(true);
    expect(diags.errors.some((e) => e.startsWith("version:"))).toBe(true);
  });
  it("rejects non-object roots", () => {
    const { ok } = parseManifest("nope");
    expect(ok).toBe(false);
  });
});
