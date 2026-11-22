/* #688 warm-visit bench: after a first load, does a repeat visit of
   the same page serve its static subresource fleet locally, or does
   it refetch everything from upstream? Real stack: zeolite-server on
   6002 (app/dist static), a fixture upstream on 7122 serving a page
   with N immutable versioned assets, real Chromium
   registering the real SW.

   The discriminator: the fixture COUNTS its asset requests. The
   engine's own HTTP cache is cleared via CDP before the warm load, so
   the only local store that can answer is the engine's Cache Storage
   (matching production, where upstream traffic rides the engine
   transport and never touches the browser HTTP cache). Informational:
   prints a JSON verdict, fails only on harness boot errors.
   Run: node suite/e2e/warm-cache.mjs */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { chromium } from "playwright";

const ENG_PORT = 6002;
const ENG = "http://127.0.0.1:" + ENG_PORT;
const FIX_PORT = 7122;
const ORIGIN = "http://127.0.0.1:" + FIX_PORT;
const STATIC = process.env.ZL_STATIC ?? resolve("app/dist");
const SERVER = process.env.ZL_SERVER ?? resolve("target/release/zeolite-server");

/* Enough assets to overflow the old 60-entry shared page budget, so
   the bench can see the difference between churned and retained
   fleets: 30 scripts, 30 styles, 40 images. */
const SCRIPTS = 30;
const STYLES = 30;
const IMAGES = 40;
const ASSETS = SCRIPTS + STYLES + IMAGES;
const IMMTL = { "cache-control": "public, max-age=31536000" };

let html = '<!doctype html><title>warm</title>';
for (let i = 0; i < STYLES; i++) html += '<link rel="stylesheet" href="/s-' + i + '.css">';
for (let i = 0; i < IMAGES; i++) html += '<img src="/i-' + i + '.png" width="2" height="2">';
for (let i = 0; i < SCRIPTS; i++) html += '<script src="/a-' + i + '.js"></' + 'script>';
html += '<p id=warm-done>warm-ok</p>';

const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020806000000724bf5a10000000c4944415408d76360f8cfc000000301010018dd8db00000000049454e44ae426082", "hex");

let engineProc = null;
const engineLog = [];
async function waitFor(msg, ms, fn) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error("timeout: " + msg + " ; engine log tail: " + engineLog.join("").slice(-400));
}
async function startEngine() {
  if (!existsSync(SERVER)) throw new Error("zeolite-server not built: " + SERVER);
  engineProc = spawn(SERVER, ["--port", String(ENG_PORT), "--static", STATIC], {
    env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineLog.push(String(c)));
  engineProc.stderr.on("data", (c) => engineLog.push(String(c)));
  await waitFor("engine on " + ENG_PORT, 60000, async () => {
    try { const r = await fetch(ENG + "/sw.js"); return r.status === 200; } catch { return false; }
  });
}

/* The fixture counts every asset request so the verdict is the raw
   upstream request count, not a client-side proxy metric. */
const assetHits = [];
function startFixture() {
  const srv = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/warm.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (/^\/\w-\d+\.(?:js|css|png)$/.test(path)) {
      assetHits.push(path);
      res.writeHead(200, { ...IMMTL, "content-type": path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "image/png" });
      res.end(path.endsWith(".png") ? png : "/*" + path + "*/ var q=1;\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nf");
  });
  return new Promise((r) => srv.listen(FIX_PORT, "127.0.0.1", () => r(srv)));
}

function send(pg, msg, timeoutMs = 10000) {
  return pg.evaluate(([m, t]) => new Promise((res) => {
    const ch = new MessageChannel();
    const c = navigator.serviceWorker.controller;
    if (!c) return res({ ok: false, error: "no controller" });
    ch.port1.onmessage = (e) => res(e.data);
    c.postMessage(m, [ch.port2]);
    setTimeout(() => res({ ok: false, error: "timeout" }), t);
  }), [msg, timeoutMs]);
}
async function mint(hostPg, path) {
  const h = await send(hostPg, { type: "zl:navHandle", dest: ORIGIN + path }, 20000);
  if (!h || h.ok !== true) throw new Error("HARNESS-ERROR: navHandle mint refused: " + JSON.stringify(h));
  return ENG + h.url;
}

