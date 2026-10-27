/* #454 remaining gate: controlled server-side drop-after-acceptance
   fault injection, end to end through the real stack (page -> engine
   SW -> wisp -> zeolite-server -> target). The target accepts the
   request fully, records the commit, then destroys the socket WITHOUT
   responding. Oracle: the wire counts per method.

   2026-10-26 verdict, from instrumented probe runs on this harness:
   - Engine-level delivery gates are CORRECT: the transport retry gate
     refuses a non-idempotent POST after a delivery-unknown failure
     (gate log: method POST, state delivery-unknown, retryable false),
     retries the idempotent GET at most once, and both dropped
     requests surface to the page as honest 502s, never as success.
   - Residual violation, below every Zeolite seam: vendored libcurl.js
     v0.7.4 pools upstream connections, and when a REUSED pooled
     connection dies before any response byte, libcurl itself re-sends
     the request once on a fresh connection - regardless of method.
     Observed: the first POST rode the document fetch connection
     (keep-alive reuse), the server accepted and dropped it, libcurl
     silently re-sent it on a new connection. One adapter call, one
     error 52: the SW cannot see or gate the second dispatch.
   - Fix requires the vendored wasm seam: a per-request fresh-connect
     option in the libcurl-wasm params (upstream), or session-wide
     set_connections cache_limit=0 (kills keep-alive reuse for all
     traffic; a perf policy decision, not a default).

   This harness therefore PINS THE CONTRACT: POST===1 fails today
   with the message naming the vendored root cause, and goes green
   once the seam is fixed. It is not CI-gated on PR workflows.
   2026-10-27 fix verdict: the reachable seam is fixed in
   libcurl-transport-vendored.ts (libcurlRequest): every non-idempotent
   request now rides a per-request HTTPSession - a fresh wasm curl
   multi handle with an empty connection cache, so the request opens a
   brand-new connection and libcurl never re-sends it (its dead
   connection retry fires only for REUSED connections; a fresh one
   surfaces error 52 honestly). POST===1 is expected GREEN and stays
   as the pinned contract against regressions. The idempotent GET
   bound is 3 wire attempts: the original, at most one wasm-level
   re-send after a reused pooled connection dies, and one SW-level
   retry - all replay-safe by method parity (transport.ts
   IDEMPOTENT_METHODS).

   Flow mirrors differential.mjs: controlledHost at the engine root
   (explicit /sw.js module registration fallback), a zl:navHandle
   mint, then this fault fixture at the handle route. The fixture
   fetches ABSOLUTE cross-origin URLs so the engine SW proxies them
   like any third-party subresource; the fixture server answers
   permissive CORS. Run: node suite/e2e/delivery-fault.mjs */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE = "http://127.0.0.1:6002";
const STATIC = process.env.ZL_STATIC ?? resolve("app/dist");
const PORT = 7103;
const ORIGIN = "http://127.0.0.1:" + PORT;
const PAGE_HTML = readFileSync(join(dirname(new URL(import.meta.url).pathname), "delivery-fault-page.html"), "utf8");

const counts = { GET: 0, POST: 0, POSTOK: 0, PAGE: 0, OTHER: 0 };
const seen = [];
const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.url === "/fault-page") {
    counts.PAGE++;
    res.setHeader("content-type", "text/html");
    res.end(PAGE_HTML);
    return;
  }
  if (req.url === "/ok") {
    let n = 0;
    req.on("data", (c) => { n += c.length; });
    req.on("end", () => {
      counts.POSTOK++;
      seen.push("ok:" + req.method + ":" + n);
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    return;
  }
  if (req.url === "/log") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ counts, seen }));
    return;
  }
  if (req.url === "/commit") {
    /* Accept fully, record the commit, then destroy with NO response. */
    let n = 0;
    req.on("data", (c) => { n += c.length; });
    req.on("end", () => {
      const m = req.method === "POST" ? "POST" : "GET";
      counts[m]++;
      seen.push("commit:" + m + ":" + n);
      res.socket.destroy();
    });
    return;
  }
  counts.OTHER++;
  seen.push("other:" + req.method + ":" + req.url);
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
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) throw new Error("zeolite-server not built: " + bin);
  engineProc = spawn(bin, ["--port", "6002", "--static", STATIC], {
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

const honestFailure = (r) =>
  !r || r.ok === true || !r.err && !(r.ok === false && r.status >= 500);

let browser = null;
try {
  await startEngine();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const host = await controlledHost(ctx);
  const h = await send(host, { type: "zl:navHandle", dest: ORIGIN + "/fault-page" });
  if (!h || h.ok !== true) throw new Error("navHandle mint refused: " + JSON.stringify(h));
  await host.close();
  const page = await ctx.newPage();
  await page.goto(ENGINE + h.url, { waitUntil: "commit", timeout: 60000 });
  await page.waitForFunction(() => window.__zl_fault !== null && window.__zl_fault !== undefined, null, { timeout: 45000 });
  const results = await page.evaluate(() => window.__zl_fault);
  await sleep(1500);
  const log = await (await fetch(ORIGIN + "/log")).json();
  const post = results.find((r) => r.kind === "post");
  const get = results.find((r) => r.kind === "get");
  const control = results.find((r) => r.kind === "control");
  console.log("RESULTS " + JSON.stringify(results));
  console.log("WIRE " + JSON.stringify(log));
  const failures = [];
  if (log.counts.POST !== 1)
    failures.push("POST attempts " + log.counts.POST + " (expected exactly 1). If the count is 2, this is the vendored libcurl.js v0.7.4 pooled-connection re-send: a non-idempotent request on a reused connection that dies before any response byte is silently re-dispatched by libcurl itself (see the header comment). Fix needs the vendored wasm seam, not the engine gates - they already refuse this replay.");
  if (log.counts.GET < 1 || log.counts.GET > 3) failures.push("GET attempts " + log.counts.GET + " outside [1,3] (one SW-level retry plus at most one wasm-level pooled re-send, both idempotent-legal)");
  if (honestFailure(post)) failures.push("POST drop answered as success: " + JSON.stringify(post));
  if (honestFailure(get)) failures.push("GET drop answered as success: " + JSON.stringify(get));
  if (!control.ok || control.status !== 200) failures.push("healthy POST control failed: " + JSON.stringify(control));
  if (log.counts.POSTOK !== 1) failures.push("healthy POST control seen " + log.counts.POSTOK + " times");
  if (log.counts.PAGE < 1) failures.push("fault page never loaded through the engine");
  if (failures.length) {
    console.log("FAIL delivery fault injection");
    for (const f of failures) console.log("  - " + f);
    process.exitCode = 1;
  } else {
    console.log("PASS drop-after-acceptance: POST seen once (never replayed), GET attempts " + log.counts.GET + ", both failed honestly, healthy control 200");
  }
} finally {
  await browser?.close();
  engineProc?.kill();
  await new Promise((r) => server.close(r));
}