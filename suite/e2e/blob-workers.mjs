/* Issue #537 (#549 child): real-Chromium acceptance for
   page-created blob workers. Chromium serves blob: worker scripts
   straight from the blob store with no fetch event, so the SW-side
   prelude injection cannot reach them; the fix wraps the constructor
   so the worker loads a fresh wrapper blob that imports the engine's
   /zl-bw/ prelude route first. This suite proves the whole chain in a
   genuine browser: classic, module and nested blob workers all boot
   with the page's site token and virtual base, their fetch/XHR/
   importScripts inputs ride engine routes to the fixture (the fixture
   sees the traffic arrive), relative inputs resolve against the
   virtual base, the worker's indexedDB namespace is site-scoped (no
   engine database names leak), and a worker created INSIDE a worker
   inherits the same site token. Everything is loopback fixtures only;
   ports 6034/7134 never collide with e2e.mjs (6002/7101), guest-sw
   (6009/7109) or the vctx-restart suite. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6034;
const FX_A_PORT = 7134;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX_A = "http://127.0.0.1:" + FX_A_PORT;
const VIRTUAL_PAGE = FX_A + "/dir/page.html";

const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let context = null;
let fxA = null;
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

function classicSrc() {
  return [
    "self.onmessage = async function () {",
    "  var post = function (k, v) { self.postMessage({ step: k, v: String(v) }); };",
    "  post('site', String(self.__ZL_SITE__));",
    "  post('wbase', String(self.__ZL_WORKER_BASE__));",
    "  try { post('absFetch', 'OK ' + (await (await fetch('" + FX_A + "/api/data.txt')).text()).trim()); } catch (e) { post('absFetch', 'ERR ' + String(e)); }",
    "  try { post('relFetch', 'OK ' + (await (await fetch('sub/data.txt')).text()).trim()); } catch (e) { post('relFetch', 'ERR ' + String(e)); }",
    "  try { post('xhr', await new Promise(function (res) { var x = new XMLHttpRequest(); x.open('GET', '" + FX_A + "/api/data.txt'); x.onload = function () { res('OK ' + x.responseText.trim()); }; x.onerror = function () { res('XHR-NET-ERR status=' + x.status); }; x.send(); })); } catch (e) { post('xhr', 'ERR ' + String(e)); }",
    "  try { importScripts('" + FX_A + "/api/imp.js'); post('imp', String(self.__IMP || 'NO-IMP')); } catch (e) { post('imp', 'ERR ' + String(e)); }",
    "  try { post('dbs', JSON.stringify((await indexedDB.databases()).map(function (d) { return d.name; }))); } catch (e) { post('dbs', 'ERR ' + String(e)); }",
    "  try { var rq = indexedDB.open('zl-bw-accept'); rq.onsuccess = function () { rq.result.close(); post('idbOpen', 'OK'); }; rq.onerror = function () { post('idbOpen', 'ERR ' + String(rq.error)); }; } catch (e) { post('idbOpen', 'ERR ' + String(e)); }",
    "  post('done', 'done');",
    "};",
  ].join("\n");
}

function moduleSrc() {
  return "const post = (k, v) => self.postMessage({ step: k, v: String(v) });\npost('site', String(self.__ZL_SITE__));\ntry { post('modFetch', 'OK ' + (await (await fetch('" + FX_A + "/api/data.txt')).text()).trim()); } catch (e) { post('modFetch', 'ERR ' + String(e)); }\npost('done', 'done');";
}

function nestedSrc() {
  const child = 'self.onmessage=async function(){self.postMessage({step:"csite",v:String(self.__ZL_SITE__)});try{var r=await fetch("' + FX_A + '/api/data.txt");self.postMessage({step:"cfetch",v:"OK "+(await r.text()).trim()});}catch(e){self.postMessage({step:"cfetch",v:"ERR "+String(e)});}self.postMessage({step:"cdone",v:"done"});}';
  return [
    "self.onmessage = async function () {",
    "  var post = function (k, v) { self.postMessage({ step: k, v: String(v) }); };",
    "  post('site', String(self.__ZL_SITE__));",
    "  post('wbase', String(self.__ZL_WORKER_BASE__));",
    "  try { var child = new Worker(URL.createObjectURL(new Blob([" + JSON.stringify(child) + "], { type: 'text/javascript' })));",
    "    child.postMessage(0); var cres = await new Promise(function (res) { var n = 0; var t = setTimeout(function () { res('CHILD-TIMEOUT n=' + n); }, 15000); child.onmessage = function (ev) { n++; post('child' + n, String((ev.data && (ev.data.step + '=' + ev.data.v)) || 'no-data')); if (ev.data && ev.data.step === 'cdone') { clearTimeout(t); res('CHILD-DONE'); } }; });",
    "    post('nested', cres);",
    "  } catch (e) { post('nested', 'ERR ' + String(e)); }",
    "  post('done', 'done');",
    "};",
  ].join("\n");
}

function pageHtml() {
  const classic = JSON.stringify(classicSrc()).replace(/</g, "\\u003c");
  const mod = JSON.stringify(moduleSrc()).replace(/</g, "\\u003c");
  const nested = JSON.stringify(nestedSrc()).replace(/</g, "\\u003c");
  return [
    "<!doctype html><meta charset=\"utf-8\"><body><script>",
    "window.__probe = {}; window.__log = [];",
    "window.__run = async function () {",
    "  window.__diag = (function () { var d = {}; try { d.ctl = navigator.serviceWorker && navigator.serviceWorker.controller ? String(navigator.serviceWorker.controller.scriptURL) : 'none'; } catch (e) { d.ctl = 'ERR ' + e; } d.wname = Worker && Worker.name ? Worker.name : 'anon'; try { var du = URL.createObjectURL(new Blob(['self.__DG=1;'], { type: 'text/javascript' })); var dx = new XMLHttpRequest(); dx.open('GET', du, false); dx.send(null); d.xhr = dx.status + ':' + String(dx.responseText).slice(0, 20); URL.revokeObjectURL(du); } catch (e) { d.xhr = 'ERR ' + e; } return d; })();",
    "  const mk = function (src) { return URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); };",
    "  const wait = function (w, label, ms, kick) { return new Promise(function (res) { var t = setTimeout(function () { window.__probe[label] = 'W-TIMEOUT'; res(); }, ms); w.onmessage = function (ev) { var d = ev.data || {}; if (d.step === 'done') { clearTimeout(t); window.__probe[label] = 'DONE'; res(); } else { window.__log.push(label + ':' + d.step + '=' + String(d.v).slice(0, 200)); } }; w.onerror = function (e) { clearTimeout(t); window.__probe[label] = 'W-ERR ' + String(e.message || e); res(); }; if (kick) { try { w.postMessage(0); } catch (e) {} } }); };",
    "  const w1 = new Worker(mk(" + classic + ")); await wait(w1, 'classic', 20000, true);",
    "  const w2 = new Worker(mk(" + mod + "), { type: 'module' }); await wait(w2, 'module', 15000, false);",
    "  const w3 = new Worker(mk(" + nested + ")); await wait(w3, 'nested', 25000, true);",
    "  return JSON.parse(JSON.stringify({ probe: window.__probe, log: window.__log, diag: window.__diag }));",
    "};",
    "</script></body>",
  ].join("\n");
}

/* the __log entries come back as "label:step=value" */
function step(res, label, key) {
  const pre = label + ":" + key + "=";
  const hit = res.log.find((l) => l.startsWith(pre));
  return hit ? hit.slice(pre.length) : null;
}

