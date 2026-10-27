/* #454 remaining gate: controlled server-side fault injection, end to
   end through the real stack (page -> engine SW -> wisp -> zeolite-server
   -> target). Oracle: the wire counts per method.

   Coverage (all three #454 acceptance fault phases, POST subject):
   - before connect: port 7104 accepts the TCP connection and destroys
     the socket before reading or writing a single byte (counter at
     accept; exactly 1 = the SW reset+retry never re-dispatched).
   - after headers: /drop-headers fires when the request line and header
     block arrived (Node parsed them), destroys the socket BEFORE
     reading the body or answering.
   - after acceptance: /commit accepts the request fully, records the
     commit, then destroys the socket WITHOUT responding.
   Plus one healthy POST control (200) and one idempotent GET drop.

   2026-10-26 verdict, from instrumented probe runs on this harness:
   - Engine-level delivery gates are CORRECT: the transport retry gate
     refuses a non-idempotent POST after a delivery-unknown failure
     (gate log: method POST, state delivery-unknown, retryable false),
     retries the idempotent GET at most once, and dropped requests
     surface to the page as honest 502s, never as success.
   - Residual violation, below every Zeolite seam: vendored libcurl.js
     v0.7.4 pools upstream connections, and when a REUSED pooled
     connection dies before any response byte, libcurl itself re-sends
     the request once on a fresh connection - regardless of method.
     One adapter call, one error 52: the SW cannot see or gate the
     second dispatch.

   2026-10-27 fix verdict, after instrumented probe evidence:
   - The reachable seam is fixed in libcurl-transport-vendored.ts
   (libcurlRequest): every non-idempotent request rides a per-request
   HTTPSession, a fresh wasm curl multi handle with an empty
   connection cache, so the deterministic pooled re-send (a reused
   pooled connection dying before any response byte, silently
   re-dispatched by libcurl itself) is eliminated at that seam.
   - SW-level gates are proven correct by probe runs: a POST in
     delivery-unknown state is refused at the retry gate, a GET is
     retried at most once, and drops surface as honest 502s.
   - Residual, below every Zeolite seam, now DETERMINISTIC on the full
   three-phase fixture: the vendored libcurl build re-dispatches a
   request when its connection dies in the complete-upload /
   awaiting-response state, regardless of method, regardless of
   fresh-session isolation. 5/5 loop runs (2026-10-27) re-sent the
   drop-after-acceptance POST exactly once: same 13-byte body, two
   distinct remote ports, one adapter call, one error 52. The
   after-headers drop (connection dies mid-upload) and the
   connect-phase drop (connection dies before any byte) are NEVER
   re-dispatched (5/5 runs), which matches vanilla curl semantics
   for those stages. Vanilla curl only retries a REUSED connection
   (Curl_retry_request requires conn->bits.reuse); the vendored
   build deviates and retries a fresh one. The SW cannot observe or
   gate the second dispatch. Fixing this needs the vendored wasm
   seam (a per-request no-retry option, or the vanilla reuse check
   restored in libcurl-wasm), the same seam class as #496.
   - POST===1 stays pinned on ALL THREE fault phases. It is RED
   today, deterministically, and the pin is the contract: it goes
   green only when the vendored seam stops the re-send. Every red
   is real evidence, not harness flake. The healthy control POST
   and the honest 502 assertions stay green (5/5), so the engine
   side of #454 is verified; the violation is purely the vendored
   re-send.
   - The idempotent GET bound is [1,8]: the fixture fires all five
   requests concurrently, so up to three connections are killed
   while other requests are in flight; the vendored re-send plus
   at most one SW-level retry gives a run worst case of
   2 x (1 + 3) = 8 wire attempts. All GET replays are
   idempotent-legal.
 
   This harness PINS THE CONTRACT: POST===1 (every phase) and honest
   non-success answers. It is not CI-gated on PR workflows; the deterministic POST red is the documented vendored residual, not harness flake.

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
const DROPC_PORT = 7104;
const PAGE_HTML = readFileSync(join(dirname(new URL(import.meta.url).pathname), "delivery-fault-page.html"), "utf8");

const counts = { GET: 0, POST: 0, POSTOK: 0, PAGE: 0, OTHER: 0, DROPH: 0, DROPC: 0 };
const seen = [];
const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.url === "/fault-page") {
    counts.PAGE++;
    res.setHeader("content-type", "text/html");
    res.end(PAGE_HTML);
    return;
  }
  if (req.url.startsWith("/ok")) {
    let n = 0;
    req.on("data", (c) => { n += c.length; });
    req.on("end", () => {
      counts.POSTOK++;
      seen.push("ok:" + req.method + ":" + n + ":" + res.socket.remotePort + ":q=" + (req.url.split("?")[1] ?? "-"));
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
  if (req.url.startsWith("/drop-headers")) {
    /* #454 after-headers phase: the header block arrived (this handler
       firing proves Node parsed the request line and headers); destroy
       BEFORE reading the body or answering. Exactly one arrival is the
       pinned contract for the non-idempotent POST. */
    counts.DROPH++;
    seen.push("droph:" + req.method + ":" + res.socket.remotePort + ":q=" + (req.url.split("?")[1] ?? "-"));
    res.socket.destroy();
    return;
  }
  if (req.url.split("?")[0] === "/commit") {
    /* Accept fully, record the commit, then destroy with NO response. */
    let n = 0;
    req.on("data", (c) => { n += c.length; });
    req.on("end", () => {
      const m = req.method === "POST" ? "POST" : "GET";
      counts[m]++;
      seen.push("commit:" + m + ":" + n + ":" + res.socket.remotePort + ":q=" + (req.url.split("?")[1] ?? "-"));
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

/* #454 before-connect phase: the target accepts the TCP connection and
   destroys the socket before reading or writing a single byte. Every
   accept is one wire attempt; exactly 1 is the pinned contract for the
   non-idempotent POST (no SW reset+retry, no wasm re-send). */
const dropConnServer = createServer(() => {});
dropConnServer.on("connection", (s) => {
  counts.DROPC++;
  seen.push("dropc");
  s.destroy();
});
await new Promise((r) => dropConnServer.listen(DROPC_PORT, "127.0.0.1", r));

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
  const posth = results.find((r) => r.kind === "posth");
  const postc = results.find((r) => r.kind === "postc");
  console.log("RESULTS " + JSON.stringify(results));
  console.log("WIRE " + JSON.stringify(log));
  const failures = [];
  if (log.counts.POST !== 1)
    failures.push("POST attempts " + log.counts.POST + " (expected exactly 1). If the count is 2, this is the vendored libcurl.js v0.7.4 pooled-connection re-send: a non-idempotent request on a reused connection that dies before any response byte is silently re-dispatched by libcurl itself (see the header comment). Fix needs the vendored wasm seam, not the engine gates - they already refuse this replay. This is red today (deterministic on the full three-phase fixture, 5/5 runs) until the vendored libcurl-wasm seam ships a per-request no-retry option.");
  if (log.counts.GET < 1 || log.counts.GET > 8) failures.push("GET attempts " + log.counts.GET + " outside [1,8] (idempotent replays are legal; 8 is the concurrent-kill run worst case, see header; above 8 is a runaway re-send)");
  if (honestFailure(post)) failures.push("POST drop answered as success: " + JSON.stringify(post));
  if (honestFailure(get)) failures.push("GET drop answered as success: " + JSON.stringify(get));
  if (!control.ok || control.status !== 200) failures.push("healthy POST control failed: " + JSON.stringify(control));
  if (log.counts.POSTOK !== 1) failures.push("healthy POST control seen " + log.counts.POSTOK + " times");
  if (log.counts.PAGE < 1) failures.push("fault page never loaded through the engine");
  if (log.counts.DROPH !== 1) failures.push("after-headers drop: POST attempts " + log.counts.DROPH + " (expected exactly 1; the SW reset+retry is gated by retryable()/IDEMPOTENT_METHODS in transport.ts, a POST must never be re-dispatched)");
  if (honestFailure(posth)) failures.push("after-headers drop answered as success: " + JSON.stringify(posth));
  if (log.counts.DROPC !== 1) failures.push("before-connect drop: TCP accepts " + log.counts.DROPC + " (expected exactly 1; a connect-phase failure is delivery-unknown for a non-idempotent request, no automatic retry is legal)");
  if (honestFailure(postc)) failures.push("before-connect drop answered as success: " + JSON.stringify(postc));
  if (failures.length) {
    console.log("FAIL delivery fault injection");
    for (const f of failures) console.log("  - " + f);
    process.exitCode = 1;
  } else {
    console.log("PASS all three #454 fault phases: drop-after-acceptance POST seen once (never replayed), GET attempts " + log.counts.GET + " in [1,8], after-headers POST once, before-connect POST one accept, all drops answered honestly, healthy control 200");
  }
} finally {
  await browser?.close();
  engineProc?.kill();
  await new Promise((r) => server.close(r));
  await new Promise((r) => dropConnServer.close(r));
}
