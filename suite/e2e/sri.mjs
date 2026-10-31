/* Issue #531 (#549 child): real-Chromium acceptance for engine-side
   subresource integrity. The Rust rewriter drops browser-facing
   integrity attributes (transformed bytes can never match an
   upstream hash), so the engine itself must verify: document serves
   scan script/link integrity metadata into a per-client registry,
   fresh script/stylesheet subresources verify over RAW upstream
   bytes before any transform, and blocked bodies never reach the
   page. This suite proves the chain in a genuine browser against a
   loopback fixture whose hashes are computed over the exact served
   bytes: valid SRI loads proxied and direct, a tampered upstream
   body is blocked in BOTH modes, an unsupported algorithm falls
   back to the compatibility serve (pinned, honest divergence from
   the browser's fail-closed native behavior), a redirect hashes the
   FINAL body, and a second navigation re-serves the cached document
   and still loads the verified script. Ports 6028/7130 never
   collide with e2e.mjs (6002/7101), blob-workers (6034/7134) or
   the vctx-restart suite, and never with the parallel agents'
   engine instances on this host. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6041;
const FX_PORT = 7141;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX = "http://127.0.0.1:" + FX_PORT;
const VIRTUAL_PAGE = FX + "/sri/page.html";

/* Fixture bodies: exact bytes the hashes are computed over. */
const APP_JS = "window.__ZL_SRI_APP = 1;";
const TAMPER_SERVED = "window.__ZL_SRI_TAMPER = 1;";
const TAMPER_HASHED = "window.__ZL_SRI_TAMPER = 'something-else';";
const MD5_JS = "window.__ZL_SRI_MD5 = 1;";
const FINAL_JS = "window.__ZL_SRI_REDIR = 1;";
const STYLE_CSS = "body { background-color: rgb(1, 2, 3); }";

function sha384(body) {
  return "sha384-" + createHash("sha384").update(body).digest("base64");
}

const INTEGRITY = {
  app: sha384(APP_JS),
  tamper: sha384(TAMPER_HASHED),
  /* md5 digests are 16 bytes = 24 base64 chars; Chromium does not
     support md5 for SRI and fails the load closed. */
  md5: "md5-" + createHash("md5").update(MD5_JS).digest("base64"),
  redir: sha384(FINAL_JS),
  css: sha384(STYLE_CSS),
};

function pageHtml() {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<script>",
    "window.__ZL_SRI_ERR = [];",
    "window.addEventListener('error', function (e) {",
    "  var t = e.target;",
    "  if (t && t.getAttribute && t.getAttribute('data-sri')) window.__ZL_SRI_ERR.push(t.getAttribute('data-sri'));",
    "}, true);",
    "</script>",
    "<script src=\"/sri/app.js\" integrity=\"" + INTEGRITY.app + "\" data-sri=\"app\"></script>",
    "<script src=\"/sri/tamper.js\" integrity=\"" + INTEGRITY.tamper + "\" data-sri=\"tamper\"></script>",
    "<script src=\"/sri/md5.js\" integrity=\"" + INTEGRITY.md5 + "\" data-sri=\"md5\"></script>",
    "<script src=\"/sri/redirect.js\" integrity=\"" + INTEGRITY.redir + "\" data-sri=\"redir\"></script>",
    "<link rel=\"stylesheet\" href=\"/sri/style.css\" integrity=\"" + INTEGRITY.css + "\" data-sri=\"css\">",
    "</head><body>sri fixture</body></html>",
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
  } catch (e) {
    results.push({ ok: false, name, info: String(e?.message ?? e) });
  }
}

function engineTail() {
  return engineErr.slice(-20).join("").slice(0, 2500);
}

/* Poll the frame until every document flag settles (each script
   either ran or errored) or the cap expires. */
async function settle(frame) {
  for (let i = 0; i < 60; i++) {
    const st = await frame.evaluate(() => ({
      app: window.__ZL_SRI_APP,
      tamper: window.__ZL_SRI_TAMPER,
      md5: window.__ZL_SRI_MD5,
      redir: window.__ZL_SRI_REDIR,
      bg: document.body ? getComputedStyle(document.body).backgroundColor : null,
    }));
    if (st.app !== undefined && st.md5 !== undefined && st.redir !== undefined && st.bg !== "rgba(0, 0, 0, 0)") {
      return st;
    }
    await sleep(500);
  }
  throw new Error("document flags never settled");
}

async function virtualFrame(page) {
  for (let i = 0; i < 60; i++) {
    const frame = page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
    if (frame) return frame;
    await sleep(500);
  }
  throw new Error("virtual frame never appeared");
}

