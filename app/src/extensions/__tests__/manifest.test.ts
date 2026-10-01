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
  it("reads the gecko id from browser_specific_settings", () => {
    const { parsed } = parseManifest({
      manifest_version: 3,
      name: "M3",
      version: "1.0",
      browser_specific_settings: { gecko: { id: "{abc@test}" } },
    });
    expect(parsed?.geckoId).toBe("{abc@test}");
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
