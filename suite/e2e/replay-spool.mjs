/* #556 acceptance suite: redirect replay of large streamed request
   bodies through the OPFS spool (on by default since the #556
   follow-up; the no-spool pins below opt out explicitly via
   zl:config spoolUploads:false).

   Measured engine reality this suite pins (2026-10-31 session):

   1. Chromium never exposes Content-Length on a Service Worker
      intercepted request, so page uploads always take the
      unannounced branch and discover the replay cap mid-read.
   2. The vendored libcurl artifact full-buffers every request body
      into one ArrayBuffer inside the wasm heap before the upload;
      measured through the engine, an upload of 16 MiB kills the
      renderer process while 8 MiB rides fine. The spool removes the
      engine-side memory copies, but the artifact copy remains, so
      production-size (32 MiB) uploads cannot ride the wisp transport
      today. The artifact streaming work (curl read callback) is the
      remaining #556 item.

   What this suite proves, at transport-safe sizes:

   - the below-cap matrix (1 MiB): 301/302/303 convert to GET with
     the body dropped, 307/308 replay method and body, against the
     direct browser oracle.
   - the spool matrix at a tightened cap (zl:config replayCapMb=3,
     4 MiB uploads): the SAME five codes plus a body-preserving 301
     PUT, a cross-origin hop and an Authorization header, all
     followed through the spooled File with byte-identical SHA-256
     against the direct oracle.
   - the honest failure pin: over the tightened cap with the spool
     opted out (zl:config spoolUploads false) the request fails with
     the documented 502 diagnostic, never a truncated body and never a
     crash.
   - the production ceiling pin: a 32 MiB + 1 upload without the
     spool fails with the same honest 502 (the read loop discards
     and throws before any transport copy), pinning the documented
     limitation until the artifact streams uploads.

   Run: node suite/e2e/replay-spool.mjs (engine on 6025, fixtures on
   7125/7126 - never colliding with the other suites). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { startFixture } from "./fixtures.mjs";

const ENGINE_PORT = 6025;
const FX_A = 7125;
const FX_B = 7126;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const ORIGIN_A = "http://127.0.0.1:" + FX_A;
const ORIGIN_B = "http://127.0.0.1:" + FX_B;
const MI = 1024 * 1024;
/* one byte over the default 32 MiB replay cap */
const OVER_DEFAULT_CAP = 32 * MI + 1;
/* the tightened cap for the spool matrix and its over-cap size */
const TIGHT_CAP_MB = 3;
const OVER_TIGHT_CAP = (TIGHT_CAP_MB + 1) * MI;

