import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import {
  serveExtensionAsset,
  parseServePath,
  mintPageToken,
  registerPageClient,
  pageClientOf,
  EXT_ROUTE,
} from "../serve";
import { handleExtPageCall, pageCallList } from "../pageapi";
import { MESSENGER } from "../context";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string, perms: string[], files: Record<string, string> = {}): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions: perms };
  const m = new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
  for (const [k, v] of Object.entries(files)) m.set(k, enc.encode(v));
  return m;
}

const PAGE_HTML = "<html><head><title>opts</title></head><body>options</body></html>";

/* Install ids are derived from the manifest bytes, so every install
   needs a unique manifest. */
let seq = 0;

async function install(name: string, perms: string[], files: Record<string, string> = {}): Promise<ExtensionRecord> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name + " #" + seq++, perms, files));
  return extensions.get(id)!;
}

async function pageExt(): Promise<ExtensionRecord> {
  return install("PageExt", ["cookies"], {
    "options.html": PAGE_HTML,
    "secret.js": "var notForTheWeb = 1;",
  });
}

function reqUrl(href: string): { req: Request; url: URL } {
  return { req: new Request(href), url: new URL(href) };
}

describe("extension pages (#40)", () => {
  it("parses __page.js as the pagejs kind", () => {
    const id = "a".repeat(32);
    expect(parseServePath(EXT_ROUTE + id + "/__page.js")).toEqual({ kind: "pagejs", id });
    expect(parseServePath(EXT_ROUTE + id + "/options.html")).toEqual({
      kind: "war",
      id,
      path: "/options.html",
    });
  });

  it("serves a navigation only with a token or a registered page client", async () => {
    const rec = await pageExt();
    const page = reqUrl("https://sw.example" + EXT_ROUTE + rec.id + "/options.html");

    /* No token, no registered client: the WAR gate applies and the
       page is not web-accessible, so 404. */
    const bare = await serveExtensionAsset(page.req, page.url, { nav: true });
    expect(bare.status).toBe(404);

    /* A token minted for a different path does not grant. */
    const wrongTok = mintPageToken(rec.id, "/other.html");
    const wrong = await serveExtensionAsset(
      page.req,
      new URL(page.url.href + "?zlPageTok=" + wrongTok),
      { nav: true },
    );
    expect(wrong.status).toBe(404);

    /* The right token serves the page with the bridge injected and
       registers the new client. */
    const tok = mintPageToken(rec.id, "/options.html");
    const ok = await serveExtensionAsset(
      page.req,
      new URL(page.url.href + "?zlPageTok=" + tok),
      { nav: true, resultingClientId: "c1" },
    );
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(body).toContain('<script src="/zl-ext/' + rec.id + '/__page.js"></script>');
    expect(body).toContain("options");
    expect(pageClientOf("c1")).toBe(rec.id);

    /* Subresource from the registered client: full package access
       even though secret.js is not web-accessible. */
    const sub = reqUrl("https://sw.example" + EXT_ROUTE + rec.id + "/secret.js");
    const granted = await serveExtensionAsset(sub.req, sub.url, { nav: false, clientId: "c1" });
    expect(granted.status).toBe(200);

    /* Same file from an unregistered client: WAR gate, 404. */
    const anon = await serveExtensionAsset(sub.req, sub.url, { nav: false, clientId: "stranger" });
    expect(anon.status).toBe(404);
  });

  it("grants self-navigation from a registered page client", async () => {
    const rec = await pageExt();
    const other = await install("OtherExt", [], { "options.html": PAGE_HTML });
    registerPageClient("crec", rec.id);
    registerPageClient("cother", other.id);
    /* other's page client cannot open rec's pages */
    const cross = reqUrl("https://sw.example" + EXT_ROUTE + rec.id + "/options.html");
    const denied = await serveExtensionAsset(cross.req, cross.url, {
      nav: true,
      clientId: "cother",
      resultingClientId: "cnew",
    });
    expect(denied.status).toBe(404);
    expect(pageClientOf("cnew")).toBeNull();
    /* own client navigates onward */
    const own = await serveExtensionAsset(cross.req, cross.url, {
      nav: true,
      clientId: "crec",
      resultingClientId: "crec2",
    });
    expect(own.status).toBe(200);
    expect(pageClientOf("crec2")).toBe(rec.id);
  });

  it("serves __page.js with the call list embedded", async () => {
    const rec = await pageExt();
    const js = reqUrl("https://sw.example" + EXT_ROUTE + rec.id + "/__page.js");
    const res = await serveExtensionAsset(js.req, js.url, { nav: false });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("zl:extPage");
    expect(body).toContain("cookies.get");
  });

  it("computes the page call list from live permissions", async () => {
    const rec = await pageExt();
    const calls = pageCallList(rec);
    expect(calls).toContain("runtime.sendMessage");
    expect(calls).toContain("storage.local.get");
    expect(calls).toContain("cookies.set");
    expect(calls).not.toContain("notifications.create");
    expect(calls).not.toContain("tabs.query");
  });

  it("walks whitelisted namespaces and refuses events, ports, and others", async () => {
    const rec = await pageExt();
    const set = await handleExtPageCall(rec, null, {
      path: ["storage", "local", "set"],
      args: [{ k: 1 }],
    });
    expect(set.ok).toBe(true);
    const get = await handleExtPageCall(rec, null, {
      path: ["storage", "local", "get"],
      args: ["k"],
    });
    expect(get.ok).toBe(true);
    expect(get.response).toEqual({ k: 1 });

    const tabs = await handleExtPageCall(rec, null, { path: ["tabs", "query"], args: [{}] });
    expect(tabs.ok).toBe(false);
    const ev = await handleExtPageCall(rec, null, { path: ["notifications", "onClicked"], args: [] });
    expect(ev.ok).toBe(false);
    const port = await handleExtPageCall(rec, null, { path: ["runtime", "connect"], args: [] });
    expect(port.ok).toBe(false);
    const prop = await handleExtPageCall(rec, null, { path: ["runtime", "id"], args: [] });
    expect(prop.ok).toBe(false);
    const badPath = await handleExtPageCall(rec, null, { path: [1, 2], args: [] });
    expect(badPath.ok).toBe(false);
  });

  it("mounts page cookies only with the permission", async () => {
    const noPerms = await install("NoCookiesPage", [], { "options.html": PAGE_HTML });
    const refused = await handleExtPageCall(noPerms, null, {
      path: ["cookies", "get"],
      args: [{ url: "https://example.com/", name: "a" }],
    });
    expect(refused.ok).toBe(false);
  });

  it("delivers page sendMessage with an extension-page sender", async () => {
    const rec = await pageExt();
    let seen: { msg: unknown; sender: unknown } | null = null;
    const off = MESSENGER.onMessage(rec.id, (m, sender, sendResponse) => {
      seen = { msg: m, sender };
      sendResponse("pong");
      return true;
    });
    const r = await handleExtPageCall(rec, "https://sw.example" + EXT_ROUTE + rec.id + "/options.html", {
      path: ["runtime", "sendMessage"],
      args: [{ hi: 1 }],
    });
    off();
    expect(r.ok).toBe(true);
    expect(r.response).toBe("pong");
    expect(seen).not.toBeNull();
    expect((seen as unknown as { sender: { context: string } }).sender.context).toBe("extension-page");
  });
});
