/* Issue #535 (#549 child): real-Chromium acceptance for virtual
   client context rehydration after a service-worker restart. The unit
   suites cover the pure map in isolation; this suite proves the whole
   loop through a genuine browser: two tabs on two different virtual
   sites, both controlled by the one engine worker, lose their
   in-memory contexts when Chromium stops the worker (CDP
   ServiceWorker.stopWorker) while the pages stay open, and the next
   same-origin relative subresource of each tab must rehydrate its own
   context from its own browser-committed client URL. The two tabs must
   never inherit each other's contexts: site A serves a 1x1 own.png and
   no cross.png, site B serves a 3x5 own.png and a 7x2 cross.png, and
   each tab must keep seeing only its own origin's bytes. A
   referrer-allowed page rides along as the compatibility control (the
   referrer fallback path must not regress). Everything is loopback
   fixtures only; ports 6034/7134/7135 never collide with e2e.mjs
   (6002/7101), guest-sw (6009/7109) or computed-sinks. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6034;
const FX_A_PORT = 7134;
const FX_B_PORT = 7135;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FXA = "http://127.0.0.1:" + FX_A_PORT;
const FXB = "http://127.0.0.1:" + FX_B_PORT;

const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let context = null;
let fxA = null;
let fxB = null;

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log("[PASS] " + name + (detail ? " | " + detail : ""));
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log("[FAIL] " + name + " | " + String(err?.message ?? err));
  }
}

function engineTail() {
  return engineErr.slice(-30).join("");
}

async function waitFor(label, timeoutMs, fn) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label + (last ? "; last error: " + last : ""));
}

/* ---- fixture origins ------------------------------------------------ */

/* Runtime-built paths (array join, not a URL-shaped literal) dodge the
   JS-literal rewrite on purpose: the requests must arrive as bare
   engine-origin paths so only the worker's context chain can route
   them. Every load carries a unique cache-buster so Chromium cannot
   answer from its HTTP cache - the post-restart probe must hit the
   network. */

function pageHtml(noReferrer) {
  const meta = noReferrer ? '<meta name="referrer" content="no-referrer">' : "";
  return (
    "<!doctype html><meta charset=\"utf-8\">" +
    meta +
    "<body><script>" +
    "window.__probe = {};" +
    "window.__cb = 0;" +
    "function probeImg(label, path) { return new Promise(function (res) {" +
    "  var img = new Image();" +
    "  img.onload = function () { window.__probe[label] = 'IMG-' + img.naturalWidth; res(); };" +
    "  img.onerror = function () { window.__probe[label] = 'IMG-ERR'; res(); };" +
    "  img.src = path;" +
    "}); }" +
    "function probeWorker(label, path) { return new Promise(function (res) {" +
    "  try {" +
    "    var w = new Worker(path);" +
    "    w.onmessage = function (ev) { window.__probe[label] = 'WORKER-' + String(ev.data); res(); };" +
    "    w.onerror = function () { window.__probe[label] = 'WORKER-ERR'; res(); };" +
    "  } catch (e) { window.__probe[label] = 'WORKER-CATCH'; res(); }" +
    "}); }" +
    "window.__run = async function () {" +
    "  window.__cb = (window.__cb || 0) + 1;" +
    "  var cb = 'cb=' + Date.now() + '-' + window.__cb;" +
    "  var own = ['sub', 'own.png?' + cb].join('/');" +
    "  var cross = ['sub', 'cross.png?' + cb].join('/');" +
    "  var wj = ['sub', 'worker.js?' + cb].join('/');" +
    "  await Promise.all([probeImg('own', own), probeImg('cross', cross), probeWorker('worker', wj)]);" +
    "  return JSON.parse(JSON.stringify(window.__probe));" +
    "};" +
    "<\/script></body>"
  );
}

const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC"; /* 1x1 */
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAIAAAAPE8H1AAAADklEQVR4nGPgggEGIlkALCQBwy6hYFgAAAAASUVORK5CYII="; /* 3x5 */
const PNG_CROSS = "iVBORw0KGgoAAAANSUhEUgAAAAcAAAACCAIAAAAb/VE3AAAAD0lEQVR4nGM4gQ0wYBUFANIqINGcpMDSAAAAAElFTkSuQmCC"; /* 7x2, only on site B */

function startFx(port, base, withCross, marker) {
  return new Promise((r) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, base);
      if (u.pathname === "/dir/page.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(pageHtml(port === FX_A_PORT && !u.search.includes("ref=1")));
      } else if (u.pathname === "/dir/sub/own.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from(port === FX_A_PORT ? PNG_A : PNG_B, "base64"));
      } else if (u.pathname === "/dir/sub/cross.png" && withCross) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from(PNG_CROSS, "base64"));
      } else if (u.pathname === "/dir/sub/worker.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("self.postMessage('" + marker + "');");
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    srv.listen(port, "127.0.0.1", () => r(srv));
  });
}