const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let context = null;
let fixtureA = null;
let fixtureB = null;

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
async function frameWith(pg, sel) {
  for (const f of pg.frames()) {
    try {
      if (!f.url().startsWith(ENGINE + "/j/")) continue;
      if ((await f.locator(sel).count()) > 0) return f;
    } catch {}
  }
  return null;
}
async function openProxied(target, sel = "#zl-marker") {
  const pg = await context.newPage();
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  const frame = await waitFor("proxied frame for " + target, 45000, () => frameWith(pg, sel));
  return { page: pg, frame };
}
async function evalIn(frame, label, js, timeoutMs = 30000) {
  return await Promise.race([
    frame.evaluate("(" + js + ")()"),
    sleep(timeoutMs).then(() => {
      throw new Error(label + ": page evaluate timed out");
    }),
  ]);
}
async function startEngine() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], {
    env: {
      ...process.env,
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

/* zl:config push with an ack echo assertion: the spool authorization
   and the replay cap knob ride the same message. */
async function pushConfig(pg, fields) {
  const ack = await pg.evaluate(
    (cfg) =>
      new Promise((res, rej) => {
        const ctl = navigator.serviceWorker.controller;
        if (!ctl) return rej(new Error("no controller"));
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => {
          ch.port1.close();
          res(e.data);
        };
        ctl.postMessage({ type: "zl:config", ...cfg }, [ch.port2]);
        setTimeout(() => rej(new Error("config ack timeout")), 8000);
      }),
    fields,
  );
  assert(ack && ack.ok === true, "zl:config rejected: " + JSON.stringify(ack));
  return ack;
}

/* Page-side probe: a deterministic byte pattern of n bytes, POSTed
   (or PUT) to the redirect endpoint, resolving the followed echo
   record. The same function string runs in the direct oracle page
   and in the proxied frame. */
function probeJs(path, method, n, headers) {
  return `async () => {
    const u8 = new Uint8Array(${n});
    for (let i = 0; i < u8.length; i++) u8[i] = (i * 7 + 13) & 255;
    const r = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers ?? {})},
      body: ${JSON.stringify(method)} === "GET" ? undefined : u8,
    });
    return JSON.stringify({ status: r.status, loc: r.headers.get("location") ?? "", body: await r.text() });
  }`;
}

async function probeDirect(code, method, n, opts = {}) {
  const pg = await context.newPage();
  await pg.goto(ORIGIN_A + "/dir/landing.html");
  const path = "/api/redirbody/" + code + (opts.cross ? "?to=" + encodeURIComponent(ORIGIN_B) : "");
  const out = JSON.parse(await pg.evaluate("(" + probeJs(path, method, n, opts.headers) + ")()"));
  await pg.close();
  return out;
}

async function probeProxied(frame, code, method, n, opts = {}) {
  const path = "/api/redirbody/" + code + (opts.cross ? "?to=" + encodeURIComponent(ORIGIN_B) : "");
  return JSON.parse(await evalIn(frame, "redirbody probe " + code, probeJs(path, method, n, opts.headers), 90000));
}

function compareEcho(direct, proxied, label, expectMethod, expectBytes) {
  eq(proxied.status, 200, label + ": the redirect did not follow to the echo");
  const d = JSON.parse(direct.body);
  const p = JSON.parse(proxied.body);
  eq(p.method, d.method, label + ": echo method diverged from the direct oracle");
  eq(p.method, expectMethod, label + ": echo method is not the fetch-spec expectation");
  eq(p.bytes, d.bytes, label + ": echoed byte count diverged from the direct oracle");
  eq(p.bytes, expectBytes, label + ": echoed byte count is not the expected upload size");
  eq(p.sha256, d.sha256, label + ": SHA-256 of the replayed body diverged from the direct oracle");
  eq(p.authorization, d.authorization, label + ": Authorization diverged from the direct oracle");
  eq(p.contentType, d.contentType, label + ": content type diverged from the direct oracle");
}

async function main() {
  console.log("== Zeolite large streamed-body redirect replay suite (issue #556) ==");
  fixtureA = await startFixture(FX_A);
  fixtureB = await startFixture(FX_B);
  await startEngine();
  browser = await chromium.launch();
  context = await browser.newContext();

  const prox = await openProxied(ORIGIN_A + "/dir/page.html");

  /* ---- the honest failure pin at the tightened cap ---- */

  await check("over the tightened cap with the spool opted out: the documented honest 502, never a crash", async () => {
    /* #556 follow-up: the spool is on by default, so this pin opts out
       explicitly - upload bytes must stay out of storage when the
       deployment refuses the spool. */
    const ack = await pushConfig(prox.page, { replayCapMb: TIGHT_CAP_MB, spoolUploads: false });
    eq(ack.replayCapMb, TIGHT_CAP_MB, "the ack did not echo the tightened replay cap");
    eq(ack.spoolUploads, false, "the ack did not echo the spool opt-out");
    const out = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP);
    eq(out.status, 502, "an over-cap upload without the spool authorization did not fail honestly");
    assert(
      out.body.includes("exceeds the replay buffer cap"),
      "the honest 502 does not name the replay cap: " + out.body.slice(0, 120),
    );
    return "502 naming the cap, as documented";
  });

  /* ---- the spool matrix at the tightened cap ---- */

  await pushConfig(prox.page, { spoolUploads: true });

  await check("spool: the same over-cap 307 now follows with byte-identical replay", async () => {
    const direct = await probeDirect(307, "POST", OVER_TIGHT_CAP);
    const proxied = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP);
    compareEcho(direct, proxied, "307 over-cap POST", "POST", OVER_TIGHT_CAP);
    return "followed; SHA-256 equal to the direct oracle at " + OVER_TIGHT_CAP + " bytes";
  });

  for (const [code, expectMethod] of [[301, "GET"], [302, "GET"], [303, "GET"], [307, "POST"], [308, "POST"]]) {
    await check("spool matrix over-cap " + code + " POST: spec method and body handling match the direct oracle", async () => {
      const direct = await probeDirect(code, "POST", OVER_TIGHT_CAP);
      const proxied = await probeProxied(prox.frame, code, "POST", OVER_TIGHT_CAP);
      compareEcho(direct, proxied, code + " over-cap POST", expectMethod, expectMethod === "POST" ? OVER_TIGHT_CAP : 0);
      return "echo method " + expectMethod + ", " + (expectMethod === "POST" ? OVER_TIGHT_CAP + " bytes replayed" : "body dropped per spec");
    });
  }

  await check("spool matrix over-cap 301 PUT: a body-preserving non-POST method follows through the spool", async () => {
    const direct = await probeDirect(301, "PUT", OVER_TIGHT_CAP);
    const proxied = await probeProxied(prox.frame, 301, "PUT", OVER_TIGHT_CAP);
    compareEcho(direct, proxied, "301 over-cap PUT", "PUT", OVER_TIGHT_CAP);
    return "PUT and body preserved, SHA-256 equal";
  });

  await check("spool matrix over-cap 307 cross-origin hop: lands on the second fixture origin like the direct oracle", async () => {
    const direct = await probeDirect(307, "POST", OVER_TIGHT_CAP, { cross: true });
    const proxied = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP, { cross: true });
    compareEcho(direct, proxied, "307 over-cap cross-origin POST", "POST", OVER_TIGHT_CAP);
    return "cross-origin replay, SHA-256 equal";
  });

  await check("spool matrix over-cap 307 with Authorization: survives a same-origin replay like the direct oracle", async () => {
    const direct = await probeDirect(307, "POST", OVER_TIGHT_CAP, { headers: { authorization: "Bearer zl-tok" } });
    const proxied = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP, { headers: { authorization: "Bearer zl-tok" } });
    compareEcho(direct, proxied, "307 over-cap POST with Authorization", "POST", OVER_TIGHT_CAP);
    assert(JSON.parse(proxied.body).authorization === "Bearer zl-tok", "Authorization was lost on the replay");
    return "Authorization preserved, SHA-256 equal";
  });

  /* ---- the below-cap matrix at the default cap ---- */

  await check("below-cap matrix restored cap: the knob returns the default 32", async () => {
    const ack = await pushConfig(prox.page, { replayCapMb: 32 });
    eq(ack.replayCapMb, 32, "the ack did not echo the restored replay cap");
    return "replayCapMb restored to 32";
  });

  for (const [code, expectMethod] of [[301, "GET"], [302, "GET"], [303, "GET"], [307, "POST"], [308, "POST"]]) {
    await check("below-cap " + code + " POST: method conversion and body handling match the direct oracle", async () => {
      const n = 1 * MI;
      const direct = await probeDirect(code, "POST", n);
      const proxied = await probeProxied(prox.frame, code, "POST", n);
      compareEcho(direct, proxied, code + " below-cap POST", expectMethod, expectMethod === "POST" ? n : 0);
      return "echo method " + expectMethod + ", " + (expectMethod === "POST" ? n + " bytes replayed" : "body dropped per spec");
    });
  }

  /* ---- the production ceiling pin ---- */

  await check("production pin: a 32 MiB + 1 upload without the spool fails with the honest 502, never a crash", async () => {
    await pushConfig(prox.page, { spoolUploads: false });
    const path = "/api/echo";
    const out = JSON.parse(
      await evalIn(
        prox.frame,
        "over-default-cap echo probe",
        `async () => {
          const u8 = new Uint8Array(${OVER_DEFAULT_CAP});
          for (let i = 0; i < u8.length; i++) u8[i] = (i * 7 + 13) & 255;
          const r = await fetch("/api/echo", { method: "POST", body: u8 });
          return JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 400) });
        }`,
        120000,
      ),
    );
    eq(out.status, 502, "the production-size upload did not fail honestly");
    assert(
      out.body.includes("exceeds the replay buffer cap"),
      "the honest 502 does not name the replay cap: " + out.body.slice(0, 120),
    );
    return "pinned: the wisp transport ceiling is documented, the failure is honest";
  });

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("== replay-spool summary: " + (results.length - failed.length) + " passed, " + failed.length + " failed ==");
  console.log("== E2E-JSON == " + JSON.stringify({ suite: "replay-spool", passed: results.length - failed.length, failed: failed.length, failures: failed.map((r) => r.name) }));
  if (failed.length) {
    console.log("engine server output tail:");
    console.log(engineErr.join("").split("\n").slice(-30).join("\n"));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.log("[HARNESS-ERROR] " + (e?.stack ?? e));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      if (fixtureA) fixtureA.close();
    } catch {}
    try {
      if (fixtureB) fixtureB.close();
    } catch {}
    try {
      if (engineProc) engineProc.kill();
    } catch {}
  });