async function swCacheProbe(hostPg) {
  const r = await send(hostPg, { type: "zl:688dbg" }, 2500); /* probe: only meaningful on a debug build; a clean build falls back to a fixed settle sleep */
  return r;
}
let browser = null;
let fixture = null;
try {
  await startEngine();
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  await host.goto(ENG + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await host.evaluate(() => navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" }).catch(() => null));
  let controlled = false;
  for (let i = 0; i < 80; i++) {
    if (await host.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)) { controlled = true; break; }
    await sleep(250);
  }
  if (!controlled) throw new Error("HARNESS-ERROR: SW never controlled the host page");

  const swTxt = await (await fetch(ENG + "/sw.js", { cache: "no-store" })).text();
  const servedSw = { bytes: swTxt.length, hasAssetBucket: swTxt.includes("zeolite-assets-v1") }; /* SWFINGERPRINT */
const page = await ctx.newPage();
  const warmUrl = await mint(host, "/warm.html");

  /* Cold load. */
  assetHits.length = 0;
  const t0 = Date.now();
  await page.goto(warmUrl, { waitUntil: "load", timeout: 45000 });
  await page.waitForSelector("#warm-done", { timeout: 45000 });
  await page.waitForFunction(() => document.images.length > 0 && [...document.images].every((im) => im.complete), null, { timeout: 45000 }).catch(() => null);
  const coldMs = Date.now() - t0;
  const cold = new Set(assetHits);
  const coldCache = await swCacheProbe(host);
  if (cold.size < ASSETS) console.error("note: cold load saw " + cold.size + "/" + ASSETS + " upstream asset requests");

  /* SETTLE: a repeat visit in production comes long after the first
     visit's store queue drains. Let the deferred cache.put queue settle
     before clearing the browser cache and reloading. */
  let settled = false;
  for (let i = 0; i < 10 && !settled; i++) {
    const a = await swCacheProbe(host);
    if (!a || a.ok !== true) { await sleep(2000); break; }
    await sleep(400);
    const b2 = await swCacheProbe(host);
    const na = a.n ? a.n["zeolite-assets-v1"] : -1;
    const nb = b2.n ? b2.n["zeolite-assets-v1"] : -1;
    settled = na === nb && na > 0;
  }
  /* Drop Chromium's own HTTP cache: the only remaining local store
     is the engine's Cache Storage (the production transport shape). */
  const ses = await ctx.newCDPSession(page);
  await ses.send("Network.clearBrowserCache");

  /* Warm reload of the same URL. */
  assetHits.length = 0;
  const t1 = Date.now();
  await page.reload({ waitUntil: "load", timeout: 45000 });
  await page.waitForSelector("#warm-done", { timeout: 45000 });
  await page.waitForFunction(() => document.images.length > 0 && [...document.images].every((im) => im.complete), null, { timeout: 45000 }).catch(() => null);
  const warmMs = Date.now() - t1;
  const warm = new Set(assetHits);
  const warmCache = await swCacheProbe(host);
  const servedLocally = ASSETS - warm.size;
  console.log(JSON.stringify({
    bench: "#688 warm visit",
    assets: ASSETS,
    coldUpstreamAssetRequests: cold.size,
    warmUpstreamAssetRequests: warm.size,
    servedLocally: servedLocally,
    locallyServedFraction: Math.round((1000 * servedLocally) / ASSETS) / 1000,
    coldMs, warmMs,
    coldCache, warmCache, servedSw,
    warmRefetched: [...warm],
  }, null, 2));
} catch (err) {
  console.error("WARM-CACHE-BENCH-ERROR", String(err));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  fixture?.close?.();
  engineProc?.kill();
}
