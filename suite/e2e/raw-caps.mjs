/* Issue #526: real-Chromium acceptance for bounded raw-block
   buffering in the streaming HTML rewriter.

   The Rust side already pins the byte-level contract: ordinary raw
   script/style bodies are retained only up to RAW_PASS_CAP (2 MiB),
   an over-cap block switches to verbatim passthrough (raw_pass_scan
   streams the remainder without retaining it, locating the close tag
   on the fly), and blocked-element swallowing is bounded separately
   by DROP_RAW_CAP (256 KiB) - all covered by the rewriter's unit
   tests including arbitrary chunk boundaries. What only a genuine
   browser can prove is this suite's contract:

   - Proxied: a normal inline style is rewritten (engine routes in
     the served text, no fixture-origin leak) and applies; a normal
     inline script executes.
   - Proxied: an over-cap inline style (RAW_PASS_CAP + 64 KiB) and an
     over-cap inline script are served verbatim, fail-open and
     complete (the tail rule applies, the tail line executes, the
     served text length is exact): never truncated at the cap, never
     dropped, never half-rewritten.
   - Measurable TTFB/streaming gate: a chunked fixture serves a marker
     element BEFORE an unterminated 6 MiB raw script block (no close
     tag, EOF ends it). The marker must become visible in the proxied
     frame while the bulk is still streaming (< 2 s against a ~2.6 s
     bulk), proving the engine never full-buffers the document before
     emitting; and the navigation must complete within a bounded time,
     proving an unterminated raw block cannot pin the stream or wedge
     the engine. The direct control pins the same fixture behavior
     without the engine.

   The retention bound itself (2 MiB) is a fixed rewriter constant
   enforced and unit-tested in Rust; this browser gate adds the
   measured latency dimension. A truly infinite response is not
   simulated (CI wedge risk); the unterminated fixture documents that
   choice. Ports 6043/7143 never collide with the other suites
   (e2e 6002/7101, srcdoc-clients 6031/7131, sri 6041/7141,
   importmap 6036/7136, csp-enforce 6026/7127, vorigin-msg
   6027/7128, computed-sinks 6023/7123, replay-spool 6025/7125,
   vctx-restart/blob-workers 6034/7134, guest-sw 6009/7109). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6043;
const FX_PORT = 7143;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX = "http://127.0.0.1:" + FX_PORT;
const VIRTUAL_PAGE = FX + "/rc/page.html";
const VIRTUAL_STREAM = FX + "/rc/stream.html";

/* Must mirror RAW_PASS_CAP in crates/rewriter/src/html/mod.rs. */
const CAP = 2 * 1024 * 1024;
const OVER = CAP + 64 * 1024;

/* 1x1 transparent PNG for the normal style's url() load. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

/* Over-cap bodies: pure comment filler plus a distinctive tail, so a
   verbatim complete serve is provable (the tail rule applies / the
   tail line executes) and a truncation at the cap is impossible to
   miss. No URL-shaped content: the verbatim fallback must not be
   conflated with routing questions here. */
function bigStyle() {
  const tail = "\n#bigel { color: rgb(9, 9, 9); }\n";
  const unit = "/*" + "a".repeat(94) + "*/"; // 100 bytes
  const n = Math.ceil((OVER - tail.length) / unit.length);
  let s = "";
  for (let i = 0; i < n; i++) s += unit;
  s += tail;
  return s;
}
function bigScript() {
  const tail = "\nwindow.__RC_BIG_JS = 1;\n";
  const unit = "/*" + "b".repeat(94) + "*/"; // 100 bytes
  const n = Math.ceil((OVER - tail.length) / unit.length);
  let s = "";
  for (let i = 0; i < n; i++) s += unit;
  s += tail;
  return s;
}
const BIG_STYLE = bigStyle();
const BIG_SCRIPT = bigScript();

function pageHtml() {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<style id=\"normcss\">.nrm { color: rgb(2, 2, 2); background: url('/rc/dot.png'); }</style>",
    "<script>window.__RC_NORM_JS = 1;</script>",
    "</head><body>",
    "<div class=\"nrm\" id=\"nrmel\">n</div>",
    "<div id=\"bigel\">b</div>",
    "<style id=\"bigcss\">" + BIG_STYLE + "</style>",
    "<script id=\"bigjs\">" + BIG_SCRIPT + "</script>",
    "</body></html>",
  ].join("");
}

const results = [];
let engineProc = null;
const engineErr = [];
let browser = null;
let fxs = null;
const hits = [];

async function check(name, fn) {
  try {
    const info = await fn();
    results.push({ ok: true, name, info: info ?? "" });
    console.log("  ok   " + name + (info ? " :: " + info : ""));
  } catch (e) {
    results.push({ ok: false, name, info: String(e?.message ?? e) });
    console.log("  FAIL " + name + " :: " + String(e?.message ?? e));
  }
}

function engineTail() {
  return engineErr.slice(-20).join("").slice(0, 2500);
}

async function virtualFrame(page) {
  for (let i = 0; i < 60; i++) {
    const frame = page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
    if (frame) return frame;
    await sleep(500);
  }
  throw new Error("virtual frame never appeared");
}

