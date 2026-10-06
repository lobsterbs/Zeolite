import { describe, expect, it, vi, beforeEach } from "vitest";

/* Issue #86 acceptance: focused tests for the streamed and
   non-streamed response paths of the extracted transform module. The
   real wasm boundary is exercised by the wasm/browser CI jobs; the
   mock below is an identity rewriter, so these tests pin only the
   orchestration contract: init splice placement, the lazy dep seam,
   onDone, passthrough and degradation reporting. */

const mockState = vi.hoisted(() => ({ initFails: false }));

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
    default: async () => {
      if (mockState.initFails) throw new Error("wasm 404");
    },
  };
});

import { cssRewriteStream, initTransform, isCss, isHtml, isJs, rawFrom, rewriteStream } from "../transform";
import type { TransformDeps } from "../transform";
import { initScript } from "../pageload";

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

function resp(ct: string): Response {
  return new Response("", { headers: { "content-type": ct } });
}

const setDegraded = vi.fn((_reason: string) => {});
const siteScript = vi.fn(async (_base: string) => null);

function deps(): TransformDeps {
  return {
    routeReady: () => Promise.resolve(),
    routeKey: () => "a2V5",
    fpScript: () => null,
    siteScript,
    setDegraded,
  };
}

/* The wasm module cache is module state; failure-path tests need a
   fresh transform instance so the init actually runs. */
async function freshTransform() {
  vi.resetModules();
  const t = await import("../transform");
  t.initTransform(deps());
  return t;
}

beforeEach(() => {
  mockState.initFails = false;
  setDegraded.mockClear();
  siteScript.mockClear();
  (globalThis as unknown as { self: unknown }).self = {
    location: { origin: "https://engine.example", href: "https://engine.example/sw.js" },
  };
  initTransform(deps());
});

describe("content classification (#86)", () => {
  it("classifies html, xhtml, css and js bodies", () => {
    expect(isHtml(resp("text/html"))).toBe(true);
    expect(isHtml(resp("application/xhtml+xml"))).toBe(true);
    expect(isHtml(resp("text/css"))).toBe(false);
    expect(isCss(resp("text/css"))).toBe(true);
    expect(isCss(resp("text/html"))).toBe(false);
    expect(isJs(resp("text/javascript"))).toBe(true);
    expect(isJs(resp("application/javascript"))).toBe(true);
    expect(isJs(resp("text/html"))).toBe(false);
    expect(isHtml(resp("image/png"))).toBe(false);
  });
});

describe("rewriteStream (#86)", () => {
  const DOC = '<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>';
  const SPLICED = "<!DOCTYPE html>" + initScript(BASE, null) + "<html><head><title>t</title></head><body>hi</body></html>";

  it("splices the init script after the doctype on a streamed (multi-chunk) response", async () => {
    const out = await readAll(rewriteStream(streamOf([DOC.slice(0, 20), DOC.slice(20, 30), DOC.slice(30)]), BASE, {}, [], "text/html"));
    expect(out).toBe(SPLICED);
    /* the per-site script is fetched lazily through the dep seam */
    expect(siteScript).toHaveBeenCalledWith(BASE);
  });

  it("non-streamed single-chunk response gets the same splice", async () => {
    const out = await readAll(rewriteStream(streamOf([DOC]), BASE, {}, [], "text/html; charset=utf-8"));
    expect(out).toBe(SPLICED);
  });

  it("prefers the active fingerprint script and skips the site lookup", async () => {
    initTransform({
      routeReady: () => Promise.resolve(),
      routeKey: () => "a2V5",
      fpScript: () => "/*fp*/",
      siteScript,
      setDegraded,
    });
    const out = await readAll(rewriteStream(streamOf([DOC]), BASE, {}, [], "text/html"));
    expect(out).toContain("/*fp*/");
    expect(siteScript).not.toHaveBeenCalled();
  });

  it("injects at stream start when no doctype ever arrives", async () => {
    const out = await readAll(rewriteStream(streamOf(["<html>plain</html>"]), BASE, {}, [], "text/html"));
    expect(out.startsWith(initScript(BASE, null))).toBe(true);
    expect(out.endsWith("<html>plain</html>")).toBe(true);
  });

  it("fires onDone once the stream completes", async () => {
    const done = vi.fn();
    await readAll(rewriteStream(streamOf([DOC]), BASE, {}, [], "text/html", done));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("reports wasm init failure through setDegraded and errors the stream", async () => {
    mockState.initFails = true;
    const t = await freshTransform();
    const out = t.rewriteStream(streamOf(["<html>x</html>"]), BASE, {}, [], "text/html");
    await expect(readAll(out)).rejects.toThrow("wasm 404");
    await new Promise((r) => setTimeout(r, 20));
    expect(setDegraded.mock.calls.some((c) => String(c[0]).startsWith("rewriter wasm: "))).toBe(true);
  });
});

describe("cssRewriteStream (#86)", () => {
  it("streams stylesheet chunks through and fires onDone", async () => {
    const css = "body{background:url(a.png)}";
    const done = vi.fn();
    const out = await readAll(cssRewriteStream(streamOf([css.slice(0, 10), css.slice(10)]), BASE, "text/css", done));
    expect(out).toBe(css);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("rawFrom (#86)", () => {
  it("passes the held head chunk and the rest through untouched", async () => {
    const body = streamOf(["head-", "middle-", "tail"]);
    const reader = body.getReader();
    const { value: head } = await reader.read();
    const out = await readAll(rawFrom(head, reader));
    expect(out).toBe("head-middle-tail");
  });
});

describe("transformer seams (#86)", () => {
  it("prewarm swallows init failure and reports it", async () => {
    mockState.initFails = true;
    const t = await freshTransform();
    t.prewarmRewriter();
    await new Promise((r) => setTimeout(r, 20));
    expect(setDegraded.mock.calls.some((c) => String(c[0]).startsWith("rewriter wasm: "))).toBe(true);
  });

  it("rewriteJsBody runs the one-shot pass through the seam", async () => {
    const t = await freshTransform();
    const out = await t.rewriteJsBody("var u='/x';", BASE);
    expect(out).toBe("var u='/x';");
  });
});
