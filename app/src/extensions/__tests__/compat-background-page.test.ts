import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { COMPAT, compatReport } from "../compat";
import { bootExtension } from "../background";

const enc = new TextEncoder();

let seq = 0;

function pagePkg(name: string): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1." + seq++,
    permissions: [],
    background: { page: "bg.html" },
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["bg.html", enc.encode("<html><body>bg</body></html>")],
  ]);
}

describe("background.page capability (#505)", () => {
  it("reports background.page as an explicit 'no' in the compatibility matrix", () => {
    const entry = COMPAT["background.page (MV2)"];
    expect(entry).toBeDefined();
    expect(entry!.supported).toBe("no");
    expect(entry!.reason).toContain("background.page");
    expect(
      compatReport().some((r) => r.api === "background.page (MV2)" && r.supported === "no"),
    ).toBe(true);
  });

  it("fails a page-only background boot honestly instead of running nothing silently", async () => {
    await extensions.startup();
    const { id } = await extensions.installFiles(pagePkg("BgPage"));
    await bootExtension(extensions.get(id)!);
    const after = extensions.get(id)!;
    expect(after.state).toBe("error");
    expect(after.lastError).toContain("background.page is not supported yet");
  });
});