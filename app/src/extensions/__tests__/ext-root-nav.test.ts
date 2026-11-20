import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import {
  serveExtensionAsset,
  EXT_ROUTE,
  registerPageClient,
  rootedPageGrant,
  serveRootedExtPage,
} from "../serve";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

/* Rooted extension pages (#560) carry an injected
   <base href="/zl-ext/<id>/"> so their relative subresources resolve
   into the engine's WAR space. The same base turns a TM-style
   fragment-only anchor (href="#") into a FULL top-level navigation
   to the extension's bare root /zl-ext/<id>/, which is neither a
   declared page nor a WAR. That navigation used to dead-end on the
   raw 404 text (#698). These tests pin the rescue: a bare-root
   navigation lands on the extension's granted rooted options page
   instead. */

let seq = 0;

async function install(name: string, withOptions: boolean): Promise<ExtensionRecord> {
  const manifest: Record<string, unknown> = {
    manifest_version: 2,
    name: name + " #" + seq++,
    version: "1.0",
    permissions: [],
  };
  if (withOptions) manifest.options_ui = { page: "options.html" };
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["options.html", enc.encode("<html><body>tm options page</body></html>")],
  ]);
  await extensions.startup();
  const { id } = await extensions.installFiles(files);
  return extensions.get(id)!;
}

const bareRoot = (rec: ExtensionRecord): URL =>
  new URL("https://sw.example" + EXT_ROUTE + rec.id + "/");

describe("extension bare-root navigation (#698 root dead-end)", () => {
  it("redirects a self page-client bare-root navigation to the tokened options page", async () => {
    const rec = await install("RootNavSelf", true);
    registerPageClient("client-self", rec.id);
    const u = bareRoot(rec);
    const res = await serveExtensionAsset(new Request(u.href), u, {
      nav: true,
      clientId: "client-self",
      resultingClientId: "client-new",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/options.html?zlExt=" + rec.id + "&zlPageTok=")).toBe(true);
    /* The redirect target is a grant the rooted layer accepts and serves. */
    const gu = new URL("https://sw.example" + loc);
    const grant = rootedPageGrant(new Request(gu.href), gu, undefined);
    expect(grant).not.toBeNull();
    const page = await serveRootedExtPage(grant!, "client-redirect");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("tm options page");
  });

  it("redirects an anonymous cold-worker bare-root navigation the same way", async () => {
    const rec = await install("RootNavCold", true);
    const u = bareRoot(rec);
    const res = await serveExtensionAsset(new Request(u.href), u, { nav: true });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("zlExt=" + rec.id);
    expect(loc).toContain("zlPageTok=");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("keeps subresource fetches and options-less extensions on the honest 404", async () => {
    const rec = await install("RootNavSub", true);
    const u = bareRoot(rec);
    const sub = await serveExtensionAsset(new Request(u.href), u, { nav: false });
    expect(sub.status).toBe(404);
    expect(await sub.text()).toContain("extension resource not found");

    const bare = await install("RootNavNoOpts", false);
    const u2 = bareRoot(bare);
    const res = await serveExtensionAsset(new Request(u2.href), u2, { nav: true });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("extension resource not found");
  });
});