/* The streamed fixture: a marker element, then an unterminated raw
   script block (EOF closes it) fed in 96 KiB chunks with 40 ms
   delays: ~6 MiB over ~2.6 s. res.write backpressure is ignored (the
   loop bounds the total), so the only delay source is deliberate. */
const BULK_CHUNK = "/*" + "c".repeat(96 * 1024 - 6) + "*/";
const BULK_ROUNDS = 64;
const BULK_DELAY_MS = 40;

async function main() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  fxs = await new Promise((resolve_) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, FX);
      hits.push(u.pathname);
      if (u.pathname === "/rc/page.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(pageHtml());
      } else if (u.pathname === "/rc/dot.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
      } else if (u.pathname === "/rc/stream.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<!doctype html><html><head></head><body><div id='rcmarker'>m</div><script>");
        res.write("/*" + "d".repeat(1024) + "*/");
        (async () => {
          for (let i = 0; i < BULK_ROUNDS; i++) {
            await sleep(BULK_DELAY_MS);
            if (res.destroyed) return;
            res.write(BULK_CHUNK);
          }
          res.end(); /* EOF without </script>: the raw block is unterminated. */
        })();
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    srv.listen(FX_PORT, "127.0.0.1", () => resolve_(srv));
  });
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], {
    env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await sleep(2500);
  if (engineProc.exitCode !== null) {
    throw new Error("engine exited early (port conflict or build failure): " + engineTail());
  }
  browser = await chromium.launch({ args: ["--no-sandbox"] });

  /* --- proxied mode: engine rewrites and serves --- */
  const pctx = await browser.newContext();
  const ppage = await pctx.newPage();
  ppage.on("console", (m) => console.log("PAGE-CONSOLE " + m.type() + " " + m.text().slice(0, 200)));
  ppage.on("pageerror", (e) => console.log("PAGE-ERROR " + String(e).slice(0, 300)));
  await ppage.goto(ENGINE + "/?url=" + encodeURIComponent(VIRTUAL_PAGE));
  const pframe = await virtualFrame(ppage);

  /* Poll until every flag and both colors settle. */
  let st = null;
  for (let i = 0; i < 60; i++) {
    st = await pframe.evaluate(() => ({
      norm: window.__RC_NORM_JS,
      big: window.__RC_BIG_JS,
      nrm: document.getElementById("nrmel") ? getComputedStyle(document.getElementById("nrmel")).color : null,
      bigc: document.getElementById("bigel") ? getComputedStyle(document.getElementById("bigel")).color : null,
      normText: document.getElementById("normcss") ? document.getElementById("normcss").textContent : null,
      bigText: document.getElementById("bigcss") ? document.getElementById("bigcss").textContent : null,
      bigJsText: document.getElementById("bigjs") ? document.getElementById("bigjs").textContent : null,
    })).catch(() => null);
    if (st && st.norm === 1 && st.big === 1 && st.bigc === "rgb(9, 9, 9)" && st.nrm === "rgb(2, 2, 2)") break;
    await sleep(500);
  }

  if (!st) throw new Error("the proxied page state never became readable; engine tail: " + engineTail());
  if (st.norm !== 1 || st.big !== 1 || st.bigc !== "rgb(9, 9, 9)") {
    console.log("  [settle] flags incomplete after 30s: " + JSON.stringify({
      norm: st.norm, big: st.big, nrm: st.nrm, bigc: st.bigc,
    }));
  }

  await check("proxied: normal inline style is rewritten to engine routes (no fixture-origin leak)", () => {
    if (!st.normText) throw new Error("style text unreadable");
    if (st.normText.includes("7143")) throw new Error("fixture origin leaked in the served style: " + st.normText.slice(0, 200));
    if (!st.normText.includes("/j/")) throw new Error("no engine route in the served style: " + st.normText.slice(0, 200));
    return "rewritten";
  });
  await check("proxied: normal inline style applies and its url() loads through the engine", () => {
    if (st.nrm !== "rgb(2, 2, 2)") throw new Error("normal style not applied: " + st.nrm);
    if (!hits.includes("/rc/dot.png")) throw new Error("the engine never fetched the style image upstream");
    return "ok";
  });
  await check("proxied: normal inline script executes", () => {
    if (st.norm !== 1) throw new Error("norm=" + st.norm);
    return "ok";
  });
  await check("proxied: over-cap inline style (RAW_PASS_CAP + 64 KiB) is served verbatim and its tail rule applies", () => {
    if (st.bigc !== "rgb(9, 9, 9)") throw new Error("tail rule not applied (truncated or dropped?): " + st.bigc);
    if (st.bigText === null) throw new Error("style text unreadable");
    if (Math.abs(st.bigText.length - BIG_STYLE.length) > 16) {
      throw new Error("served over-cap style length " + st.bigText.length + " != " + BIG_STYLE.length + " (truncated or half-rewritten)");
    }
    if (!st.bigText.trimEnd().endsWith("#bigel { color: rgb(9, 9, 9); }")) throw new Error("tail bytes not served verbatim");
    return "verbatim fail-open, complete (" + st.bigText.length + " bytes)";
  });
  await check("proxied: over-cap inline script executes and is served complete", () => {
    if (st.big !== 1) throw new Error("over-cap script never ran (truncated or dropped?): " + st.big);
    if (st.bigJsText === null) throw new Error("script text unreadable");
    if (Math.abs(st.bigJsText.length - BIG_SCRIPT.length) > 16) {
      throw new Error("served over-cap script length " + st.bigJsText.length + " != " + BIG_SCRIPT.length);
    }
    if (!st.bigJsText.trimEnd().endsWith("window.__RC_BIG_JS = 1;")) throw new Error("tail bytes not served verbatim");
    return "verbatim fail-open, complete (" + st.bigJsText.length + " bytes)";
  });

  /* --- measurable TTFB/streaming gate, proxied --- */
  const gatePage = await pctx.newPage();
  const t0 = Date.now();
  await gatePage.goto(ENGINE + "/?url=" + encodeURIComponent(VIRTUAL_STREAM), { waitUntil: "commit" });
  const gateFrame = await virtualFrame(gatePage);
  let markerMs = null;
  for (let i = 0; i < 120; i++) {
    const got = await gateFrame.locator("#rcmarker").count().catch(() => 0);
    if (got > 0) { markerMs = Date.now() - t0; break; }
    await sleep(100);
  }
  /* Wait for the frame document to finish parsing (EOF ends the
     unterminated script; the empty comment body executes cleanly). */
  let loadMs = null;
  for (let i = 0; i < 300; i++) {
    const rs = await gateFrame.evaluate(() => document.readyState).catch(() => null);
    if (rs === "complete") { loadMs = Date.now() - t0; break; }
    await sleep(100);
  }
  const alive = await gateFrame.locator("#rcmarker").count().catch(() => 0);
  const bulkMs = BULK_ROUNDS * BULK_DELAY_MS;
  const loadMsExpected = "(measured below; a full-buffering path delays the marker to roughly the completion time)";

  await check("proxied: the marker before an unterminated 6 MiB raw block appears while the bulk still streams (TTFB gate)", () => {
    if (markerMs === null) throw new Error("marker never appeared");
    if (markerMs >= 5000) throw new Error("marker took " + markerMs + "ms: the engine full-buffers before emitting (a full-buffering path would delay the marker to the ~" + loadMsExpected + "ms completion time)");
    return "marker visible at " + markerMs + "ms (bulk streams for ~" + bulkMs + "ms)";
  });
  await check("proxied: the unterminated raw block cannot pin the stream (bounded completion)", () => {
    if (loadMs === null) throw new Error("frame never finished parsing after " + (Date.now() - t0) + "ms");
    if (loadMs >= 45000) throw new Error("navigation took " + loadMs + "ms (unbounded)");
    if (loadMs <= markerMs) throw new Error("load (" + loadMs + "ms) preceded the marker (" + markerMs + "ms): the bulk never streamed");
    return "complete at " + loadMs + "ms, page alive: " + (alive > 0);
  });
  await pctx.close();

  /* --- direct controls: the fixtures themselves, no engine --- */
  const dctx = await browser.newContext();
  const dpage = await dctx.newPage();
  await dpage.goto(FX + "/rc/page.html");
  let d = null;
  for (let i = 0; i < 40; i++) {
    d = await dpage.evaluate(() => ({
      norm: window.__RC_NORM_JS,
      big: window.__RC_BIG_JS,
      nrm: getComputedStyle(document.getElementById("nrmel")).color,
      bigc: getComputedStyle(document.getElementById("bigel")).color,
    })).catch(() => null);
    if (d && d.norm === 1 && d.big === 1) break;
    await sleep(500);
  }
  await check("direct: over-cap style and script behave natively (control)", () => {
    if (d.bigc !== "rgb(9, 9, 9)") throw new Error("bigc=" + d.bigc);
    if (d.big !== 1) throw new Error("big=" + d.big);
    return "ok";
  });
  const dstream = await dctx.newPage();
  const dt0 = Date.now();
  await dstream.goto(FX + "/rc/stream.html", { waitUntil: "commit" });
  let dmarker = null;
  for (let i = 0; i < 120; i++) {
    if ((await dstream.locator("#rcmarker").count().catch(() => 0)) > 0) { dmarker = Date.now() - dt0; break; }
    await sleep(100);
  }
  await check("direct: the streaming fixture shows the marker early without the engine (control)", () => {
    if (dmarker === null) throw new Error("marker never appeared");
    if (dmarker >= 5000) throw new Error("marker took " + dmarker + "ms: the fixture itself buffers");
    return "marker at " + dmarker + "ms";
  });
  await dctx.close();

  const failed = results.filter((r) => !r.ok);
  console.log(results.length - failed.length + "/" + results.length + " raw-caps checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR raw-caps suite failed; engine tail:\n" + engineTail());
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
    try { if (engineProc) engineProc.kill("SIGKILL"); } catch {}
    try { if (fxs) fxs.close(); } catch {}
  });
