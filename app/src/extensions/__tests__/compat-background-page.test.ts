import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { COMPAT, compatReport } from "../compat";
import { bootExtension } from "../background";

const enc = new TextEncoder();

let seq = 0;

/* Every package gets a distinct manifest (name + version) so the
   shared store never rejects an install as already present. */
function pagePkg(
  name: string,
  html: string,
  extra?: Record<string, string>,
): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1." + seq++,
    permissions: [],
    background: { page: "bg.html" },
  };
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["bg.html", enc.encode(html)],
  ]);
  for (const [k, v] of Object.entries(extra ?? {})) files.set(k, enc.encode(v));
  return files;
}

describe("background.page capability (#505)", () => {
  it("reports background.page as 'partial' in the compatibility matrix", () => {
    const entry = COMPAT["background.page (MV2)"];
    expect(entry).toBeDefined();
    expect(entry!.supported).toBe("partial");
    expect(entry!.reason).toContain("no DOM is provided");
    expect(
      compatReport().some((r) => r.api === "background.page (MV2)" && r.supported === "partial"),
    ).toBe(true);
  });

  it("boots a page background by running its external and inline scripts in document order", async () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__zl505order;
    await extensions.startup();
    const { id } = await extensions.installFiles(
      pagePkg(
        "BgPageOrder",
        '<html><head><script src="sub/one.js"></script><script>globalThis.__zl505order = (globalThis.__zl505order || "") + "inline:";</script></head></html>',
        { "sub/one.js": 'globalThis.__zl505order = "external:";' },
      ),
    );
    await bootExtension(extensions.get(id)!);
    const after = extensions.get(id)!;
    expect(after.state).toBe("running");
    /* External sets, inline appends: only document order yields
       "external:inline:". */
    expect(g.__zl505order).toBe("external:inline:");
    delete g.__zl505order;
  });

  it("treats a page with no scripts as a valid inert background", async () => {
    await extensions.startup();
    const { id } = await extensions.installFiles(
      pagePkg("BgPageInert", "<html><body>bg</body></html>"),
    );
    await bootExtension(extensions.get(id)!);
    expect(extensions.get(id)!.state).toBe("running");
  });

  it("gives background.page precedence over background.scripts, as in Chrome", async () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__zl505pageWin;
    delete g.__zl505scriptsRan;
    await extensions.startup();
    const manifest = {
      manifest_version: 2,
      name: "BgPagePrecedence",
      version: "1." + seq++,
      permissions: [],
      background: { page: "bg.html", scripts: ["never.js"] },
    };
    const files = new Map<string, Uint8Array>([
      ["manifest.json", enc.encode(JSON.stringify(manifest))],
      ["bg.html", enc.encode('<script>globalThis.__zl505pageWin = "page";</script>')],
      ["never.js", enc.encode("globalThis.__zl505scriptsRan = true;")],
    ]);
    const { id } = await extensions.installFiles(files);
    await bootExtension(extensions.get(id)!);
    expect(extensions.get(id)!.state).toBe("running");
    expect(g.__zl505pageWin).toBe("page");
    expect(g.__zl505scriptsRan).not.toBe(true);
    delete g.__zl505pageWin;
    delete g.__zl505scriptsRan;
  });

  it("fails the boot honestly when the page file is missing from the package", async () => {
    await extensions.startup();
    const manifest = {
      manifest_version: 2,
      name: "BgPageMissing",
      version: "1." + seq++,
      permissions: [],
      background: { page: "gone.html" },
    };
    const { id } = await extensions.installFiles(
      new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]),
    );
    await bootExtension(extensions.get(id)!);
    const after = extensions.get(id)!;
    expect(after.state).toBe("error");
    expect(after.lastError).toContain("background page missing from package: gone.html");
  });

  it("fails the boot with the recorded error when a page script touches the DOM", async () => {
    await extensions.startup();
    const { id } = await extensions.installFiles(
      pagePkg("BgPageDom", '<script>document.title = "x";</script>'),
    );
    await bootExtension(extensions.get(id)!);
    const after = extensions.get(id)!;
    expect(after.state).toBe("error");
    expect(after.lastError).toContain("document is not defined");
  });

  it("fails the boot honestly when an external page script is missing", async () => {
    await extensions.startup();
    const { id } = await extensions.installFiles(
      pagePkg("BgPageMissingSrc", '<script src="ghost.js"></script>'),
    );
    await bootExtension(extensions.get(id)!);
    const after = extensions.get(id)!;
    expect(after.state).toBe("error");
    expect(after.lastError).toContain("background script missing from package: ghost.js");
  });
});
