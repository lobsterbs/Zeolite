/* Issue #554 (#549 child): real-Chromium acceptance for import
   map awareness. Three seams must all hold in a genuine browser:

   1. the wasm rewriter rewrites import map BODIES (mapped values
      ride engine routes, bare keys stay), so the page's own module
      scripts keep resolving bare specifiers through the rewritten map;
   2. the engine records each served document's import map, so a
      MODULE WORKER created by the page resolves its bare specifiers
      through the owning page's map at the serve seam;
   3. the recorded map honors SCOPES (the importing module for the
      worker body's top-level imports is the worker script itself)
      and MULTIPLE maps within one document merge with first-
      mapping-wins, mirroring direct-Chromium behavior.

   An unknown bare specifier must still fail natively (no invented
   resolution), and a scope map must never leak upward (a worker
   outside the scope fails on a scope-only key). Everything is
   loopback fixtures only; ports 6036/7136 never collide with
   e2e.mjs (6002/7101), guest-sw (6009/7109), vorigin (6027/7128)
   or blob-workers/vctx-restart (6034/7134). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6036;
const FX_PORT = 7136;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX = "http://127.0.0.1:" + FX_PORT;
const VIRTUAL_PAGE = FX + "/dir/page.html";
const SCOPED_PAGE = FX + "/dir/scoped.html";
const MULTI_PAGE = FX + "/dir/multi.html";

const results = [];
let engineProc = null;
const engineErr = [];
let browser = null;
let context = null;
let fx = null;
const hits = [];

async function check(name, fn) {
  try {
    const info = await fn();
    results.push({ ok: true, name, info: info ?? "" });
  } catch (e) {
    results.push({ ok: false, name, info: String(e?.message ?? e) });
  }
}

function engineTail() {
  return engineErr.slice(-20).join("").slice(0, 2500);
}

/* The page runner: boots a module worker relative to the page and
   collects its step messages; the worker URL is a parameter and each
   runner lands under its own global name so a page can host two. */
function runnerJs(workerUrl, name) {
  return [
    "window.__probe = {}; window.__log = [];",
    "window." + name + " = function () { return new Promise(function (res) {",
    "  var w = new Worker(" + JSON.stringify(workerUrl) + ", { type: 'module' });",
    "  var t = setTimeout(function () { window.__probe.worker = 'W-TIMEOUT'; res({ probe: window.__probe, log: window.__log }); }, 25000);",
    "  w.onmessage = function (ev) { var d = ev.data || {}; if (d.step === 'done') { clearTimeout(t); window.__probe.worker = 'DONE'; res({ probe: window.__probe, log: window.__log }); } else { window.__log.push(d.step + '=' + String(d.v)); } };",
    "  w.onerror = function (e) { clearTimeout(t); window.__probe.worker = 'W-ERR m=' + String(e.message || '-') + ' f=' + String(e.filename || '-') + ':' + String(e.lineno || 0) + ' x=' + String((e.error && e.error.message) || '-'); res({ probe: window.__probe, log: window.__log }); };",
    "}); };",
  ].join("\n");
}

function pageHtml() {
  const map = JSON.stringify({ imports: { mylib: FX + "/lib/lib.js", "utils/": FX + "/lib/u/" } });
  return [
    "<!doctype html><meta charset=\"utf-8\"><body>",
    "<script>" + runnerJs("worker.mjs", "__run") + "</script>",
    "<script>" + runnerJs("leakworker.mjs", "__runLeak") + "</script>",
    "<script type=\"importmap\">" + map + "</script>",
    "<script type=\"module\" src=\"page-mod.mjs\"></script>",
    "</body>",
  ].join("");
}

/* Scoped map: the /dir/sub/ scope remaps mylib and adds a
   scope-only key; the root page must not see either. */
function scopedPageHtml() {
  const map = JSON.stringify({
    imports: { mylib: FX + "/lib/lib.js" },
    scopes: {
      "/dir/sub/": { mylib: FX + "/lib/sublib.js", scopedlib: FX + "/lib/s.js" },
    },
  });
  return [
    "<!doctype html><meta charset=\"utf-8\"><body>",
    "<script>" + runnerJs("sub/worker.mjs", "__run") + "</script>",
    "<script type=\"importmap\">" + map + "</script>",
    "</body>",
  ].join("");
}

/* Two maps in one document: the second ADDS a key and must NOT
   redefine the first map's key (first mapping wins). */
function multiPageHtml() {
  const map1 = JSON.stringify({ imports: { mylib: FX + "/lib/lib.js" } });
  const map2 = JSON.stringify({ imports: { added: FX + "/lib/a.js", mylib: FX + "/lib/late.js" } });
  return [
    "<!doctype html><meta charset=\"utf-8\"><body>",
    "<script>" + runnerJs("multi-worker.mjs", "__run") + "</script>",
    "<script type=\"importmap\">" + map1 + "</script>",
    "<script type=\"importmap\">" + map2 + "</script>",
    "</body>",
  ].join("");
}

