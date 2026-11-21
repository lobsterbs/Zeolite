/* #541 e2e: browser-initiated a[download] tracking, end to end through
   the real stack (injected init script -> zl:dlIntent report -> SW
   navigation seam -> registry row visible on the control plane).

   Contract pinned:
   1. Clicking a same-origin a[download="zw-anchor-saved.txt"] anchor on
      a page served through the engine registers EXACTLY ONE download
      row with initiator "anchor" and the attribute's filename, even
      though the response carries NO Content-Disposition header (only
      the intent seam can classify it).
   2. Clicking a plain anchor (no download attribute) to the same kind
      of response registers NOTHING.

   Flow mirrors delivery-fault.mjs: controlledHost at the engine root,
   zl:navHandle mints for the doc page and both file targets, anchors
   get their engine hrefs at runtime (the watcher reads getAttribute at
   click time), the registry is polled via zl:downloads from the host
   page. Oracle: the #541 registry, not the saved file (the engine
   cannot write files; the browser's own download machinery owns the
   disk).

   Run: node suite/e2e/downloads-anchor.mjs */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE = "http://127.0.0.1:6102";
const STATIC = process.env.ZL_STATIC ?? resolve("app/dist");
const PORT = 7107;
const ORIGIN = "http://127.0.0.1:" + PORT;
const SERVER_BIN = process.env.ZL_SERVER ?? resolve("target/release/zeolite-server");

