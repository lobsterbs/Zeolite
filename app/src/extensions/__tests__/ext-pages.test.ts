import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import {
  serveExtensionAsset,
  parseServePath,
  mintPageToken,
  registerPageClient,
  pageClientOf,
  rootedPageGrant,
  serveRootedExtPage,
  EXT_ROUTE,
} from "../serve";
import { handleExtPageCall, pageCallList, pageNamespaceList } from "../pageapi";
import { PAGE_BRIDGE_SOURCE } from "../pagebridge";
import { MESSENGER } from "../context";
import { dispatchExtControl } from "../control";
import { idleTerminate } from "../background";
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

/* Options-page fixture: the manifest must DECLARE the options page
   for zl:openExtPage to resolve it (pageExt only ships the file). */
async function optsPageExt(): Promise<ExtensionRecord> {
  await extensions.startup();
  const manifest = {
    manifest_version: 2,
    name: "OptsPage #" + seq++,
    version: "1.0",
    permissions: [],
    options_page: "options.html",
  };
  const m = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["options.html", enc.encode(PAGE_HTML)],
  ]);
  const { id } = await extensions.installFiles(m);
  return extensions.get(id)!;
}

async function pageExt(): Promise<ExtensionRecord> {
  return install("PageExt", ["cookies", "storage"], {
    "options.html": PAGE_HTML,
    "secret.js": "var notForTheWeb = 1;",
  });
}

async function messagePageExt(): Promise<ExtensionRecord> {
  await extensions.startup();
  const manifest = {
    manifest_version: 3,
    name: "PageMessaging #" + seq++,
    version: "1.0",
    permissions: [],
    options_page: "options.html",
    background: { service_worker: "sw.js" },
  };
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["options.html", enc.encode(PAGE_HTML)],
    ["sw.js", enc.encode(
      "browser.runtime.onMessage.addListener(function (m, sender, sendResponse) {" +
      "if (m.kind === 'none') return undefined;" +
      "if (m.kind === 'false') return false;" +
      "setTimeout(function () { sendResponse({ pong: m.kind }); }, 5);" +
      "return true;" +
      "});",
    )],
  ]);
  const { id } = await extensions.installFiles(files);
  return extensions.get(id)!;
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

  it("routes delayed, false and no-reply background responses back through the extension-page RPC (#573)", async () => {
    const rec = await messagePageExt();
    const clientId = "page-send-" + seq++;
    registerPageClient(clientId, rec.id);
    const pending: Promise<unknown>[] = [];
    const replies: unknown[] = [];
    const e = {
      source: { id: clientId, url: "https://sw.example/options.html" },
      ports: [],
      waitUntil(p: Promise<unknown>) { pending.push(p); },
    } as unknown as ExtendableMessageEvent;

    const send = async (kind: string) => {
      await dispatchExtControl({
        type: "zl:extPage",
        extId: rec.id,
        msg: { path: ["runtime", "sendMessage"], args: [{ kind }] },
      } as never, { e, reply: (value) => replies.push(value) });
      await Promise.all(pending.splice(0));
      return replies.pop();
    };

    try {
      expect(await send("ping")).toEqual({ ok: true, response: { pong: "ping" } });
      expect(await send("false")).toEqual({ ok: true, response: false });
      expect(await send("none")).toEqual({ ok: true, response: undefined });
    } finally {
      idleTerminate(rec.id);
    }
  });

  it("page bridge resolves both the returned promise and trailing callback (#573)", async () => {
    const page: Record<string, unknown> = {};
    const controller = {
      postMessage(_message: unknown, ports: MessagePort[]) {
        queueMicrotask(() => ports[0].postMessage({ ok: true, response: "pong" }));
      },
    };
    const installBridge = new Function(
      "ZL_PAGE_CFG", "window", "navigator", "MessageChannel", PAGE_BRIDGE_SOURCE,
    ) as (cfg: unknown, win: unknown, nav: unknown, channel: typeof MessageChannel) => void;
    installBridge(
      { ext: "e".repeat(32), calls: ["runtime.sendMessage"] },
      page,
      { serviceWorker: { controller } },
      MessageChannel,
    );
    let callbackReply: unknown = "pending";
    const chrome = page.chrome as { runtime: { sendMessage: (m: unknown, cb: (value: unknown) => void) => Promise<unknown> } };
    const result = await chrome.runtime.sendMessage({ method: "ping" }, (value) => { callbackReply = value; });
    expect(result).toBe("pong");
    expect(callbackReply).toBe("pong");
  });

  it("mounts page cookies and storage only with their permissions", async () => {
    const noPerms = await install("NoCookiesPage", [], { "options.html": PAGE_HTML });
    const refused = await handleExtPageCall(noPerms, null, {
      path: ["cookies", "get"],
      args: [{ url: "https://example.com/", name: "a" }],
    });
    expect(refused.ok).toBe(false);
    const noStorage = await handleExtPageCall(noPerms, null, {
      path: ["storage", "local", "get"],
      args: ["k"],
    });
    expect(noStorage.ok).toBe(false);
    expect(pageCallList(noPerms)).not.toContain("storage.local.get");
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
    /* #560: TM-class dispatchers classify by sender.id and refuse
       senders whose url is not an internal page scheme: the page
       sender must carry the id and no URL. */
    expect((seen as unknown as { sender: { id?: string } }).sender.id).toBe(rec.id);
    expect((seen as unknown as { sender: { url?: string | null } }).sender.url).toBeNull();
  });

  it("enforces MV3 scoped web_accessible_resources against the page destination (#51)", async () => {
    /* MV3 manifest: scoped.js is only for https://allowed.example. */
    const manifest = {
      manifest_version: 3,
      name: "ScopedWar",
      version: "1.0",
      web_accessible_resources: [
        { resources: ["/scoped.js"], matches: ["https://allowed.example/*"] },
      ],
    };
    await extensions.startup();
    const { id } = await extensions.installFiles(
      new Map<string, Uint8Array>([
        ["manifest.json", enc.encode(JSON.stringify(manifest))],
        ["scoped.js", enc.encode("var scoped = 1;")],
      ]),
    );
    const js = reqUrl("https://sw.example" + EXT_ROUTE + id + "/scoped.js");
    /* Page on an allowed destination: served. */
    const ok = await serveExtensionAsset(js.req, js.url, {
      nav: false,
      pageUrl: "https://allowed.example/page.html",
    });
    expect(ok.status).toBe(200);
    /* Page elsewhere: 404. */
    const denied = await serveExtensionAsset(js.req, js.url, {
      nav: false,
      pageUrl: "https://evil.example/page.html",
    });
    expect(denied.status).toBe(404);
    /* No SW-observed page destination: fails closed. */
    const anon = await serveExtensionAsset(js.req, js.url, { nav: false });
    expect(anon.status).toBe(404);
  });
});