async function startEngine() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], {
    env: {
      ...process.env,
      /* Test-only SSRF hatch: the engine may reach the loopback fixture
         origins. Same two-key escape the compat job uses. */
      ZL_TEST_ALLOW_PRIVATE_DESTS: "1",
      ZL_TEST_EGRESS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await waitFor("engine on " + ENGINE, 60000, async () => {
    try {
      const r = await fetch(ENGINE + "/");
      return r.status === 200;
    } catch {
      return false;
    }
  });
}

async function openProxied(context, target) {
  const page = await context.newPage();
  await page.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  const frame = await waitFor("proxied frame for " + target, 30000, async () =>
    page.frames().find((f) => f.url().startsWith(ENGINE + "/j/")),
  );
  await waitFor("worker control for " + target, 30000, async () =>
    frame.evaluate(() => !!navigator.serviceWorker.controller),
  );
  return { page, frame };
}

async function main() {
  fxA = await startFx(FX_A_PORT, FXA, false, "up-a");
  fxB = await startFx(FX_B_PORT, FXB, true, "up-b");
  await startEngine();

  browser = await chromium.launch({ args: ["--no-sandbox"] });
  context = await browser.newContext();

  const tabA = await openProxied(context, FXA + "/dir/page.html");
  const tabB = await openProxied(context, FXB + "/dir/page.html");

  let baseA = null;
  let baseB = null;
  let baseC = null;
  let postA = null;
  let postB = null;
  let postC = null;

  await check("baseline: site A resolves its own relative bytes (own 1px, no cross file)", async () => {
    baseA = await tabA.frame.evaluate(() => window.__run());
    if (baseA.own !== "IMG-1") throw new Error("own=" + baseA.own);
    if (baseA.cross !== "IMG-ERR") throw new Error("cross=" + baseA.cross);
    return JSON.stringify(baseA);
  });
  await check("baseline: site B resolves its own relative bytes (own 3px, cross 7px)", async () => {
    baseB = await tabB.frame.evaluate(() => window.__run());
    if (baseB.own !== "IMG-3") throw new Error("own=" + baseB.own);
    if (baseB.cross !== "IMG-7") throw new Error("cross=" + baseB.cross);
    return JSON.stringify(baseB);
  });

  /* The referrer-allowed control page: the compat fallback must keep
     working for pages that do send a referrer. */
  const tabC = await openProxied(context, FXA + "/dir/page.html?ref=1");
  await check("baseline: referrer-allowed control page loads its own bytes", async () => {
    baseC = await tabC.frame.evaluate(() => window.__run());
    if (baseC.own !== "IMG-1") throw new Error("own=" + baseC.own);
    return JSON.stringify(baseC);
  });

  /* The restart: stop the one engine worker both tabs are controlled
     by, with every page left open. The in-memory context map dies with
     the worker; the pages must recover through #535 rehydration. */
  await check("engine worker stopped via CDP while all three pages stay open", async () => {
    const cdp = await context.newCDPSession(tabA.page);
    await cdp.send("ServiceWorker.enable");
    const versions = await new Promise((resolve) => {
      const onVer = (ev) => {
        if (ev.versions) {
          cdp.off("ServiceWorker.workerVersionUpdated", onVer);
          resolve(ev.versions);
        }
      };
      cdp.on("ServiceWorker.workerVersionUpdated", onVer);
      setTimeout(() => resolve([]), 2000);
    });
    const ours = versions.find((v) => v.scriptURL && v.scriptURL.includes(String(ENGINE_PORT)));
    if (!ours || !ours.versionId) throw new Error("no engine worker version: " + JSON.stringify(versions).slice(0, 200));
    await cdp.send("ServiceWorker.stopWorker", { versionId: ours.versionId });
    await sleep(1000);
    return "stopped versionId " + ours.versionId;
  });

  await check("post-restart: site A rehydrates its own context (own 1px, no cross file)", async () => {
    postA = await tabA.frame.evaluate(() => window.__run());
    if (postA.own !== "IMG-1") throw new Error("own=" + postA.own);
    if (postA.cross !== "IMG-ERR") throw new Error("cross=" + postA.cross);
    return JSON.stringify(postA);
  });
  await check("post-restart: site B rehydrates its own context (own 3px, cross 7px)", async () => {
    postB = await tabB.frame.evaluate(() => window.__run());
    if (postB.own !== "IMG-3") throw new Error("own=" + postB.own);
    if (postB.cross !== "IMG-7") throw new Error("cross=" + postB.cross);
    return JSON.stringify(postB);
  });
  await check("post-restart: the two sites never inherit each other's contexts", () => {
    if (postA.own === "IMG-3" || postA.cross === "IMG-7") throw new Error("site A saw site B bytes");
    if (postB.own === "IMG-1" || postB.worker === "WORKER-up-a") throw new Error("site B saw site A bytes");
    return "no cross-inheritance";
  });
  await check("post-restart: referrer-allowed control page still served (compat fallback intact)", async () => {
    postC = await tabC.frame.evaluate(() => window.__run());
    if (postC.own !== "IMG-1") throw new Error("own=" + postC.own);
    return JSON.stringify(postC);
  });
  await check("post-restart: worker script loads from the rehydrated site (A tab)", () => {
    /* A dedicated worker script request is another bare-path shape the
       context chain must route; the marker proves the bytes came from
       site A's origin, not B's. */
    if (postA.worker !== "WORKER-up-a") throw new Error("worker=" + postA.worker);
    return postA.worker;
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok  " : "  FAIL") + " " + r.name);
  }
  console.log(results.length - failed.length + "/" + results.length + " vctx-restart checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR vctx-restart suite failed; engine tail:\n" + engineTail());
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
    try { if (fxB) fxB.close(); } catch {}
  });
