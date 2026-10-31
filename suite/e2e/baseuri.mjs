/* Real Chromium + generated WASM document.baseURI fixture (#532).
   Checks the rewrite pass and the effective-base export against the
   direct (unproxied) control, not the full SW/transport pipeline:
   the page-side view contract is unit-gated in vloc.test.ts, the
   delivery seam in transform.test.ts. Usage after wasm-pack build:
   node suite/e2e/baseuri.mjs */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const wasmDir = resolve(process.env.ZL_REWRITER_WASM_DIR ?? "app/src/rewriter_wasm");
const server = createServer(async (req, res) => {
  if (req.url === "/fixture") {
    res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>base</title>"); return;
  }
  const name = req.url?.slice(1);
  if (!["rewriter_wasm.js", "rewriter_wasm_bg.wasm"].includes(name)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader("content-type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    res.end(await readFile(resolve(wasmDir, name)));
  } catch { res.writeHead(500).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  const result = await page.evaluate(async () => {
    const mod = await import("/rewriter_wasm.js"); await mod.default();
    const BASE = "https://page.example/dir/page.html";
    /* The page-side virtual view: host opaque (engine origin), real
       base path visible - the #144 relaxation. */
    globalThis.__zl = {
      href: "https://engine.host/dir/page.html",
      baseURI: "https://engine.host/dir/assets/",
    };
    const rw = (mode = "hybrid") => {
      const r = new mod.JsRewriter(location.origin, BASE, "/j/", "b64u");
      r.set_location_policy(mode, 524288);
      return r;
    };
    const run = (source, mode) => {
      const r = rw(mode);
      const out = r.rewrite_script(source);
      r.free();
      return out;
    };
    const ev = (source) => {
      /* evaluate the rewritten source and return its value */
      globalThis.__probe = undefined;
      Function(run("globalThis.__probe = " + source))();
      return globalThis.__probe;
    };
    /* The three document URL reflections rename together (#532). */
    const reflections = {
      url: ev("document.URL"),
      documentURI: ev("document.documentURI"),
      baseURI: ev("document.baseURI"),
    };
    const bracketForms = {
      baseURI: ev("document['baseURI']"),
      url: ev('document["URL"]'),
    };
    /* Writes, deletes and update targets stay native. */
    const nativeForms = {
      write: run("document.baseURI = '/x';"),
      del: run("delete document.baseURI;"),
      update: run("document.baseURI++;"),
      shadow: run("(function(document){ return document.baseURI; })"),
    };
    /* Script-created URLs: relative resolution against the virtual
       base must agree with the direct control resolution. */
    const resolveProxied = new URL("img/x.png", globalThis.__zl.baseURI).href;
    const resolveDirect = new URL("img/x.png", "https://page.example/dir/assets/").href;
    /* Dynamic base change: the view moves, resolution follows. */
    globalThis.__zl.baseURI = "https://engine.host/other/";
    const dynamicProxied = new URL("img/x.png", ev("document.baseURI")).href;
    const dynamicDirect = new URL("img/x.png", "https://page.example/other/").href;
    /* The rewriter-side export: the folded absolute base after the
       first <base href>, None before any base, first base only. */
    const r1 = rw();
    const before = r1.take_base();
    r1.process('<head><title>t</title>');
    const midBase = r1.take_base();
    r1.process('<base href="assets/"><base href="https://ignored.example/"></head>');
    const folded = r1.take_base();
    const afterSecond = r1.take_base();
    r1.finish(); r1.free();
    /* Nested documents: the srcdoc sub-rewrite renames the read too
       (the runtime installs the faithful about: view there; unit
       gated in vloc.test.ts, so pin the rewrite property here). */
    const r2 = rw();
    const nested = r2.process('<iframe srcdoc="<script>var b = document.baseURI;</script>"></iframe>');
    r2.finish(); r2.free();
    /* Off policy keeps the native reads. */
    const off = (() => {
      globalThis.__probe = undefined;
      Function(run("globalThis.__probe = document.baseURI", "off"))();
      return globalThis.__probe;
    })();
    return {
      reflections, bracketForms, nativeForms,
      resolveProxied, resolveDirect,
      dynamicProxied, dynamicDirect,
      before, midBase, folded, afterSecond,
      nested: nested.includes("__zl.baseURI"),
      nestedKeepsNative: !nested.includes("var b = document.baseURI"),
      off,
      nativeBase: document.baseURI,
    };
  });
  /* The three reflections read the virtual view. */
  assert.equal(result.reflections.url, "https://engine.host/dir/page.html");
  assert.equal(result.reflections.documentURI, "https://engine.host/dir/page.html");
  assert.equal(result.reflections.baseURI, "https://engine.host/dir/assets/");
  assert.equal(result.bracketForms.baseURI, "https://engine.host/dir/assets/");
  assert.equal(result.bracketForms.url, "https://engine.host/dir/page.html");
  /* Writes/deletes/updates/shadowing stay native. */
  assert.equal(result.nativeForms.write, "document.baseURI = '/x';");
  assert.equal(result.nativeForms.del, "delete document.baseURI;");
  assert.equal(result.nativeForms.update, "document.baseURI++;");
  assert.ok(result.nativeForms.shadow.includes("document.baseURI"), result.nativeForms.shadow);
  /* Direct-vs-proxied resolution agreement (path equality; the host
     is opaque by design, the resolution semantics must agree). */
  assert.equal(new URL(result.resolveProxied).pathname, new URL(result.resolveDirect).pathname);
  assert.equal(new URL(result.dynamicProxied).pathname, new URL(result.dynamicDirect).pathname);
  /* The folded base export: first base only, absolute, None before. */
  assert.equal(result.before, undefined);
  assert.equal(result.midBase, undefined);
  assert.equal(result.folded, "https://page.example/dir/assets/");
  assert.equal(result.afterSecond, "https://page.example/dir/assets/");
  /* Nested srcdoc renames; the off policy keeps native reads. */
  assert.equal(result.nested, true);
  assert.equal(result.nestedKeepsNative, true);
  /* off policy: the native read stays native (the fixture page
     own URL; no base element). */
  assert.equal(result.off, result.nativeBase);
  console.log("PASS baseuri: Chromium + WASM document.URL/documentURI/baseURI renames, resolution parity, folded base export");
} finally {
  await browser?.close(); await new Promise((r) => server.close(r));
}
