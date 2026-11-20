import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import {
  rootedPageGrant,
  serveRootedExtPage,
  mintPageToken,
  registerPageClient,
  pageClientOf,
  EXT_ROUTE,
} from "../serve";
import { dispatchExtControl } from "../control";
import { PAGE_BRIDGE_SOURCE } from "../pagebridge";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

const PAGE_HTML = "<html><head><title>opts</title></head><body>options</body></html>";

/* Install ids derive from manifest bytes, so each install needs a
   unique manifest. */
let seq = 0;

/* Options-page fixture: the manifest must DECLARE the options page
   for zl:openExtPage to resolve it. */
async function optsPageExt(): Promise<ExtensionRecord> {
  await extensions.startup();
  const manifest = {
    manifest_version: 2,
    name: "RootedPage #" + seq++,
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

function rootedUrl(id: string, path: string, tok: string): { req: Request; url: URL } {
  const q = tok ? "?zlExt=" + id + "&zlPageTok=" + tok : "?zlExt=" + id;
  const href = "https://sw.example" + path + q;
  return { req: new Request(href), url: new URL(href) };
}

describe("rooted extension pages (#560)", () => {
  it("grants a valid token and serves the page rooted with a base tag", async () => {
    const rec = await optsPageExt();
    const tok = mintPageToken(rec.id, "/options.html");
    const page = rootedUrl(rec.id, "/options.html", tok);
    const grant = rootedPageGrant(page.req, page.url, undefined);
    expect(grant).toEqual({ extId: rec.id, path: "/options.html" });
    const served = await serveRootedExtPage(grant!, "rc1");
    expect(served.status).toBe(200);
    const body = await served.text();
    expect(body).toContain('<base href="' + EXT_ROUTE + rec.id + '/">');
    /* The base tag must precede the page bridge script. */
    expect(body.indexOf('<base href=')).toBeLessThan(body.indexOf("__page.js"));
    expect(body).toContain("options");
    expect(pageClientOf("rc1")).toBe(rec.id);
  });

  it("fails through (null) for unknown extensions and non-HTML paths", async () => {
    const rec = await optsPageExt();
    const tok = mintPageToken(rec.id, "/options.html");
    const unknown = rootedUrl("f".repeat(32), "/options.html", tok);
    expect(rootedPageGrant(unknown.req, unknown.url, undefined)).toBeNull();
    const wrongPath = rootedUrl(rec.id, "/options.js", tok);
    expect(rootedPageGrant(wrongPath.req, wrongPath.url, undefined)).toBeNull();
  });

  it("fails closed like an unknown extension when the token is wrong", async () => {
    const rec = await optsPageExt();
    const garbage = rootedUrl(rec.id, "/options.html", "deadbeef");
    expect(rootedPageGrant(garbage.req, garbage.url, undefined)).toBeNull();
    /* A token minted for a different path does not grant this page. */
    const crossPath = rootedUrl(rec.id, "/options.html", mintPageToken(rec.id, "/other.html"));
    expect(rootedPageGrant(crossPath.req, crossPath.url, undefined)).toBeNull();
  });

  it("grants self-navigation from a registered page client without a token", async () => {
    const rec = await optsPageExt();
    const self = rootedUrl(rec.id, "/options.html", "");
    expect(rootedPageGrant(self.req, self.url, "pageclient1")).toBeNull();
    registerPageClient("pageclient1", rec.id);
    const grant = rootedPageGrant(self.req, self.url, "pageclient1");
    expect(grant).toEqual({ extId: rec.id, path: "/options.html" });
    const served = await serveRootedExtPage(grant!, "pageclient2");
    expect(served.status).toBe(200);
    expect(pageClientOf("pageclient2")).toBe(rec.id);
  });

  it("refuses non-navigation methods", async () => {
    const rec = await optsPageExt();
    const tok = mintPageToken(rec.id, "/options.html");
    const href = "https://sw.example/options.html?zlExt=" + rec.id + "&zlPageTok=" + tok;
    expect(rootedPageGrant(new Request(href, { method: "POST" }), new URL(href), undefined)).toBeNull();
  });

  it("mints a rooted URL from zl:openExtPage", async () => {
    const rec = await optsPageExt();
    const replies: unknown[] = [];
    await dispatchExtControl(
      { type: "zl:openExtPage", extId: rec.id, which: "options" } as never,
      { e: {} as ExtendableMessageEvent, reply: (p: unknown) => replies.push(p) },
    );
    const r = replies[0] as { ok: boolean; url?: string };
    expect(r.ok).toBe(true);
    expect(r.url!.startsWith("/options.html?zlExt=" + rec.id + "&zlPageTok=")).toBe(true);
    /* The rooted URL never carries the /zl-ext/ route. */
    expect(r.url!.indexOf(EXT_ROUTE)).toBe(-1);
    const u = new URL("https://sw.example" + r.url!);
    const grant = rootedPageGrant(new Request(u.href), u, undefined);
    expect(grant).not.toBeNull();
    const served = grant ? await serveRootedExtPage(grant, "open9") : null;
    expect(served!.status).toBe(200);
    expect(await served!.text()).toContain("options");
  });

  it("pins the page-bridge parity surface in source", () => {
    expect(PAGE_BRIDGE_SOURCE).toContain("browser.runtime.getManifest = function () {");
    expect(PAGE_BRIDGE_SOURCE).toContain('typeof args[args.length - 1] === "function"');
    expect(PAGE_BRIDGE_SOURCE).toContain('"zlExt=" + cfg.ext');
  });
});

/* Fragment-link guard: the #560 base tag must not turn fragment-only
   hrefs into tab-leaving navigations to the package root. Rooted
   extension pages reproduce the reported defect exactly (the served
   page's own UI is full of href="#" anchors), so the guard's
   real-origin replay semantics get a behavior-level test here, driven
   through the real PAGE_BRIDGE_SOURCE in a DOM-free sandbox. */
describe("fragment-link guard (rooted extension pages)", () => {
  type ClickH = (ev: {
    defaultPrevented: boolean;
    preventDefault(): void;
    target: { closest(sel: string): { getAttribute(n: string): string } | null };
  }) => void;

  function install(
    docUrl: string,
  ): {
    handler: ClickH | null;
    hashReplays: string[];
    scrolls: number[];
  } {
    const id = "a".repeat(31) + "b";
    let handler: ClickH | null = null;
    const hashReplays: string[] = [];
    const scrolls: number[] = [];
    const document = {
      baseURI: "https://sw.example" + EXT_ROUTE + id + "/",
      addEventListener(type: string, fn: ClickH, capture: boolean) {
        if (type === "click" && capture === true) handler = fn;
      },
    };
    const location = {
      href: docUrl,
      set hash(v: string) {
        hashReplays.push(v);
      },
    };
    const window = { scrollTo(x: number, y: number) { scrolls.push(x, y); } };
    const installBridge = new Function(
      "ZL_PAGE_CFG", "window", "navigator", "MessageChannel", "document", "location",
      PAGE_BRIDGE_SOURCE,
    ) as (cfg: unknown, win: unknown, nav: unknown, ch: typeof MessageChannel, doc: unknown, loc: unknown) => void;
    installBridge(
      { ext: id, calls: [] },
      window,
      { serviceWorker: { controller: null } },
      MessageChannel,
      document,
      location,
    );
    return { handler, hashReplays, scrolls };
  }

  function click(
    h: ClickH,
    href: string,
  ): { prevented: boolean } {
    let prevented = false;
    h({
      defaultPrevented: false,
      preventDefault() { prevented = true; },
      target: {
        closest() {
          return { getAttribute() { return href; } };
        },
      },
    });
    return { prevented };
  }

  const ROOTED = "https://sw.example/options.html?zlExt=" + "a".repeat(31) + "b" + "&zlPageTok=t";

  it("replays a fragment-only href as a same-document navigation on rooted pages", () => {
    const sandbox = install(ROOTED);
    expect(sandbox.handler).not.toBeNull();
    const r = click(sandbox.handler!, "#");
    /* The default must be suppressed: the resolved package-root
       navigation never leaves through the browser. */
    expect(r.prevented).toBe(true);
    expect(sandbox.hashReplays).toEqual([""]);
    expect(sandbox.scrolls).toEqual([0, 0]);
    const r2 = click(sandbox.handler!, "#nav=scripts");
    expect(r2.prevented).toBe(true);
    expect(sandbox.hashReplays).toEqual(["", "nav=scripts"]);
  });

  it("leaves same-document and non-fragment hrefs to the browser", () => {
    const sandbox = install(ROOTED);
    /* A package-served page (base equals the document URL): the
       browser's own same-document navigation is correct. */
    const r1 = click(sandbox.handler!, "options.html?q=1#x");
    expect(r1.prevented).toBe(false);
    expect(sandbox.hashReplays).toEqual([]);
    const r2 = click(sandbox.handler!, "");
    expect(r2.prevented).toBe(false);
    const r3 = click(sandbox.handler!, "#locked");
    /* Rewritten onto the document hash, like a real origin. */
    expect(r3.prevented).toBe(true);
    expect(sandbox.hashReplays).toEqual(["locked"]);
  });

  it("skips clicks whose default was already prevented", () => {
    const sandbox = install(ROOTED);
    let prevented = false;
    (sandbox.handler as unknown as (ev: unknown) => void)({
      defaultPrevented: true,
      preventDefault() { prevented = true; },
      target: null,
    });
    expect(prevented).toBe(false);
    expect(sandbox.hashReplays).toEqual([]);
  });
});
