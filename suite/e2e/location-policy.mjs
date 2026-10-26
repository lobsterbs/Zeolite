/* Real Chromium + generated WASM policy fixture. This checks source policy
   semantics, not live-site compatibility or the full SW/transport pipeline.
   Usage after wasm-pack build: node suite/e2e/location-policy.mjs */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const wasmDir = resolve(process.env.ZL_REWRITER_WASM_DIR ?? "app/src/rewriter_wasm");
const server = createServer(async (req, res) => {
  if (req.url === "/fixture") {
    res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>location policy</title>"); return;
  }
  const name = req.url?.slice(1);
  if (!["rewriter_wasm.js", "rewriter_wasm_bg.wasm"].includes(name)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader("content-type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    res.end(await readFile(resolve(wasmDir, name)));
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  const result = await page.evaluate(async () => {
    const mod = await import("/rewriter_wasm.js"); await mod.default();
    globalThis.__zl = { pathname: "/virtual/page", href: "https://page.example/virtual/page" };
    const run = (mode, cap, source) => {
      const rw = new mod.JsRewriter(location.origin, "https://page.example/virtual/page", "/j/", "b64u");
      try {
        rw.set_location_policy(mode, cap);
        const out = rw.rewrite_script(source);
        return { value: Function(out)(), out, events: rw.take_location_events() };
      } finally { rw.free(); }
    };
    const script = "(function(){ return window.location.pathname })()";
    const expression = (mode, cap) => {
      const r = run(mode, cap, "globalThis.__result = " + script);
      return { ...r, value: globalThis.__result };
    };
    const rw = new mod.JsRewriter(location.origin, "https://page.example/virtual/page", "/j/", "b64u");
    rw.set_location_policy("hybrid", 524288);
    const inline = rw.process('<div onclick="location.pathname"></div><script>globalThis.__inline=location.pathname</script>') + rw.finish();
    const inlineEvents = rw.take_location_events(); rw.free();
    document.open(); document.write(inline); document.close();
    return {
      direct: location.pathname,
      legacy: expression("legacy", 2097152), hybrid: expression("hybrid", 524288),
      off: expression("off", 524288), capped: expression("hybrid", 8),
      shadowed: run("hybrid", 524288, '(function(){const location={pathname:"local"}; globalThis.__shadow=location.pathname})()').events,
      shadowValue: globalThis.__shadow, inline: globalThis.__inline, inlineEvents,
      attribute: document.querySelector("div").getAttribute("onclick"),
    };
  });
  assert.equal(result.direct, "/fixture");
  assert.equal(result.legacy.value, "/virtual/page");
  assert.equal(result.hybrid.value, "/virtual/page");
  assert.equal(result.off.value, result.direct);
  assert.equal(result.capped.value, result.direct);
  assert.equal(result.capped.events, "size-cap");
  assert.equal(result.shadowed, "no-reads"); assert.equal(result.shadowValue, "local");
  assert.equal(result.inline, "/virtual/page"); assert.equal(result.inlineEvents, "rewritten");
  assert.equal(result.attribute, "location.pathname");
  console.log("PASS location policy: Chromium + WASM legacy/hybrid/off/cap, shadowing and inline semantics");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
