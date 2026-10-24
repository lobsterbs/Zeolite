import { describe, expect, it, vi, beforeEach } from "vitest";

/* Cloudflare cdn-cgi verbatim transit + #414 fetch/XHR HTML body
   preservation. Two contracts: (1) isCdnCgiUrl classifies the cdn-cgi
   edge namespace and nothing else; (2) rewriteStream with
   injectInit=false keeps the URL pass but never splices the document
   init, so a programmatic HTML-typed read survives byte intact -
   while the default (document navigations) keeps splicing. */

vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
    add_injection(_p: string) {}
    set_blocked_hosts(_h: string[]) {}
    set_lazy_images() {}
  }
  class JsCssRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
  }
  return {
    JsRewriter,
    JsCssRewriter,
    rewriteCss: (css: string) => css,
    rewriteJsBody: (js: string) => js,
    globalsStats: () => "0,0,0",
    default: async () => {},
  };
});

import { isCdnCgiUrl } from "../transit";
import { initTransform, rewriteStream } from "../transform";
import { initScript } from "../pageload";
import type { TransformDeps } from "../transform";

const BASE = "https://target.example/page";
const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  const r = s.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return out;
}

const siteScript = vi.fn(async (_base: string) => null);

function deps(): TransformDeps {
  return {
    routeReady: () => Promise.resolve(),
    routeKey: () => "a2V5",
    fpScript: () => null,
    siteScript,
    setDegraded: vi.fn((_reason: string) => {}),
    lazyImages: () => false,
  };
}

beforeEach(() => {
  siteScript.mockClear();
  (globalThis as unknown as { self: unknown }).self = {
    location: { origin: "https://engine.example", href: "https://engine.example/sw.js" },
  };
  initTransform(deps());
});

describe("isCdnCgiUrl (cdn-cgi native transit)", () => {
  it("classifies cdn-cgi paths on any http(s) host", () => {
    expect(isCdnCgiUrl("https://claude.ai/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=x")).toBe(true);
    expect(isCdnCgiUrl("https://example.com/cdn-cgi/")).toBe(true);
    expect(isCdnCgiUrl("http://example.com/cdn-cgi/trace/")).toBe(true);
  });

  it("rejects everything outside the namespace", () => {
    expect(isCdnCgiUrl("https://claude.ai/")).toBe(false);
    expect(isCdnCgiUrl("https://example.com/cdn-cgi-something/")).toBe(false);
    expect(isCdnCgiUrl("https://example.com/foo/cdn-cgi/x")).toBe(false);
    expect(isCdnCgiUrl("about:blank")).toBe(false);
    expect(isCdnCgiUrl("not a url")).toBe(false);
    expect(isCdnCgiUrl("")).toBe(false);
  });
});

describe("rewriteStream injectInit (#414)", () => {
  const DOC = '<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>';

  it("splices the init by default (documents keep the bootstrap)", async () => {
    const out = await readAll(rewriteStream(streamOf([DOC]), BASE, {}, [], "text/html"));
    expect(out).toContain(initScript(BASE, null));
  });

  it("keeps the body byte intact with injectInit=false and injects nothing", async () => {
    const out = await readAll(rewriteStream(streamOf([DOC]), BASE, {}, [], "text/html", undefined, false));
    expect(out).toBe(DOC);
    expect(out).not.toContain("__ZL");
  });

  it("preserves a plain-text HTML-typed API body (the catbox shape)", async () => {
    const body = "https://files.catbox.moe/ilxf5f.mp4";
    const out = await readAll(rewriteStream(streamOf([body]), BASE, {}, [], "text/html", undefined, false));
    expect(out).toBe(body);
  });
});
