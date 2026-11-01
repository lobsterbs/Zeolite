/* #456 phase 2: live-corpus measurement of the automatic location
   targeting heuristic, plus live validation of the shipped
   play2048.co rule on the current build. Report-only by design:
   external sites must never gate CI, so every site-level failure is
   recorded as an honest verdict and the probe exits zero. Only the
   engine or the scoreboard plumbing itself gates (structural).

   Output: per-site verdict lines, a "scoreboard:" JSON line, and
   suite/location-targeting.json as the run measurement artifact.

   Run: node suite/e2e/location-targeting-live.mjs  (repo root, after
   the same build steps as e2e.mjs; ZL_E2E_PORT overrides the port). */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = Number(process.env.ZL_E2E_PORT ?? 6002);
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const NL2 = String.fromCharCode(10);
/* Same heuristic the injected own-404 watcher uses. */
const O404 = /\b404\b|\bnot found\b/i;

/* Corpus: play2048.co carries the shipped KDL hybrid rule; the
   GitHub Pages mirror and one deep route per site exercise the
   auto-mark heuristic on pages we do not control. Two loads per
   site give the corroborated mark its two distinct clients. */
const CORPUS = [
  { label: "play2048 root (shipped rule)", url: "https://play2048.co/", loads: 2 },
  { label: "play2048 deep route", url: "https://play2048.co/zeolite-456-deep-route", loads: 2 },
  { label: "2048 github pages mirror", url: "https://gabrielecirulli.github.io/2048/", loads: 2 },
  { label: "2048 mirror deep route", url: "https://gabrielecirulli.github.io/2048/zeolite-456-deep-route", loads: 2 },
];

let engineProc = null;
const engineErr = [];
async function startEngine() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin))
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], {
    env: {
      ...process.env,
      /* Test-only SSRF hatch, same two-key escape as e2e.mjs. */
      ZL_TEST_ALLOW_PRIVATE_DESTS: "1",
      ZL_TEST_EGRESS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const r = await fetch(ENGINE + "/");
      if (r.status === 200) break;
    } catch {}
    if (Date.now() > deadline)
      throw new Error("engine never came up on " + ENGINE + NL2 + engineErr.join("").split(NL2).slice(-20).join(NL2));
    await sleep(250);
  }
}

/* Real pages carry no fixture marker, so identify the proxied frame
   by its engine route (ENGINE/j/<token>). */
async function proxiedFrame(pg) {
  const deadline = Date.now() + 45000;
  for (;;) {
    for (const f of pg.frames()) {
      if (f === pg.mainFrame()) continue;
      if (f.url().startsWith(ENGINE + "/j/")) return f;
    }
    if (Date.now() > deadline) throw new Error("proxied frame timeout on " + pg.url());
    await sleep(300);
  }
}

async function hostControl(pg, message, timeoutMs = 6000) {
  return await pg.evaluate(({ message, timeoutMs }) => new Promise((resolve) => {
    const ctl = navigator.serviceWorker.controller;
    if (!ctl) return resolve({ ok: false, error: "no controller" });
    const ch = new MessageChannel();
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ch.port1.onmessage = null;
      ch.port1.close();
      ch.port2.close();
      resolve(value);
    };
    timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    ch.port1.onmessage = (e) => finish(e.data);
    try { ctl.postMessage(message, [ch.port2]); }
    catch { finish({ ok: false, error: "postMessage failed" }); }
  }), { message, timeoutMs });
}

async function main() {
  console.log("== #456 phase 2: live-corpus location targeting measurement ==");
  let browser = null;
  try {
    await startEngine();
    browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
    const context = await browser.newContext();
    const results = [];
    const openPages = [];
    let scoreboardPage = null;
    for (const site of CORPUS) {
      const rec = { label: site.label, url: site.url, verdict: "unreachable", title: null, own404: null };
      try {
        for (let i = 0; i < site.loads; i++) {
          const pg = await context.newPage();
          openPages.push(pg);
          await pg.goto(ENGINE + "/?url=" + encodeURIComponent(site.url), { timeout: 45000 });
          const frame = await proxiedFrame(pg);
          /* Both watcher windows (800 ms / 2500 ms) must pass. */
          await sleep(2800);
          if (i === site.loads - 1) {
            rec.verdict = "rendered";
            rec.title = await frame.title().catch(() => null);
            rec.own404 = rec.title != null && O404.test(rec.title);
            scoreboardPage = pg;
          }
        }
      } catch (err) {
        rec.verdict = "unreachable";
        rec.error = String((err && err.message) || err).slice(0, 200);
      }
      results.push(rec);
      console.log(rec.label + ": " + rec.verdict + (rec.title != null ? " | title: " + JSON.stringify(rec.title) : "") + (rec.error ? " | " + rec.error : ""));
    }
    let scoreboard = null;
    let ping = null;
    if (scoreboardPage) {
      const nl = await hostControl(scoreboardPage, { type: "zl:getNetLog", since: 0 });
      if (!nl || nl.ok === false) {
        /* The host-control roundtrip itself failed (timeout, no
           controller, postMessage rejection). That is the same
           environmental class as an unreachable site - the runner
           just spent up to three 45s goto timeouts and the page's
           bridge can be equally starved - so record it honestly and
           keep the probe report-only. A well-formed netlog answer
           that lacks the locationTarget scoreboard is the structural
           case and still gates below. */
        console.log("scoreboard not collected: host control roundtrip failed (" +
          ((nl && nl.error) || "no answer") + ") - environmental, non-gating");
      } else {
        const lt = nl.stats && nl.stats.locationTarget;
        if (!lt || !Array.isArray(lt.entries))
          throw new Error("locationTarget scoreboard missing from netlog stats: " + JSON.stringify(nl).slice(0, 300));
        scoreboard = lt;
        const byOrigin = new Map(lt.entries.map((e) => [e.origin, e]));
        for (const rec of results) {
          const host = new URL(rec.url).hostname;
          const e = byOrigin.get(host);
          rec.scoreboard = e ? {
            reports: e.reports,
            clientIds: e.clientIds.length,
            locationReads: e.locationReads,
            markedAt: e.markedAt,
          } : null;
        }
        const p = await hostControl(scoreboardPage, { type: "zl:ping" });
        ping = p ? { version: p.version, locationTargeting: p.locationTargeting } : null;
        console.log("scoreboard: " + JSON.stringify(lt));
      }
    } else {
      console.log("no site rendered; scoreboard not collected (egress-blocked environment?)");
    }
    const report = { ranAt: new Date().toISOString(), ping, corpus: results, scoreboard };
    writeFileSync(resolve("suite/location-targeting.json"), JSON.stringify(report, null, 2) + NL2);
    console.log("measurement written: suite/location-targeting.json");
    console.log("PASS live measurement completed (report-only; see verdicts above)");
  } finally {
    await browser?.close();
    engineProc?.kill();
  }
}

main().catch((err) => {
  console.error("[FAIL] " + ((err && err.stack) || err));
  process.exitCode = 1;
});
