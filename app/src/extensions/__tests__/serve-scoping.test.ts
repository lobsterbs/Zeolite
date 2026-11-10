import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { serveExtensionAsset, CS_ROUTE } from "../serve";

const enc = new TextEncoder();

/* MV2 manifest with one content_scripts entry limited to
   https://a.example, carrying cs.js and cs.css. */
function csPkg(name: string, matches: string[], exclude: string[] = []): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: [],
    content_scripts: [
      {
        matches,
        exclude_matches: exclude,
        js: ["cs.js"],
        css: ["cs.css"],
        run_at: "document_idle",
      },
    ],
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["cs.js", enc.encode("var csRan = 1;")],
    ["cs.css", enc.encode("body{}")],
    ["bg.js", enc.encode("var bg = 1;")],
  ]);
}

async function installCs(name: string, matches: string[], exclude: string[] = []): Promise<string> {
  await extensions.startup();
  const { id } = await extensions.installFiles(csPkg(name, matches, exclude));
  return id;
}

function csUrl(id: string, path: string, cfg?: string): { req: Request; url: URL } {
  const q = cfg === undefined ? "" : "?cfg=" + encodeURIComponent(cfg);
  return { req: new Request("https://sw.example" + CS_ROUTE + id + path + q), url: new URL("https://sw.example" + CS_ROUTE + id + path + q) };
}

describe("content-script asset scoping (#285)", () => {
  it("serves declared cs files only to pages the entry matches", async () => {
    const id = await installCs("CsScope", ["https://a.example/*"]);
    const onSite = csUrl(id, "/cs.js");
    const ok = await serveExtensionAsset(onSite.req, onSite.url, {
      nav: false,
      pageUrl: "https://a.example/page.html",
    });
    expect(ok.status).toBe(200);
    const offSite = csUrl(id, "/cs.js");
    const denied = await serveExtensionAsset(offSite.req, offSite.url, {
      nav: false,
      pageUrl: "https://b.example/page.html",
    });
    expect(denied.status).toBe(404);
  });

  it("fails closed without a SW-observed pageUrl", async () => {
    const id = await installCs("CsAnon", ["<all_urls>"]);
    const r = csUrl(id, "/cs.js");
    const anon = await serveExtensionAsset(r.req, r.url, { nav: false });
    expect(anon.status).toBe(404);
  });

  it("never serves undeclared package files through /zl-cs/", async () => {
    const id = await installCs("CsPkg", ["<all_urls>"]);
    const bg = csUrl(id, "/bg.js");
    const res = await serveExtensionAsset(bg.req, bg.url, {
      nav: false,
      pageUrl: "https://a.example/",
    });
    expect(res.status).toBe(404);
  });

  it("honors exclude_matches against the requesting page", async () => {
    const id = await installCs("CsExcl", ["<all_urls>"], ["https://blocked.example/*"]);
    const r = csUrl(id, "/cs.js");
    const denied = await serveExtensionAsset(r.req, r.url, {
      nav: false,
      pageUrl: "https://blocked.example/page.html",
    });
    expect(denied.status).toBe(404);
    const ok = await serveExtensionAsset(r.req, r.url, {
      nav: false,
      pageUrl: "https://ok.example/page.html",
    });
    expect(ok.status).toBe(200);
  });

  it("filters the page-supplied bridge cfg against matching entries", async () => {
    const id = await installCs("CsBridge", ["https://a.example/*"]);
    const cfg = JSON.stringify({ js: ["cs.js", "bg.js"], css: ["cs.css"], runAt: "document_end" });
    const onSite = csUrl(id, "/__bridge.js", cfg);
    const res = await serveExtensionAsset(onSite.req, onSite.url, {
      nav: false,
      clientId: "client-csbridge-1",
      pageUrl: "https://a.example/page.html",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    /* #517: the body is the invoked bridge IIFE taking (cfg, auth);
       the channel secret rides in the argument list, never a global
       the page could read. */
    const m = /\}\)\((\{.*\}),("[0-9a-f-]{36}")\);$/.exec(body);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]);
    /* bg.js is in the package but not declared in any matching entry:
       dropped. */
    expect(parsed.js).toEqual([CS_ROUTE + id + "/cs.js"]);
    expect(parsed.css).toEqual([CS_ROUTE + id + "/cs.css"]);
    expect(parsed.runAt).toBe("document_end");
    expect(body.startsWith("(function (cfg, auth) {")).toBe(true);
    expect(body).not.toContain("ZL_CS_CFG");
    /* #517: single use. The same client refetching the same bridge
       (a page script trying to read the secret out of the body)
       fails closed. */
    const again = await serveExtensionAsset(onSite.req, onSite.url, {
      nav: false,
      clientId: "client-csbridge-1",
      pageUrl: "https://a.example/page.html",
    });
    expect(again.status).toBe(404);
    /* Same forged cfg from a non-matching page: empty config. */
    const offSite = csUrl(id, "/__bridge.js", cfg);
    const off = await serveExtensionAsset(offSite.req, offSite.url, {
      nav: false,
      clientId: "client-csbridge-2",
      pageUrl: "https://b.example/page.html",
    });
    expect(off.status).toBe(200);
    const offM = /\}\)\((\{.*\}),("[0-9a-f-]{36}")\);$/.exec(await off.text())!;
    const offBody = JSON.parse(offM[1]);
    expect(offBody.js).toEqual([]);
    expect(offBody.css).toEqual([]);
  });
});