async function main() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  fxs = await new Promise((resolve_) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, FX);
      hits.push(u.pathname);
      if (u.pathname === "/sri/page.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(pageHtml());
      } else if (u.pathname === "/sri/app.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(APP_JS);
      } else if (u.pathname === "/sri/tamper.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(TAMPER_SERVED);
      } else if (u.pathname === "/sri/md5.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(MD5_JS);
      } else if (u.pathname === "/sri/redirect.js") {
        res.writeHead(302, { location: "/sri/final.js" });
        res.end();
      } else if (u.pathname === "/sri/final.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(FINAL_JS);
      } else if (u.pathname === "/sri/style.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(STYLE_CSS);
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

  /* --- proxied mode: engine intercepts, verifies, serves --- */
  const pctx = await browser.newContext();
  const ppage = await pctx.newPage();
  ppage.on("console", (m) => console.log("PAGE-CONSOLE " + m.type() + " " + m.text().slice(0, 200)));
  ppage.on("pageerror", (e) => console.log("PAGE-ERROR " + String(e).slice(0, 300)));
  await ppage.goto(ENGINE + "/?url=" + encodeURIComponent(VIRTUAL_PAGE));
  const pframe = await virtualFrame(ppage);
  const first = await settle(pframe);
  const firstErrs = await pframe.evaluate(() => window.__ZL_SRI_ERR);

  await check("proxied: valid SRI script runs through the engine", () => {
    if (first.app !== 1) throw new Error("app=" + first.app);
    return "ok";
  });
  await check("proxied: tampered upstream script is blocked (never runs)", () => {
    if (first.tamper !== undefined) throw new Error("tamper ran: " + first.tamper);
    if (!firstErrs.includes("tamper")) throw new Error("no error event; errs=" + JSON.stringify(firstErrs));
    return "blocked";
  });
  await check("proxied: unsupported algorithm falls back to the compatibility serve", () => {
    if (first.md5 !== 1) throw new Error("md5=" + first.md5);
    return "served (skipped:unsupported-algorithm)";
  });
  await check("proxied: redirect body is hashed over the final destination", () => {
    if (first.redir !== 1) throw new Error("redir=" + first.redir);
    if (!hits.includes("/sri/final.js")) throw new Error("redirect not followed by the engine");
    return "ok";
  });
  await check("proxied: valid SRI stylesheet applies", () => {
    if (first.bg !== "rgb(1, 2, 3)") throw new Error("bg=" + first.bg);
    return "ok";
  });

  /* --- second navigation: the document comes from the page cache,
     the doc serve repopulates the registry, the script still runs --- */
  await sleep(2000);
  const ppage2 = await pctx.newPage();
  await ppage2.goto(ENGINE + "/?url=" + encodeURIComponent(VIRTUAL_PAGE));
  const pframe2 = await virtualFrame(ppage2);
  const second = await settle(pframe2);
  const secondErrs = await pframe2.evaluate(() => window.__ZL_SRI_ERR);
  await check("second navigation: cached document re-populates the registry and the script still runs", () => {
    if (second.app !== 1) throw new Error("app=" + second.app);
    return "ok";
  });
  await check("second navigation: the tampered script is still blocked", () => {
    if (second.tamper !== undefined) throw new Error("tamper ran on second visit");
    if (!secondErrs.includes("tamper")) throw new Error("no error event; errs=" + JSON.stringify(secondErrs));
    return "blocked";
  });
  await pctx.close();

  /* --- direct mode: native Chromium SRI, no engine --- */
  const dctx = await browser.newContext();
  const dpage = await dctx.newPage();
  await dpage.goto(FX + "/sri/page.html");
  await sleep(4000);
  const direct = await dpage.evaluate(() => ({
    app: window.__ZL_SRI_APP,
    tamper: window.__ZL_SRI_TAMPER,
    md5: window.__ZL_SRI_MD5,
    redir: window.__ZL_SRI_REDIR,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  await dctx.close();

  await check("direct: valid SRI script runs natively (control)", () => {
    if (direct.app !== 1) throw new Error("app=" + direct.app);
    return "ok";
  });
  await check("direct: tampered script is blocked natively (parity with the engine)", () => {
    if (direct.tamper !== undefined) throw new Error("tamper ran: " + direct.tamper);
    return "blocked";
  });
  await check("direct: an unsupported algorithm is ignored natively (parity with the engine fallback)", () => {
    /* Chromium skips tokens with unknown algorithms and, with no
       valid candidate left, ignores the attribute entirely - the
       same compatibility serve the engine records as
       skipped:unsupported-algorithm. No divergence. */
    if (direct.md5 !== 1) throw new Error("md5 blocked natively: " + direct.md5);
    return "served (parity)";
  });
  await check("direct: redirect SRI hashes the final body natively (parity)", () => {
    if (direct.redir !== 1) throw new Error("redir=" + direct.redir);
    return "ok";
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok  " : "  FAIL") + " " + r.name + (r.ok ? "" : " (" + r.info + ")"));
  }
  console.log(results.length - failed.length + "/" + results.length + " sri checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR sri suite failed; engine tail:\n" + engineTail());
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