describe("zl:openExtPage dispatch (LB #76 open-options button)", () => {
  it("mints a token-bearing URL that serves the options page", async () => {
    const rec = await optsPageExt();
    const replies: unknown[] = [];
    await dispatchExtControl(
      { type: "zl:openExtPage", extId: rec.id, which: "options" } as never,
      { e: {} as ExtendableMessageEvent, reply: (p: unknown) => replies.push(p) },
    );
    const r = replies[0] as { ok: boolean; url?: string; error?: string };
    expect(r.ok).toBe(true);
    expect(r.url).toBeTruthy();
    expect(r.url!.startsWith("/options.html?zlExt=" + rec.id + "&zlPageTok=")).toBe(true);
    const u = new URL("https://sw.example" + r.url);
    const grant = rootedPageGrant(new Request(u.href), u, undefined);
    const served = grant
      ? await serveRootedExtPage(grant, "open1")
      : new Response("zeolite: grant expected");
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("options");
    expect(pageClientOf("open1")).toBe(rec.id);
  });

  it("answers honestly for a missing page or unknown extension", async () => {
    const rec = await optsPageExt();
    const replies: unknown[] = [];
    const reply = (p: unknown) => replies.push(p);
    await dispatchExtControl(
      { type: "zl:openExtPage", extId: rec.id, which: "popup" } as never,
      { e: {} as ExtendableMessageEvent, reply },
    );
    expect(replies[0]).toMatchObject({ ok: false, error: "no such popup page" });
    await dispatchExtControl(
      { type: "zl:openExtPage", extId: "f".repeat(32), which: "options" } as never,
      { e: {} as ExtendableMessageEvent, reply },
    );
    expect(replies[1]).toMatchObject({ ok: false, error: "no such options page" });
  });
});

