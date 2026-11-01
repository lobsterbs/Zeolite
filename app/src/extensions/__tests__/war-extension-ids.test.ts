import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";

const enc = new TextEncoder();

/* #524: MV3 web_accessible_resources extension_ids scoping. The gate
   is exercised at the getResource boundary the serve path uses. */

function pkg(manifest: Record<string, unknown>): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["pub/shared.js", enc.encode("var shared = 1;")],
  ]);
  return files;
}

async function install(name: string, manifest: Record<string, unknown>): Promise<string> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg({ manifest_version: 3, name, version: "1.0", ...manifest }));
  return id;
}

describe("web_accessible_resources extension_ids (#524)", () => {
  it("admits a listed extension's page client even when the page does not match", async () => {
    const aId = await install("WarRequesterA", { permissions: [] });
    const bId = await install("WarTargetB", {
      web_accessible_resources: [
        { resources: ["pub/*"], matches: ["https://allowed.example/*"] },
        { resources: ["pub/shared.js"], matches: ["https://other.example/*"], extension_ids: [aId] },
      ],
    });
    /* Page match still works. */
    expect(
      await extensions.getResource(bId, "/pub/shared.js", {
        fromWeb: true,
        pageUrl: "https://allowed.example/page",
      }),
    ).not.toBeNull();
    /* Extension ids admit the registered requester even off-match. */
    expect(
      await extensions.getResource(bId, "/pub/shared.js", {
        fromWeb: true,
        pageUrl: "https://random.example/page",
        fromExtensionId: aId,
      }),
    ).not.toBeNull();
    /* An unlisted extension and a no-identity page fail closed. */
    expect(
      await extensions.getResource(bId, "/pub/shared.js", {
        fromWeb: true,
        pageUrl: "https://random.example/page",
        fromExtensionId: "f".repeat(32),
      }),
    ).toBeNull();
    expect(
      await extensions.getResource(bId, "/pub/shared.js", {
        fromWeb: true,
        pageUrl: "https://random.example/page",
      }),
    ).toBeNull();
  });

  it("supports the * glob and entries gated by extension_ids alone", async () => {
    const aId = await install("WarStarA", { permissions: [] });
    const bId = await install("WarStarB", {
      web_accessible_resources: [
        { resources: ["pub/shared.js"], extension_ids: ["*"] },
      ],
    });
    expect(
      await extensions.getResource(bId, "/pub/shared.js", {
        fromWeb: true,
        pageUrl: null,
        fromExtensionId: aId,
      }),
    ).not.toBeNull();
    expect(
      await extensions.getResource(bId, "/pub/shared.js", { fromWeb: true, pageUrl: null }),
    ).toBeNull();
  });

  it("records use_dynamic_url with an honest warning", async () => {
    const bId = await install("WarDyn", {
      web_accessible_resources: [
        {
          resources: ["pub/shared.js"],
          matches: ["https://allowed.example/*"],
          use_dynamic_url: true,
        },
      ],
    });
    const rec = extensions.get(bId)!;
    expect(rec.webAccessibleScoped[0].useDynamicUrl).toBe(true);
    expect(rec.warnings.some((w) => w.includes("use_dynamic_url recorded but not enforced"))).toBe(true);
  });

  it("warns when an entry has neither matches nor extension_ids", async () => {
    const bId = await install("WarNeither", {
      web_accessible_resources: [{ resources: ["pub/shared.js"] }],
    });
    const rec = extensions.get(bId)!;
    expect(rec.warnings.some((w) => w.includes("exposed by glob only"))).toBe(true);
  });
});
