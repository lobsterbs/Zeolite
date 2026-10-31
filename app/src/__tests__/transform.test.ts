import { describe, expect, it, vi, beforeEach } from "vitest";

/* Issue #86 acceptance: focused tests for the streamed and
   non-streamed response paths of the extracted transform module. The
   real wasm boundary is exercised by the wasm/browser CI jobs; the
   mock below is an identity rewriter, so these tests pin only the
   orchestration contract: init splice placement, the lazy dep seam,
   onDone, passthrough and degradation reporting. */

const mockState = vi.hoisted(() => ({ initFails: false, base: undefined as string | undefined }));

vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
    /* #532: the effective-base export seam; tests set the folded
       base through mockState. */
    take_base() {
      return mockState.base;
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
    /* #235: cumulative globals-pass counters the diag seam diffs */
    globalsStats: () => "0,0,0",
    default: async () => {
      if (mockState.initFails) throw new Error("wasm 404");
    },
  };
});

import { cssRewriteStream, initTransform, isCss, isHtml, isJs, rawFrom, rewriteStream } from "../transform";
import { activeStreams } from "../streams-alive";
import type { TransformDeps } from "../transform";
import { initScript, vPath } from "../pageload";

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
    lazyImages: () => false,
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
  mockState.base = undefined;
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

  it("decodes a split UTF-16 BOM before a conflicting HTML header", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...Array.from(DOC).flatMap(ch => [ch.charCodeAt(0), 0])]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1, 2)); c.enqueue(bytes.slice(2)); c.close(); },
    });
    expect(await readAll(rewriteStream(stream, BASE, {}, [], "text/html; charset=utf-8"))).toBe(SPLICED);
  });

  it("keeps UTF-8 text when a split BOM contradicts a legacy charset header", async () => {
    const html = "<html><body>café</body></html>";
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(html)]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1, 2)); c.enqueue(bytes.slice(2)); c.close(); },
    });
    const out = await readAll(rewriteStream(stream, BASE, {}, [], "text/html; charset=windows-1252"));
    expect(out).toContain("café");
    expect(out).not.toContain("ï»¿");
  });

  it("prefers the active fingerprint script and skips the site lookup", async () => {
    initTransform({
      routeReady: () => Promise.resolve(),
      routeKey: () => "a2V5",
      fpScript: () => "/*fp*/",
      siteScript,
      setDegraded,
      lazyImages: () => false,
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

/* #201: a cancelled consumer must propagate to the upstream reader,
   and a pre-pump rejection must settle the #99 heartbeat instead of
   pinning the worker with it armed. */
describe("stream lifecycle (#201)", () => {
  it("rawFrom cancels the upstream reader when the consumer cancels", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("head-"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reader = body.getReader();
    const { value: head } = await reader.read();
    const wrapped = rawFrom(head, reader);
    const r = wrapped.getReader();
    expect(new TextDecoder().decode((await r.read()).value!)).toBe("head-");
    await r.cancel();
    await new Promise((res) => setTimeout(res, 20));
    expect(cancelled).toBe(true);
  });

  it("rewriteStream cancels the upstream reader when the consumer cancels", async () => {
    const DOC = "<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>";
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(DOC));
      },
      cancel() {
        cancelled = true;
      },
    });
    const wrapped = rewriteStream(body, BASE, {}, [], "text/html; charset=utf-8");
    const r = wrapped.getReader();
    expect(new TextDecoder().decode((await r.read()).value!)).toContain("<!DOCTYPE html>");
    await r.cancel();
    await new Promise((res) => setTimeout(res, 20));
    expect(cancelled).toBe(true);
  });

  it("rewriteStream settles the heartbeat when the pre-pump await rejects", async () => {
    initTransform({
      routeReady: () => Promise.reject(new Error("no key")),
      routeKey: () => "a2V5",
      fpScript: () => null,
      siteScript,
      setDegraded,
      lazyImages: () => false,
    });
    const out = rewriteStream(streamOf(["<html>x</html>"]), BASE, {}, [], "text/html");
    await expect(readAll(out)).rejects.toThrow("no key");
    await new Promise((res) => setTimeout(res, 20));
    expect(activeStreams()).toBe(0);
  });

  it("cssRewriteStream cancels the upstream reader when the consumer cancels", async () => {
    let cancelled = false;
    const css = "/*" + "x".repeat(70) + "*/body{background:url(a.png)}";
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(css));
      },
      cancel() {
        cancelled = true;
      },
    });
    const wrapped = cssRewriteStream(body, BASE, "text/css");
    const r = wrapped.getReader();
    expect(new TextDecoder().decode((await r.read()).value!)).toContain("body{background:url(a.png)}");
    await r.cancel();
    await new Promise((res) => setTimeout(res, 20));
    expect(cancelled).toBe(true);
  });
});


describe("rewriteStream (#531 sri collector)", () => {
  it("collects script and stylesheet integrity pairs from a served document", async () => {
    const notes: Array<[string, string]> = [];
    const doc =
      '<html><head><script src="/a.js" integrity="sha256-AAA"></script>' +
      '<link rel="stylesheet" href="/s.css" integrity="sha512-BBB"></head><body>hi</body></html>';
    await readAll(
      rewriteStream(streamOf([doc]), BASE, {}, [], "text/html", undefined, true, (abs, integ) =>
        notes.push([abs, integ]),
      ),
    );
    expect(notes).toEqual([
      ["https://target.example/a.js", "sha256-AAA"],
      ["https://target.example/s.css", "sha512-BBB"],
    ]);
  });

  it("holds a tag split across chunks and skips collection for fetch/XHR html", async () => {
    const notes: Array<[string, string]> = [];
    const doc = '<html><head><script src="/split.js" integrity="sha256-K"></script></head></html>';
    await readAll(
      rewriteStream(streamOf([doc.slice(0, 22), doc.slice(22)]), BASE, {}, [], "text/html", undefined, true, (abs, integ) =>
        notes.push([abs, integ]),
      ),
    );
    expect(notes).toEqual([["https://target.example/split.js", "sha256-K"]]);
    const none: Array<[string, string]> = [];
    await readAll(
      rewriteStream(streamOf([doc]), BASE, {}, [], "text/html", undefined, false, (abs, integ) =>
        none.push([abs, integ]),
      ),
    );
    expect(none).toEqual([]);
  });
});

describe("effective base delivery (#532)", () => {
  const DOC = '<!DOCTYPE html><html><head><base href="x"></head><body>hi</body></html>';

  it("vPath is the hostless destination path", () => {
    expect(vPath("https://cdn.example/assets/dir/?q=1#f")).toBe("/assets/dir/?q=1#f");
    expect(vPath("ftp://x.example/a")).toBe("");
    expect(vPath("not a url")).toBe("");
  });

  it("drains the folded base once per distinct value through onVbase", async () => {
    mockState.base = "https://cdn.example/assets/dir/";
    const seen: string[] = [];
    const out = await readAll(
      rewriteStream(
        streamOf([DOC.slice(0, 30), DOC.slice(30)]),
        BASE, {}, [], "text/html",
        undefined, true, undefined, undefined,
        (vb) => seen.push(vb),
      ),
    );
    expect(out).toContain("<base");
    /* hostless form only: the engine origin and the real host never ride the message */
    expect(seen).toEqual(["/assets/dir/"]);
  });

  it("never fires onVbase without a folded base", async () => {
    const seen: string[] = [];
    await readAll(
      rewriteStream(
        streamOf([DOC]), BASE, {}, [], "text/html",
        undefined, true, undefined, undefined,
        (vb) => seen.push(vb),
      ),
    );
    expect(seen).toEqual([]);
  });
});
