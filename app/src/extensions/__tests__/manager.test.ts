import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

function packageFiles(name: string): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: ["storage"],
    content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }],
    browser_action: { default_popup: "popup.html" },
    web_accessible_resources: ["public/*"],
    background: { scripts: ["bg.js"] },
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["cs.js", enc.encode("// cs")],
    ["bg.js", enc.encode("// bg")],
    ["popup.html", enc.encode("<p>popup</p>")],
    ["secret.txt", enc.encode("internal")],
  ]);
}

describe("ExtensionManager", () => {
  it("installs from unpacked files and derives a stable id", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const r = await m.installFiles(packageFiles("Alpha"));
    expect(r.id).toMatch(/^[a-f0-9]{32}$/);
    expect(m.list()).toHaveLength(1);
    expect(m.get(r.id)?.name).toBe("Alpha");
    await expect(m.installFiles(packageFiles("Alpha"))).rejects.toThrow(/already installed/);
  });
  it("rejects duplicate installs and bad manifests", async () => {
    const m = new ExtensionManager();
    await m.startup();
    await m.installFiles(packageFiles("Beta"));
    await expect(m.installFiles(packageFiles("Beta"))).rejects.toThrow(/already installed/);
    const bad = packageFiles("Bad");
    bad.set("manifest.json", enc.encode("{ nope"));
    await expect(m.installFiles(bad)).rejects.toThrow(/valid JSON/);
  });
  it("derives identity from package contents, not the manifest alone (#287)", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const a = await m.installFiles(packageFiles("Omega"));
    const sameManifest = packageFiles("Omega");
    sameManifest.set("cs.js", enc.encode("// cs v2"));
    const b = await m.installFiles(sameManifest);
    expect(b.id).not.toBe(a.id);
    /* fake-indexeddb state is shared file-wide, so earlier tests'
       extensions may be loaded too; assert ours are both present. */
    const ids = m.list().map((e: { id: string }) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    /* byte-identical contents in a different insertion order are still
       the same package: duplicate detection holds. */
    const reordered = new Map([...packageFiles("Alpha").entries()].reverse());
    await expect(m.installFiles(reordered)).rejects.toThrow(/already installed/);
  });

  it("gates resources on enabled state and web_accessible_resources", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(packageFiles("Gamma"));
    const secret = await m.getResource(id, "/secret.txt", { fromWeb: true });
    expect(secret).toBeNull();
    const internal = await m.getResource(id, "/secret.txt", { fromWeb: false });
    expect(internal).not.toBeNull();
    await m.setEnabled(id, false);
    expect(await m.getResource(id, "/secret.txt", { fromWeb: false })).toBeNull();
    expect(m.get(id)?.state).toBe("disabled");
    await m.setEnabled(id, true);
  });
  it("uninstalls cleanly", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(packageFiles("Delta"));
    await m.uninstall(id);
    expect(m.list().some((e) => e.id === id)).toBe(false);
    await expect(m.uninstall(id)).rejects.toThrow(/no such extension/);
  });
  it("reloads from the stored package", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(packageFiles("Eps"));
    await m.reload(id);
    expect(m.get(id)?.state).toBe("installed");
  });
});

describe("buildApi", () => {
  it("exposes runtime + storage and the chrome alias", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(packageFiles("Api"));
    const rec = m.get(id)!;
    const messenger = new ExtensionMessenger();
    const storage = {
      local: new ExtensionStorageArea(id, "local", "local"),
      sync: new ExtensionStorageArea(id, "sync", "sync"),
      session: new ExtensionStorageArea(id, "session", "session"),
    };
    const { browser, chrome } = buildApi(rec, { extensionId: id, context: "background", url: null }, { messenger, storage });
    expect((browser.runtime as Record<string, unknown>)["id"]).toBe(id);
    expect((chrome as { runtime: Record<string, unknown> }).runtime["id"]).toBe(id);
    const getURL = (browser.runtime as Record<string, unknown>)["getURL"] as (p: string) => string;
    expect(getURL("x.png")).toBe("extension://" + id + "/x.png");
    await expect(
      (browser.runtime as Record<string, (...a: unknown[]) => Promise<unknown>>)["sendMessage"]({}),
    ).rejects.toThrow(/Receiving end/);
    messenger.onMessage(id, (_msg, _from, send) => send({ ok: 1 }));
    await expect(
      (browser.runtime as Record<string, (...a: unknown[]) => Promise<unknown>>)["sendMessage"]({}),
    ).resolves.toEqual({ ok: 1 });
  });
});
