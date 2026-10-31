/* Issue #554 (#549 child): real-Chromium acceptance for import
   map awareness. Two seams must both hold in a genuine browser:
   the wasm rewriter rewrites import map BODIES (mapped values ride
   engine routes, bare keys stay), so the page's own module scripts
   keep resolving bare specifiers through the rewritten map; and the
   engine records each served document's import map, so a MODULE
   WORKER created by the page resolves its bare specifiers through
   the owning page's map at the serve seam. An unknown bare
   specifier must still fail natively (no invented resolution).
   Everything is loopback fixtures only; ports 6036/7136 never
   collide with e2e.mjs (6002/7101), guest-sw (6009/7109),
   vorigin (6027/7128) or blob-workers/vctx-restart (6034/7134). */

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

function pageHtml() {
  const map = JSON.stringify({ imports: { mylib: FX + "/lib/lib.js", "utils/": FX + "/lib/u/" } });
  return [
    "<!doctype html><meta charset=\"utf-8\"><body>",
    "<script>window.__probe = {}; window.__log = [];</script>",
    "<script type=\"importmap\">" + map + "</script>",
    "<script type=\"module\" src=\"page-mod.mjs\"></script>",
    "<script>",
    "window.__run = function () { return new Promise(function (res) {",
    "  var w = new Worker('worker.mjs', { type: 'module' });",
    "  var t = setTimeout(function () { window.__probe.worker = 'W-TIMEOUT'; res({ probe: window.__probe, log: window.__log }); }, 25000);",
    "  w.onmessage = function (ev) { var d = ev.data || {}; if (d.step === 'done') { clearTimeout(t); window.__probe.worker = 'DONE'; res({ probe: window.__probe, log: window.__log }); } else { window.__log.push(d.step + '=' + String(d.v)); } };",
    "  w.onerror = function (e) { clearTimeout(t); window.__probe.worker = 'W-ERR m=' + String(e.message || '-') + ' f=' + String(e.filename || '-') + ':' + String(e.lineno || 0) + ' x=' + String((e.error && e.error.message) || '-'); res({ probe: window.__probe, log: window.__log }); };",
    "}); };",
    "</script></body>",
  ].join("");
}

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
      else if (u.pathname === "/dir/page-mod.mjs") { res.writeHead(200, { "content-type": "application/javascript" }); res.end('import { marker } from "mylib"; window.__probe.pageImport = marker;'); }
      else if (u.pathname === "/lib/lib.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end('export const marker = "LIB-MARK";'); }
      else if (u.pathname === "/lib/u/helper.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end('export const h = "UTIL-MARK";'); }
      else if (u.pathname === "/dir/worker.mjs") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end([
          'import { marker } from "mylib";',
          'import { h } from "utils/helper.js";',
          'self.postMessage({ step: "boot", v: "marker=" + marker + " h=" + h });',
          '(async function () {',
          '  try { await import("missing-pkg"); self.postMessage({ step: "miss", v: "LOADED" }); }',
          '  catch (e) { self.postMessage({ step: "miss", v: "REJECTED " + String(e).slice(0, 120) }); }',
          '  self.postMessage({ step: "done", v: "done" });',
          '})();',
        ].join("\n"));
      }
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
  await page.goto(ENGINE + "/?url=" + encodeURIComponent(VIRTUAL_PAGE));
  await sleep(2500);
  let frame = null;
  for (let i = 0; i < 60; i++) {
    frame = page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
    if (frame) break;
    await sleep(500);
  }
  if (!frame) throw new Error("virtual frame never appeared");

  const res = await frame.evaluate(() => window.__run());

  await check("page module script resolves the bare specifier through the rewritten map", () => {
    const v = frame.evaluate(() => window.__probe.pageImport);
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
  await check("unknown bare specifier still fails natively (no invented route)", () => {
    const miss = (res.log ?? []).find((l) => l.startsWith("miss="));
    if (!miss || !miss.startsWith("miss=REJECTED")) throw new Error("miss=" + miss);
    return "REJECTED";
  });
  await check("the fixture actually received the mapped module traffic", () => {
    for (const p of ["/lib/lib.js", "/lib/u/helper.js", "/dir/worker.mjs", "/dir/page-mod.mjs"]) {
      if (!hits.includes(p)) throw new Error("fixture never saw " + p);
    }
    return hits.length + " fixture hits";
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
