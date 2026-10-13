/* Reload-count regression harness (refresh-spam rule).

   The no-refresh-spam contract: a broken or uncontrollable load shows
   ONE honest surface (status message or error page with a manual
   retry) and never enters a reload loop. Two cases:

   A. A service worker that never claims its clients: the embed page
      reloads exactly once (the guarded boot reload), then proceeds;
      with the boot key already spent it reloads ZERO times and shows
      the status message instead. The never-claim SW is served for
      real by a second engine instance on :6003 whose static dir ships
      a doctored sw.js - Playwright route interception cannot see the
      SW script fetch (it bypasses the page network stack), so the
      script must be doctored server-side.
   B. A broken upstream (dead port): the embed page never reloads, the
      frame navigates exactly once (ignoring the iframe's own
      about:blank creation nav), and the honest error page with the
      manual "Try again" button renders.

   Run: node suite/e2e/reload-count.mjs  (from the repo root, after
   `cargo build -p zeolite-server --release`, an app/dist build,
   `npm install` in suite/e2e, and `npx playwright install chromium`.) */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE = "http://127.0.0.1:6002";
const DOCTORED = "http://127.0.0.1:6003";
const results = [];
const engines = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(msg + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")");
}

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

async function startEngine(port, staticDir, errLog) {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  const proc = spawn(bin, ["--port", String(port), "--static", staticDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  engines.push(proc);
  proc.stderr.on("data", (d) => errLog.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/sw.js");
      if (r.status === 200) return proc;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("engine server never came up on " + port);
}

/* A fresh, guaranteed-dead local port (bind 0, read the port, close). */
function deadPort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/* Main-frame and child-frame navigation counters via CDP: a reload is
   a main-frame navigation to the same URL. The iframe's about:blank
   creation nav is counted separately - it is not a load of a route. */
async function navCounter(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Page.enable");
  const rec = { main: [], childRoutes: 0, childBlank: 0 };
  cdp.on("Page.frameNavigated", (e) => {
    if (e.frame.parentId) {
      if (e.frame.url === "about:blank") rec.childBlank += 1;
      else rec.childRoutes += 1;
    } else rec.main.push(e.frame.url);
  });
  return rec;
}

/* A SW that activates immediately but never claims and never
   intercepts: every page that loaded before activation stays
   uncontrolled forever. */
const NEVER_CLAIM_SW =
  "self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));";

async function main() {
  console.log("== Zeolite reload-count E2E (refresh-spam rule) ==");
  const errReal = [];
  const errDoctored = [];
  await startEngine(6002, resolve("app/dist"), errReal);
  /* Second instance whose static dir ships the never-claim sw.js. */
  const doctoredDir = mkdtempSync(resolve(tmpdir(), "zl-reloadcount-"));
  cpSync(resolve("app/dist"), doctoredDir, { recursive: true });
  writeFileSync(resolve(doctoredDir, "sw.js"), NEVER_CLAIM_SW);
  await startEngine(6003, doctoredDir, errDoctored);
  browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });

  await check("A1: never-claim SW -> exactly one boot reload, no loop", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rec = await navCounter(ctx, page);
    await page.goto(DOCTORED + "/?url=" + encodeURIComponent("http://example.org/"), {
      waitUntil: "domcontentloaded",
    });
    /* first load: 5s controller poll -> reload; second load: 5s
       zl:config timeout + 5s mint timeout on the unclaimed SW */
    await sleep(22000);
    eq(rec.main.length, 2, "main-frame navigations (initial + exactly one boot reload)");
    await ctx.close();
    return "navs=" + rec.main.length;
  });

  await check("A2: boot key already spent -> zero reloads, visible status", async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      try {
        sessionStorage.setItem("zl:boot-reload", "1");
      } catch { /* sandboxed: nothing to guard */ }
    });
    const page = await ctx.newPage();
    const rec = await navCounter(ctx, page);
    await page.goto(DOCTORED + "/?url=" + encodeURIComponent("http://example.org/"), {
      waitUntil: "domcontentloaded",
    });
    /* controller poll 5s -> the guard refuses the reload */
    await sleep(9000);
    eq(rec.main.length, 1, "main-frame navigations (initial only, no reload)");
    const txt = (await page.textContent("#zl-status")) ?? "";
    assert(
      txt.includes("could not take control"),
      "visible failure instead of a silent or looping blank, got: " + JSON.stringify(txt),
    );
    await ctx.close();
    return "status ok";
  });

  await check("B: dead upstream -> one navigation, zero reloads, honest error page", async () => {
    const port = await deadPort();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rec = await navCounter(ctx, page);
    await page.goto(ENGINE + "/?url=" + encodeURIComponent("http://127.0.0.1:" + port + "/"), {
      waitUntil: "domcontentloaded",
    });
    let text = "";
    for (let i = 0; i < 120 && !text.includes("Try again"); i++) {
      await sleep(250);
      for (const f of page.frames()) {
        try {
          const t = await f.evaluate(() => (document.body ? document.body.innerText : ""));
          if (t && t.length > text.length) text = t;
        } catch { /* frame mid-navigation */ }
      }
    }
    eq(rec.main.length, 1, "embed page navigations (no reload on failure)");
    eq(rec.childRoutes, 1, "frame route navigations (exactly one)");
    assert(text.includes("Try again"), "error page with manual retry rendered, got: " + JSON.stringify(text.slice(0, 120)));
    await ctx.close();
    return "dead port " + port;
  });

  await browser.close();
  rmSync(doctoredDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log("== reload-count: " + (results.length - failed.length) + "/" + results.length + " passed ==");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR failures: " + failed.length);
    if (errReal.length) console.log("engine stderr tail: " + errReal.slice(-5).join(""));
    if (errDoctored.length) console.log("doctored engine stderr tail: " + errDoctored.slice(-5).join(""));
    process.exit(1);
  }
}

let browser = null;

main().catch((e) => {
  console.log("HARNESS-ERROR " + String(e?.message ?? e));
  process.exit(1);
}).finally(() => {
  for (const p of engines) p.kill();
});