describe("page namespace objects (#560)", () => {
  let nseq = 0;
  async function nsExt(mv: number, perms: string[]): Promise<ExtensionRecord> {
    await extensions.startup();
    const manifest = {
      manifest_version: mv,
      name: "NsExt #" + ++nseq,
      version: "1.0",
      permissions: perms,
    };
    const { id } = await extensions.installFiles(
      new Map([["manifest.json", enc.encode(JSON.stringify(manifest))]]),
    );
    return extensions.get(id)!;
  }
  it("lists namespace objects from the manifest surface", async () => {
    expect(pageNamespaceList(await nsExt(2, ["storage"]))).toEqual(["extension"]);
    expect(pageNamespaceList(await nsExt(2, ["webRequest", "webRequestBlocking"]))).toEqual([
      "extension",
      "webRequest",
    ]);
    expect(pageNamespaceList(await nsExt(3, ["storage"]))).toEqual([]);
  });
  it("materializes cfg.ns namespaces in the page bridge source", () => {
    expect(PAGE_BRIDGE_SOURCE).toContain("cfg.ns");
    expect(PAGE_BRIDGE_SOURCE).toContain("inIncognitoContext");
  });
});
describe("extension page workers (#700)", () => {
  it("registers the worker client so its own importScripts inherit the page grant", async () => {
    const rec = await install("WkrInherit", [], {
      "options.html": PAGE_HTML,
      "lint.js": "self.lint = 1;",
      "vendor/lib.js": "self.lib = 42;",
    });
    registerPageClient("wparent700a", rec.id);
    /* the worker SCRIPT load: the parent page's client id, the new
       worker client in resultingClientId, destination "worker" */
    const wreq = new Request("https://sw.example" + EXT_ROUTE + rec.id + "/lint.js");
    const served = await serveExtensionAsset(wreq, new URL(wreq.url), {
      nav: false,
      clientId: "wparent700a",
      resultingClientId: "wworker700a",
      dest: "worker",
    });
    expect(served.status).toBe(200);
    expect(pageClientOf("wworker700a")).toBe(rec.id);
    /* the worker's own importScripts then ride the worker client id */
    const vreq = new Request("https://sw.example" + EXT_ROUTE + rec.id + "/vendor/lib.js");
    const vend = await serveExtensionAsset(vreq, new URL(vreq.url), {
      nav: false,
      clientId: "wworker700a",
      dest: "script",
    });
    expect(vend.status).toBe(200);
  });

  it("keeps the fail-closed WAR gate for a client the page never registered", async () => {
    const rec = await install("WkrClosed", [], { "vendor2.js": "self.v2 = 1;" });
    const req = new Request("https://sw.example" + EXT_ROUTE + rec.id + "/vendor2.js");
    const denied = await serveExtensionAsset(req, new URL(req.url), {
      nav: false,
      clientId: "wstranger700",
      dest: "script",
    });
    expect(denied.status).toBe(404);
    expect(pageClientOf("wstranger700")).toBeNull();
  });

  it("does not register a page client on a plain subresource fetch", async () => {
    const rec = await install("WkrPlain", [], { "plain.js": "self.p = 1;" });
    registerPageClient("wparent700b", rec.id);
    const req = new Request("https://sw.example" + EXT_ROUTE + rec.id + "/plain.js");
    const res = await serveExtensionAsset(req, new URL(req.url), {
      nav: false,
      clientId: "wparent700b",
      resultingClientId: "wother700b",
      dest: "script",
    });
    expect(res.status).toBe(200);
    expect(pageClientOf("wother700b")).toBeNull();
  });
});

describe("page bridge head injection", () => {
  async function serveHtml(html: string): Promise<{ body: string; ms: number; id: string }> {
    const rec = await install("HeadInject", [], { "p.html": html });
    const tok = mintPageToken(rec.id, "/p.html");
    const u = new URL("https://sw.example" + EXT_ROUTE + rec.id + "/p.html?zlPageTok=" + tok);
    const t = performance.now();
    const res = await serveExtensionAsset(new Request(u), u, { nav: true, resultingClientId: "hi" + seq });
    const body = await res.text();
    return { body, ms: performance.now() - t, id: rec.id };
  }

  it("injects after a head tag with attributes, never after <header>", async () => {
    const a = await serveHtml('<html><header>x</header><HEAD lang="en"><title>t</title></head></html>');
    const tag = '<script src="/zl-ext/' + a.id + '/__page.js"></script>';
    expect(a.body).toContain('<HEAD lang="en"><base');
    expect(a.body.indexOf(tag)).toBeGreaterThan(a.body.indexOf("<HEAD"));
    const b = await serveHtml("<header>only</header>");
    expect(b.body.startsWith("<base")).toBe(true);
  });

  it("stays linear on a page full of unterminated <head openers", async () => {
    const { body, ms, id } = await serveHtml("<head ".repeat(170_000));
    expect(body.startsWith('<base href="/zl-ext/' + id + '/">')).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