async function main() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  fxA = await new Promise((resolve_) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, FX_A);
      hits.push(u.pathname);
      if (u.pathname === "/dir/page.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(pageHtml()); }
      else if (u.pathname === "/api/data.txt") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("DIRECT"); }
      else if (u.pathname === "/api/imp.js") { res.writeHead(200, { "content-type": "application/javascript", "access-control-allow-origin": "*" }); res.end("self.__IMP = 'LOADED';"); }
      else if (u.pathname === "/dir/sub/data.txt") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("REL-OK"); }
      else { res.writeHead(404); res.end("no"); }
    });
    srv.listen(FX_A_PORT, "127.0.0.1", () => resolve_(srv));
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

  const classicSite = step(res, "classic", "site");

  await check("page-side wrap machinery is live (controller, wrapped ctor, blob XHR)", () => {
    const d = res.diag ?? {};
    if (!d.ctl || d.ctl === "none" || String(d.ctl).startsWith("ERR")) throw new Error("ctl=" + d.ctl);
    /* the dist is minified, so the wrapper class name is mangled: the
       native ctor is literally "Worker", any other name is the wrap. */
    if (d.wname === "Worker" || !d.wname) throw new Error("wname=" + d.wname);
    if (d.xhr !== "200:self.__DG=1;") throw new Error("xhr=" + d.xhr);
    return "live";
  });
  await check("classic blob worker boots through the wrapper", () => {
    if (res.probe.classic !== "DONE") throw new Error(JSON.stringify(res.probe));
    return "";
  });
  await check("classic worker carries a real site token", () => {
    if (!classicSite || classicSite === "undefined") throw new Error("site=" + classicSite);
    return String(classicSite).slice(0, 12) + "...";
  });
  await check("classic worker's virtual base is the page's virtual URL", () => {
    const wb = step(res, "classic", "wbase");
    if (wb !== VIRTUAL_PAGE) throw new Error("wbase=" + wb);
    return wb;
  });
  await check("absolute fetch rides the engine route to the fixture", () => {
    const v = step(res, "classic", "absFetch");
    if (v !== "OK DIRECT") throw new Error("absFetch=" + v);
    return v;
  });
  await check("relative fetch resolves against the virtual base", () => {
    const v = step(res, "classic", "relFetch");
    if (v !== "OK REL-OK") throw new Error("relFetch=" + v);
    return v;
  });
  await check("XHR rides the engine route", () => {
    const v = step(res, "classic", "xhr");
    if (v !== "OK DIRECT") throw new Error("xhr=" + v);
    return v;
  });
  await check("importScripts loads the fixture script", () => {
    const v = step(res, "classic", "imp");
    if (v !== "LOADED") throw new Error("imp=" + v);
    return v;
  });
  await check("worker indexedDB namespace is site-scoped (no engine DBs)", () => {
    const raw = step(res, "classic", "dbs");
    const names = raw ? JSON.parse(raw) : [];
    const leaked = names.filter((n) => String(n).startsWith("zl-"));
    if (leaked.length > 0) throw new Error("leaked=" + leaked.join(","));
    return raw ?? "[]";
  });
  await check("worker can open its own scoped database", () => {
    const v = step(res, "classic", "idbOpen");
    if (v !== "OK") throw new Error("idbOpen=" + v);
    return v;
  });
  await check("module blob worker boots and fetches engine-routed", () => {
    if (res.probe.module !== "DONE") throw new Error(JSON.stringify(res.probe));
    const v = step(res, "module", "modFetch");
    if (v !== "OK DIRECT") throw new Error("modFetch=" + v);
    return v;
  });
  await check("module worker shares the page's site token", () => {
    const v = step(res, "module", "site");
    if (v !== classicSite) throw new Error("module=" + v + " classic=" + classicSite);
    return "same token";
  });
  await check("nested blob worker (worker inside a worker) boots", () => {
    if (res.probe.nested !== "DONE") throw new Error(JSON.stringify(res.probe));
    const v = step(res, "nested", "nested");
    if (v !== "CHILD-DONE") throw new Error("nested=" + v);
    return v;
  });
  /* child relay mint wrappers interleave with the child's own app
     messages (they are forwarded up by the prelude), so the child
     steps are scanned across every childN entry, not by index. */
  const childEntries = res.log
    .filter((l) => /^nested:child\d+=/.test(l))
    .map((l) => l.slice("nested:child".length).replace(/^\d+=/, ""));
  await check("nested child inherits the same site token", () => {
    const v = childEntries.find((e) => e.startsWith("csite="));
    if (v !== "csite=" + classicSite) throw new Error("got=" + v);
    return "inherited";
  });
  await check("nested child fetch rides the engine route", () => {
    const v = childEntries.find((e) => e.startsWith("cfetch="));
    if (v !== "cfetch=OK DIRECT") throw new Error("got=" + v);
    return v;
  });
  await check("the fixture actually received the routed traffic", () => {
    for (const p of ["/api/data.txt", "/api/imp.js", "/dir/sub/data.txt"]) {
      if (!hits.includes(p)) throw new Error("fixture never saw " + p);
    }
    return hits.length + " fixture hits";
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok  " : "  FAIL") + " " + r.name + (r.ok ? "" : " (" + r.info + ")"));
  }
  console.log(results.length - failed.length + "/" + results.length + " blob-worker checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR blob-worker suite failed; engine tail:\n" + engineTail());
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
    try { if (fxA) fxA.close(); } catch {}
  });