const counts = { PAGE: 0, F1: 0, F2: 0, OTHER: 0 };
const server = createServer((req, res) => {
  if (req.url === "/doc") {
    counts.PAGE++;
    res.setHeader("content-type", "text/html");
    res.end([
      "<!doctype html><title>anchor fixture</title>",
      "<p><a id=\"dl\" download=\"zw-anchor-saved.txt\">download</a></p>",
      "<p><a id=\"plain\">plain</a></p>",
    ].join(String.fromCharCode(10)));
    return;
  }
  /* Both file targets answer text/plain, NO Content-Disposition: a
     response only the #541 intent seam can classify. */
  if (req.url.split("?")[0] === "/f1") {
    counts.F1++;
    res.setHeader("content-type", "text/plain");
    res.end("anchor-download-fixture-payload-1");
    return;
  }
  if (req.url.split("?")[0] === "/f2") {
    counts.F2++;
    res.end("anchor-download-fixture-payload-2");
    return;
  }
  counts.OTHER++;
  res.statusCode = 404;
  res.end("no");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let engineProc = null;
const engineErr = [];
async function waitFor(msg, ms, fn) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error("timeout: " + msg + " ; engine log tail: " + engineErr.join("").slice(-400));
}

async function startEngine() {
  if (!existsSync(SERVER_BIN)) throw new Error("zeolite-server not built: " + SERVER_BIN);
  engineProc = spawn(SERVER_BIN, ["--port", "6102", "--static", STATIC], {
    env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await waitFor("engine on " + ENGINE, 60000, async () => {
    try { const r = await fetch(ENGINE + "/sw.js"); return r.status === 200; } catch { return false; }
  });
}

/* Control-plane round trip, same MessageChannel postMessage the LB UI uses. */
function send(pg, msg, timeoutMs = 20000) {
  return pg.evaluate(([m, t]) => new Promise((res) => {
    const ch = new MessageChannel();
    const c = navigator.serviceWorker.controller;
    if (!c) return res({ ok: false, error: "no controller" });
    ch.port1.onmessage = (e) => res(e.data);
    c.postMessage(m, [ch.port2]);
    setTimeout(() => res({ ok: false, error: "timeout" }), t);
  }), [msg, timeoutMs]);
}

async function controlledHost(ctx) {
  const pg = await ctx.newPage();
  await pg.goto(ENGINE + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await pg.evaluate(() =>
    navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" }).catch(() => null),
  );
  for (let i = 0; i < 80; i++) {
    if (await pg.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)) return pg;
    await sleep(500);
  }
  throw new Error("the service worker never controlled the host page");
}

async function registry(pg) {
  const r = await send(pg, { type: "zl:downloads" });
  if (!r || r.ok !== true) throw new Error("zl:downloads failed: " + JSON.stringify(r));
  return r.downloads;
}

let browser = null;
let page = null;
try {
  await startEngine();
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const host = await controlledHost(ctx);

  const f1 = await send(host, { type: "zl:navHandle", dest: ORIGIN + "/f1" });
  if (!f1 || f1.ok !== true) throw new Error("navHandle mint refused (f1): " + JSON.stringify(f1));
  const f2 = await send(host, { type: "zl:navHandle", dest: ORIGIN + "/f2" });
  if (!f2 || f2.ok !== true) throw new Error("navHandle mint refused (f2): " + JSON.stringify(f2));
  const doc = await send(host, { type: "zl:navHandle", dest: ORIGIN + "/doc" });
  if (!doc || doc.ok !== true) throw new Error("navHandle mint refused (doc): " + JSON.stringify(doc));

  page = await ctx.newPage();
  await page.goto(ENGINE + doc.url, { waitUntil: "domcontentloaded", timeout: 60000 });

  /* The anchors' hrefs are set at runtime to the engine form of the
     two file handles; the watcher reads them at click time. */
  await page.evaluate(([a, b]) => {
    document.getElementById("dl").setAttribute("href", a);
    document.getElementById("plain").setAttribute("href", b);
  }, [ENGINE + f1.url, ENGINE + f2.url]);

  const before = (await registry(host)).length;

  /* The #plain negative control first: no attribute, no intent, and no
     registry row for a response of the same MIME class. */
  await page.click("#plain");
  await sleep(1500);
  const afterPlain = await registry(host);

  /* The download click: headless Chromium turns the same-origin
     a[download] navigation into a browser download; the engine SW
     still sees the navigation and consumes the intent. */
  await page.click("#dl");
  let row = null;
  for (let i = 0; i < 40 && !row; i++) {
    const rows = await registry(host);
    row = rows.find((r) => r.filename === "zw-anchor-saved.txt");
    if (!row) await sleep(500);
  }
  const after = await registry(host);
  console.log("ROW " + JSON.stringify(row));
  console.log("COUNTS " + JSON.stringify(counts));
  const failures = [];
  if (!row) failures.push("no registry row for the a[download] click: the zl:dlIntent seam never adopted the navigation (check ANCHOR_DL_WATCHER in dist/sw.js and the intent probe at adoptResponse)");
  else {
    if (row.initiator !== "anchor") failures.push("row initiator is " + JSON.stringify(row.initiator) + ", not \"anchor\"");
    if (row.status !== "active" && row.status !== "done") failures.push("row state is " + JSON.stringify(row.status));
    if (!String(row.source || String.fromCharCode(0)).includes("f1")) failures.push("row source " + JSON.stringify(row.source) + " does not look like the /f1 target");
  }
  if (after.length - before < 1) failures.push("registry grew by 0 rows after the download click");
  if (after.length - afterPlain.length !== 1) failures.push("registry grew by " + (after.length - afterPlain.length) + " rows between the plain click and the download click (expected exactly 1)");
  if (counts.F1 !== 1) failures.push("fixture /f1 seen " + counts.F1 + " times (exactly 1 navigation is the contract)");
  if (counts.PAGE < 1) failures.push("doc page never loaded through the engine");
  if (counts.OTHER > 0 && counts.PAGE < 1) failures.push("unexpected fixture requests: " + counts.OTHER);
  if (failures.length) {
    console.log("FAIL anchor download e2e");
    for (const f of failures) console.log("  - " + f);
    process.exitCode = 1;
  } else {
    console.log("PASS #541 anchor download: one anchor-initiator row via zl:dlIntent, attribute filename honored on a no-disposition response, plain navigation registered nothing, /f1 seen exactly once");
  }
} catch (err) {
    console.log("ERROR " + err);
    try {
      console.log("PAGE-URL " + page.url());
      console.log("PAGE-BODY " + (await page.content()).slice(0, 400));
    } catch {}
    console.log("COUNTS " + JSON.stringify(counts));
    throw err;
  } finally {
  await browser?.close();
  engineProc?.kill();
  await new Promise((r) => server.close(r));
}