const ROOT_WORKER = [
  'import { marker } from "mylib";',
  'import { h } from "utils/helper.js";',
  'self.postMessage({ step: "boot", v: "marker=" + marker + " h=" + h });',
  '(async function () {',
  '  try { await import("missing-pkg"); self.postMessage({ step: "miss", v: "LOADED" }); }',
  '  catch (e) { self.postMessage({ step: "miss", v: "REJECTED " + String(e).slice(0, 120) }); }',
  '  self.postMessage({ step: "done", v: "done" });',
  '})();',
].join("\n");

/* The scope-leak probe: a STATIC bare import of a scope-only key
   from an importer OUTSIDE every scope. Dynamic import cannot probe
   this (the worker realm never consults any map, so a bare specifier
   always fails natively); the serve seam's static-import pass is the
   only path that could leak a scoped mapping, and a leak would make
   this worker LOAD instead of failing its module resolution. */
const LEAK_WORKER = [
  'import { s } from "scopedlib";',
  'self.postMessage({ step: "leak", v: "LOADED " + s });',
  'self.postMessage({ step: "done", v: "done" });',
].join("\n");

const SUB_WORKER = [
  'import { marker } from "mylib";',
  'import { s } from "scopedlib";',
  'self.postMessage({ step: "boot", v: "marker=" + marker + " s=" + s });',
  'self.postMessage({ step: "done", v: "done" });',
].join("\n");

const MULTI_WORKER = [
  'import { marker } from "mylib";',
  'import { a } from "added";',
  'self.postMessage({ step: "boot", v: "marker=" + marker + " added=" + a });',
  'self.postMessage({ step: "done", v: "done" });',
].join("\n");

const JS = { "content-type": "application/javascript" };

