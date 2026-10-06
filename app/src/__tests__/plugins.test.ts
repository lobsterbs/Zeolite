import { describe, it, expect } from "vitest";
import { pluginNameOk, loadPlugin } from "../plugins";

describe("plugin name validation (#97)", () => {
  it("accepts only plain [A-Za-z0-9_-] names", () => {
    expect(pluginNameOk("adblock")).toBe(true);
    expect(pluginNameOk("my-plugin_2")).toBe(true);
    expect(pluginNameOk("../evil")).toBe(false);
    expect(pluginNameOk("a/b")).toBe(false);
    expect(pluginNameOk("..%2fevil")).toBe(false);
    expect(pluginNameOk("https://evil.example/p")).toBe(false);
    expect(pluginNameOk("")).toBe(false);
  });

  it("never attempts an import for crafted names", async () => {
    expect(await loadPlugin("../../escape")).toBeNull();
    expect(await loadPlugin("https://evil.example/p.js")).toBeNull();
  });

  it("a missing plugin degrades to null on every call", async () => {
    // In the test environment /plugins/<name>.js cannot resolve, so the
    // import fails; every call must return null and never throw.
    expect(await loadPlugin("definitely-missing")).toBeNull();
    expect(await loadPlugin("definitely-missing")).toBeNull();
  });
});
