/* #711 C0 fairness bench: measure the SW event-loop lag and the
   light-page TTFF cost while a worst-case rewriter payload streams
   through the same single SW. Numbers feed the G1 gate on #711:
   if rewrite CPU starves the loop (high p99 lag) or shifts light
   TTFF materially, C2 parallelism gains a case; if not, C1 only.

   Real stack: zeolite-server on 6002 (app/dist static), a fixture
   upstream on 7121 serving a 7MiB external-JS page (the #696
   shape, under the 8MiB JS_BODY_CAP but far past typical), and a
   light marker page. Real Chromium registers the real SW; the
   devtools host page polls zl:getDiag, which since C0 carries the
   loopLag piggyback, so the bench reads live p50/p95/p99/max.

   Scenarios: light alone (baseline), heavy alone (rewrite cost),
   race (light navigates while heavy streams). Informational: it
   prints a JSON verdict and only fails on harness boot errors.
   Run: node suite/e2e/loop-fairness.mjs */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { chromium } from "playwright";

const ENG_PORT = 6002;
const ENG = "http://127.0.0.1:" + ENG_PORT;
const FIX_PORT = 7121;
const ORIGIN = "http://127.0.0.1:" + FIX_PORT;
const STATIC = process.env.ZL_STATIC ?? resolve("app/dist");
const SERVER = process.env.ZL_SERVER ?? resolve("target/release/zeolite-server");

/* The heavy payload: the wasm rewriter runs on fetched JS bodies
   (#696), so the worst case is a big external .js re-streamed
   through the rewrite seam - a 4MiB and a 7MiB body, near the 8MiB
   JS_BODY_CAP. Inline script never touches that path. */
const HEAVY_JS = 4 * 1024 * 1024;
const HEAVIER_JS = 7 * 1024 * 1024;
function bigJs(bytes) {
  const chunk = "var q7=[].concat([0,1,2,3,4,5,6,7,8,9]);q7.push(q7.length);\n";
  let body = "";
  while (body.length < bytes) body += chunk;
  return body;
}
const heavyHtml = (js) => '<!doctype html><title>heavy</title><script src="' + js + '"></script><p id=heavy-done>heavy-ok</p>';
const LIGHT = "<!doctype html><title>light</title><p id=marker>light-ok</p>";

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
function startFixture() {
  const srv = http.createServer((req, res) => {
    if (req.url === "/heavy.js" || req.url === "/heavier.js") {
      res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
      res.end(bigJs(req.url === "/heavy.js" ? HEAVY_JS : HEAVIER_JS));
    } else if (req.url.split("?")[0] === "/heavy.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(heavyHtml("/heavier.js"));
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(LIGHT);
    }
  });
  return new Promise((r) => srv.listen(FIX_PORT, "127.0.0.1", () => r(srv)));
}
/* Control-plane round trip from the host page (differential.mjs
   send pattern): every navigation mints a zl:navHandle route, the
   only shape whose commit actually streams the real content. */
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
const navTiming = (page) => page.evaluate(() => {
  const n = performance.getEntriesByType("navigation")[0] ?? {};
  return { ttfb: Math.round(n.responseStart - n.requestStart), total: Math.round(n.responseEnd - n.startTime) };
});
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

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
    await sleep(500);
  }
  if (!controlled) throw new Error("HARNESS-ERROR: the service worker never controlled the host page");
  const dt = await ctx.newPage();
  await dt.goto(ENG + "/devtools.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  const lag = () => dt.evaluate(() => window.__zlLoopLag ?? null);
  await sleep(2500); // the devtools poll + first ticks
  if (!(await lag())) throw new Error("HARNESS-ERROR: no loopLag reported by the devtools host page (instrument not live)");

  /* The engine serves the app shell immediately (nav responseStart
     ~few ms) and streams the rewritten content in after commit, so
     the honest user-visible metric is marker-appear latency from
     goto start, measured like the other e2e harnesses: commit then
     poll for the marker (differential.mjs waitFor pattern). */
  async function waitMarker(pg, sel, text, ms) {
    return waitFor("marker " + sel, ms, () =>
      pg.locator(sel).textContent().then((x) => (x === text ? x : null)).catch(() => null));
  }
  const gotoProx = async (pg, path, ms) => {
    const t0 = Date.now();
    const url = await mint(host, path);
    await pg.goto(url, { waitUntil: "commit", timeout: ms });
    return t0;
  };

  const lightPage = await ctx.newPage();
  {
    const t0 = await gotoProx(lightPage, "/light.html", 30000); // warm
    await waitMarker(lightPage, "#marker", "light-ok", 45000);
    if (Date.now() - t0 > 44000) throw new Error("HARNESS-ERROR: warm light page never rendered");
  }

  const lightAlone = [];
  const lightAloneTtfb = [];
  for (let i = 0; i < 3; i++) {
    const t0 = await gotoProx(lightPage, "/light.html?a=" + i, 30000);
    await waitMarker(lightPage, "#marker", "light-ok", 45000);
    lightAlone.push(Date.now() - t0);
    lightAloneTtfb.push((await navTiming(lightPage)).ttfb);
  }
  const lagBase = await lag();

  const heavyPage = await ctx.newPage();
  const heavyFullLoad = [];
  const heavyLag = [];
  for (let i = 0; i < 2; i++) {
    const t0 = await gotoProx(heavyPage, "/heavy.html?i=" + i, 60000);
    await waitMarker(heavyPage, "#heavy-done", "heavy-ok", 120000);
    heavyFullLoad.push(Date.now() - t0);
    await sleep(1000);
    heavyLag.push(await lag());
  }

  const raceLight = [];
  for (let i = 0; i < 3; i++) {
    const tH = await gotoProx(heavyPage, "/heavy.html?r=" + i, 60000);
    const heavyNav = waitMarker(heavyPage, "#heavy-done", "heavy-ok", 120000).catch(() => null);
    await sleep(150);
    const t0 = await gotoProx(lightPage, "/light.html?r=" + i, 30000);
    await waitMarker(lightPage, "#marker", "light-ok", 45000);
    raceLight.push(Date.now() - t0);
    await heavyNav;
    await sleep(1000);
  }
  const lagRace = await lag();

  const verdict = {
    scenario: "C0 baseline vs worst-case rewriter load, single SW",
    lightAloneContentMs: lightAlone,
    lightAloneTtfbMs: lightAloneTtfb,
    lightAloneMedianMs: median(lightAlone),
    heavyFullLoadMs: heavyFullLoad,
    raceLightContentMs: raceLight,
    raceLightMedianMs: median(raceLight),
    contentPenaltyMs: median(raceLight) - median(lightAlone),
    loopLagBaseline: lagBase,
    loopLagHeavy: heavyLag,
    loopLagRace: lagRace,
  };
  console.log("C0-BENCH " + JSON.stringify(verdict));
} finally {
  await browser?.close();
  engineProc?.kill();
  await new Promise((r) => fixture?.close(r));
}
