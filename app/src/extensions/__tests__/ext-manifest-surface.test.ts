import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { serveExtensionAsset, EXT_ROUTE } from "../serve";
import { dispatchExtControl } from "../control";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

/* Install ids derive from package bytes; unique manifests per call. */
let seq = 0;

interface Installed {
  rec: ExtensionRecord;
  warnings: string[];
}

async function installWith(
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<Installed> {
  await extensions.startup();
  const m = new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
  for (const [k, v] of Object.entries(files)) m.set(k, enc.encode(v));
  const r = await extensions.installFiles(m);
  const rec = extensions.get(r.id)!;
  return { rec, warnings: r.warnings };
}

function i18nManifest(): Record<string, unknown> {
  return {
    manifest_version: 2,
    name: "__MSG_extName__",
    description: "__MSG_extDesc__",
    version: "1." + seq++,
    default_locale: "en",
  };
}

async function listExt(): Promise<{
  ok: boolean;
  extensions: Array<{ id: string; iconPath: string | null }>;
}> {
  const replies: unknown[] = [];
  await dispatchExtControl(
    { type: "zl:listExt" } as never,
    { e: {} as ExtendableMessageEvent, reply: (p: unknown) => replies.push(p) },
  );
  return replies[0] as { ok: boolean; extensions: Array<{ id: string; iconPath: string | null }> };
}

describe("manifest __MSG_*__ i18n placeholders (#504)", () => {
  it("resolves name and description from the package's default_locale", async () => {
    const { rec, warnings } = await installWith(i18nManifest(), {
      "_locales/en/messages.json": JSON.stringify({
        extName: { message: "Resolved Extension" },
        extDesc: { message: "A resolved description." },
      }),
    });
    expect(rec.name).toBe("Resolved Extension");
    expect((rec.manifest as Record<string, unknown>).description).toBe("A resolved description.");
    expect(warnings).toEqual([]);
  });

  it("keeps the literal placeholder and warns when the messages file is missing", async () => {
    const { rec, warnings } = await installWith(i18nManifest(), {});
    expect(rec.name).toBe("__MSG_extName__");
    expect((rec.manifest as Record<string, unknown>).description).toBe("__MSG_extDesc__");
    expect(warnings.some((x) => x.startsWith("name: __MSG_*__ placeholder"))).toBe(true);
    expect(warnings.some((x) => x.startsWith("description: __MSG_*__ placeholder"))).toBe(true);
  });

  it("re-applies resolution on reload from the stored package", async () => {
    const { rec } = await installWith(i18nManifest(), {
      "_locales/en/messages.json": JSON.stringify({ extName: { message: "Reload Me" } }),
    });
    await extensions.reload(rec.id);
    expect(extensions.get(rec.id)!.name).toBe("Reload Me");
  });
});

describe("engine-provided icon path (#504)", () => {
  async function iconExt(): Promise<ExtensionRecord> {
    const { rec } = await installWith(
      {
        manifest_version: 2,
        name: "IconExt",
        version: "2." + seq++,
        icons: { "16": "icon16.png", "48": "icon48.png" },
      },
      { "icon16.png": "sixteen", "icon48.png": "forty-eight" },
    );
    return rec;
  }

  it("zl:listExt carries a token-bearing iconPath for the largest icon", async () => {
    const rec = await iconExt();
    const r = await listExt();
    expect(r.ok).toBe(true);
    const row = r.extensions.find((x) => x.id === rec.id)!;
    expect(row.iconPath).toBeTruthy();
    expect(row.iconPath!.startsWith(EXT_ROUTE + rec.id + "/icon48.png?zlPageTok=")).toBe(true);
  });

  it("serves the minted icon on a non-navigation fetch, bound to its exact path", async () => {
    const rec = await iconExt();
    const r = await listExt();
    const row = r.extensions.find((x) => x.id === rec.id)!;
    const u = new URL("https://sw.example" + row.iconPath);
    const served = await serveExtensionAsset(new Request(u.href), u, { nav: false });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("forty-eight");
    /* the token is bound to /icon48.png: the 16px sibling is refused */
    const u16 = new URL("https://sw.example" + EXT_ROUTE + rec.id + "/icon16.png" + u.search);
    const refused = await serveExtensionAsset(new Request(u16.href), u16, { nav: false });
    expect(refused.status).toBe(404);
  });

  it("declares no iconPath when the manifest has no icons", async () => {
    const { rec } = await installWith(
      { manifest_version: 2, name: "NoIcon", version: "3." + seq++ },
      {},
    );
    const r = await listExt();
    const row = r.extensions.find((x) => x.id === rec.id)!;
    expect(row.iconPath).toBeNull();
  });
});