async function main() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  fx = await new Promise((resolve_) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, FX);
      hits.push(u.pathname);
      if (u.pathname === "/dir/page.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(pageHtml()); }
      else if (u.pathname === "/dir/page-mod.mjs") { res.writeHead(200, JS); res.end('import { marker } from "mylib"; window.__probe.pageImport = marker;'); }
      else if (u.pathname === "/dir/worker.mjs") { res.writeHead(200, JS); res.end(ROOT_WORKER); }
      else if (u.pathname === "/dir/leakworker.mjs") { res.writeHead(200, JS); res.end(LEAK_WORKER); }
      else if (u.pathname === "/dir/scoped.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(scopedPageHtml()); }
      else if (u.pathname === "/dir/sub/worker.mjs") { res.writeHead(200, JS); res.end(SUB_WORKER); }
      else if (u.pathname === "/dir/multi.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(multiPageHtml()); }
      else if (u.pathname === "/dir/multi-worker.mjs") { res.writeHead(200, JS); res.end(MULTI_WORKER); }
      else if (u.pathname === "/lib/lib.js") { res.writeHead(200, JS); res.end('export const marker = "LIB-MARK";'); }
      else if (u.pathname === "/lib/sublib.js") { res.writeHead(200, JS); res.end('export const marker = "SUB-LIB-MARK";'); }
      else if (u.pathname === "/lib/s.js") { res.writeHead(200, JS); res.end('export const s = "SCOPED-MARK";'); }
      else if (u.pathname === "/lib/a.js") { res.writeHead(200, JS); res.end('export const a = "ADDED-MARK";'); }
      else if (u.pathname === "/lib/late.js") { res.writeHead(200, JS); res.end('export const marker = "LATE-MARK";'); }
      else if (u.pathname === "/lib/u/helper.js") { res.writeHead(200, JS); res.end('export const h = "UTIL-MARK";'); }
      else { res.writeHead(404); res.end("no"); }
    });
    srv.listen(FX_PORT, "127.0.0.1", () => resolve_(srv));
  });
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], { env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await sleep(2500);
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => console.log("PAGE-CONSOLE " + m.type() + " " + m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("PAGE-ERROR " + String(e).slice(0, 300)));
  page.on("worker", (w) => {
    w.on("console", (m) => console.log("WORKER-CONSOLE " + m.type() + " " + m.text().slice(0, 300)));
  });
  context.on("serviceworker", (sw) => {
    sw.on("console", (m) => console.log("SW-CONSOLE " + m.type() + " " + m.text().slice(0, 300)));
  });

  /* Drive one virtual page: navigate, wait for the proxied frame,
     boot the page's runner (global name), return the collected log. */
  const drive = async (virtualUrl, globalName) => {
    await page.goto(ENGINE + "/?url=" + encodeURIComponent(virtualUrl));
    await sleep(1500);
    let frame = null;
    for (let i = 0; i < 60; i++) {
      frame = page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
      if (frame) break;
      await sleep(500);
    }
    if (!frame) throw new Error("virtual frame never appeared for " + virtualUrl);
    return await frame.evaluate("window." + (globalName || "__run") + "()");
  };

  /* --- leg 1: the plain top-level map (page + root worker) --- */
  const res = await drive(VIRTUAL_PAGE);

  await check("page module script resolves the bare specifier through the rewritten map", () => {
    const v = frame_probe(page);
    return v.then((got) => {
      if (got !== "LIB-MARK") throw new Error("pageImport=" + got);
      return "LIB-MARK";
    });
  });
  await check("module worker boots without a script error", () => {
    if (res.probe?.worker !== "DONE") throw new Error(JSON.stringify(res.probe));
    return "";
  });
  await check("worker bare specifier resolves through the recorded page map", () => {
    const boot = (res.log ?? []).find((l) => l.startsWith("boot="));
    if (!boot || !boot.includes("marker=LIB-MARK")) throw new Error("boot=" + boot);
    return boot.slice(0, 60);
  });
  await check("worker trailing-slash prefix key resolves with the remainder", () => {
    const boot = (res.log ?? []).find((l) => l.startsWith("boot="));
    if (!boot || !boot.includes("h=UTIL-MARK")) throw new Error("boot=" + boot);
    return boot.slice(0, 60);
  });
  await check("unknown bare specifier fails natively (no invented route)", () => {
    const miss = (res.log ?? []).find((l) => l.startsWith("miss="));
    if (!miss || !miss.startsWith("miss=REJECTED")) throw new Error("miss=" + miss);
    return "REJECTED";
  });

  /* A second boot on a fresh navigation of the same page: the map is
     re-recorded (reset + note), and a STATIC import of a scope-only
     key from an out-of-scope worker must fail (no leak upward). */
  const lres = await drive(VIRTUAL_PAGE, "__runLeak");
  await check("a scope-only key does not leak to a static import outside the scope", () => {
    if (lres.probe?.worker === "DONE") throw new Error("leak worker LOADED: " + JSON.stringify(lres.log));
    if (!String(lres.probe?.worker || "").startsWith("W-ERR")) throw new Error(JSON.stringify(lres.probe));
    return String(lres.probe.worker).slice(0, 80);
  });

  /* --- leg 2: scoped map --- */
  const sres = await drive(SCOPED_PAGE);

  await check("scoped worker boots without a script error", () => {
    if (sres.probe?.worker !== "DONE") throw new Error(JSON.stringify(sres.probe));
    return "";
  });
  await check("worker inside the scope resolves the scoped key and the remapped key", () => {
    const boot = (sres.log ?? []).find((l) => l.startsWith("boot="));
    if (!boot || !boot.includes("s=SCOPED-MARK")) throw new Error("boot=" + boot);
    if (!boot.includes("marker=SUB-LIB-MARK")) throw new Error("boot=" + boot);
    return boot.slice(0, 80);
  });
  await check("scoped fixture traffic actually reached the mapped targets", () => {
    for (const p of ["/lib/s.js", "/lib/sublib.js", "/dir/sub/worker.mjs"]) {
      if (!hits.includes(p)) throw new Error("fixture never saw " + p);
    }
    return "scoped hits ok";
  });

  /* --- leg 3: multiple maps in one document --- */
  const mres = await drive(MULTI_PAGE);

  await check("multi-map worker boots without a script error", () => {
    if (mres.probe?.worker !== "DONE") throw new Error(JSON.stringify(mres.probe));
    return "";
  });
  await check("a later map's new key resolves; a redefined key keeps the FIRST mapping", () => {
    const boot = (mres.log ?? []).find((l) => l.startsWith("boot="));
    if (!boot || !boot.includes("added=ADDED-MARK")) throw new Error("boot=" + boot);
    if (!boot.includes("marker=LIB-MARK")) throw new Error("redefined key took the LATE mapping: " + boot);
    return boot.slice(0, 80);
  });

  console.log("HITS " + hits.join(" "));
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok  " : "  FAIL") + " " + r.name + (r.ok ? "" : " (" + r.info + ")"));
  }
  console.log(results.length - failed.length + "/" + results.length + " importmap checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR importmap suite failed; engine tail:\n" + engineTail());
    process.exitCode = 1;
  }
}

/* The page module's import result is read from the CURRENT virtual
   frame (leg 1's page); each drive() navigates away, so leg 1's
   checks run before leg 2 starts. */
function frame_probe(page) {
  const frame = page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
  if (!frame) return Promise.reject(new Error("no virtual frame for page probe"));
  return frame.evaluate(() => window.__probe.pageImport);
}

main()
  .catch((e) => {
    console.log("HARNESS-ERROR " + String(e?.message ?? e));
    console.log("engine tail:\n" + engineTail());
    process.exitCode = 1;
  })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (engineProc) engineProc.kill("SIGKILL"); } catch {}
    try { if (fx) fx.close(); } catch {}
  });
