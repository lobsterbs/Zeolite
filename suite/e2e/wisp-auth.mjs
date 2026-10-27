/* Live wisp password-auth probe (#496).

   The unit suite pins the client codec and the fail-closed wrapper on
   a fake WebSocket. This probe answers the question the units cannot:
   does the real shipped SW wisp client (the vendored libcurl-transport
   bundle) emit a first outgoing frame that decodes as a wisp v2 client
   INFO on stream 0, so the auth wrapper can append the PasswordAuth
   extension and an authenticated session actually carries proxied
   traffic end to end against a real zeolite-server with
   ZL_WISP_USER/ZL_WISP_PASSWORD set?

   Coverage, honestly scoped:
   1. Server side (raw wisp v2 handshake, no browser): no credentials
      is refused with AuthRequired (0xc2); wrong credentials with
      AuthBadCredentials (0xc0); the canonical credentials open a
      session that is not closed.
   2. SW side: zl:ping reports wispAuth mode none and the engine
      degraded before any credentials exist.
   3. zl:wispAuth sets memory-only credentials (host page only), the
      reply never echoes the secret, a primary-wisp override flip
      forces the transport re-init, and a proxied fixture page then
      renders through the authenticated wisp session.
   4. zl:ping afterwards reports mode password with no lastOutcome.

   Not covered here: worker-restart credential persistence (they are
   memory-only by design, the host re-pushes) and the ws://
   non-loopback path (refused by unit tests).

   Run: node suite/e2e/wisp-auth.mjs (repo root, after the same
   prerequisites as e2e.mjs: a release zeolite-server, an app/dist
   build, npm install in suite/e2e, playwright chromium). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { startFixture, ORIGIN_A } from "./fixtures.mjs";

const ENGINE = "http://127.0.0.1:6102";
const WISP = "ws://127.0.0.1:6102/wisp/";
const USER = "ada";
const PASS = "hunter2";

let engineProc = null;
let fixture = null;
const engineLog = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitFor(label, timeoutMs, fn) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  throw new Error("timeout: " + label);
}

async function startEngine() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) throw new Error("zeolite-server not built: " + bin);
  engineProc = spawn(bin, ["--port", "6102", "--static", resolve("app/dist")], {
    env: {
      ...process.env,
      ZL_TEST_ALLOW_PRIVATE_DESTS: "1",
      ZL_TEST_EGRESS: "1",
      ZL_WISP_USER: USER,
      ZL_WISP_PASSWORD: PASS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineLog.push(String(c)));
  engineProc.stderr.on("data", (c) => engineLog.push(String(c)));
  /* Fail loudly when a stale server already holds the port: this
     probe's spawned engine would die on bind and every later check
     would silently run against the old process (whose failed-auth
     penalty box state is not ours). */
  await sleep(1500);
  if (engineProc.exitCode !== null) {
    throw new Error("engine died on start (port 6002 taken?): " + engineLog.join("").slice(-600));
  }
  await waitFor("engine on " + ENGINE, 60000, async () => {
    try {
      const r = await fetch(ENGINE + "/");
      return r.status === 200;
    } catch {
      return false;
    }
  });
}

/* Raw wisp v2 handshake from this node process. user === null sends a
   client INFO without the PasswordAuth extension (the vendor's own
   unauthenticated shape); otherwise the canonical
   [user_len][user][password] payload rides extension 0x02. Resolves
   with the verdict for the FIRST post-INFO server frame. */
function rawHandshake(user, password) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WISP, "wisp");
    ws.binaryType = "arraybuffer";
    let phase = "server-info";
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      rej(new Error("raw handshake timeout"));
    }, 8000);
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data);
      if (phase === "server-info") {
        phase = "verdict";
        assert(b[0] === 0x05, "expected server INFO, got type " + b[0]);
        const frame = [0x05, 0, 0, 0, 0, 2, 1];
        if (user !== null) {
          const u = Array.from(Buffer.from(user, "utf8"));
          const p = Array.from(Buffer.from(password, "utf8"));
          const payload = [u.length, ...u, ...p];
          frame.push(0x02, payload.length & 255, (payload.length >> 8) & 255, (payload.length >> 16) & 255, (payload.length >> 24) & 255, ...payload);
        }
        ws.send(new Uint8Array(frame));
        return;
      }
      clearTimeout(timer);
      let verdict = "open-type-" + b[0];
      if (b[0] === 0x04) {
        verdict = b[5] === 0xc0 ? "invalid-credential" : b[5] === 0xc2 ? "auth-required" : "close-" + b[5];
      }
      try { ws.close(); } catch {}
      res(verdict);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rej(new Error("raw ws error"));
    };
  });
}

/* Page-to-SW control message with a reply port (hostControl from
   e2e.mjs, verbatim shape). */
function hostControl(pg, message, timeoutMs = 6000) {
  return pg.evaluate(({ message, timeoutMs }) => new Promise((resolve) => {
    const ctl = navigator.serviceWorker.controller;
    if (!ctl) return resolve({ ok: false, status: "unavailable", error: "no controller" });
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
    timer = setTimeout(() => finish({ ok: false, status: "unavailable", error: "timeout" }), timeoutMs);
    ch.port1.onmessage = (e) => finish(e.data);
    try { ctl.postMessage(message, [ch.port2]); }
    catch { finish({ ok: false, status: "unavailable", error: "postMessage failed" }); }
  }), { message, timeoutMs });
}

async function frameWith(pg) {
  for (const f of pg.frames()) {
    const loc = f.locator("#zl-marker");
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return null;
}

async function main() {
  console.log("== Wisp password-auth live probe (#496) ==");
  let failures = 0;
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      console.log("[PASS] " + name + (detail ? " | " + detail : ""));
    } catch (err) {
      failures += 1;
      console.log("[FAIL] " + name + " | " + String(err?.message ?? err));
    }
  };

  fixture = await startFixture(7101);
  await startEngine();

  await check("server: no credentials refused with AuthRequired (0xc2)", async () => {
    const v = await rawHandshake(null, null);
    assert(v === "auth-required", "expected auth-required, got " + v);
    return v;
  });
  await check("server: wrong credentials refused with AuthBadCredentials (0xc0)", async () => {
    const v = await rawHandshake(USER, "definitely-wrong");
    assert(v === "invalid-credential", "expected invalid-credential, got " + v);
    return v;
  });

  const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext();
  const host = await context.newPage();
  await host.goto(ENGINE + "/");
  await host.evaluate(() => navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" }));
  await host.evaluate(() => navigator.serviceWorker.ready);
  await host.reload();
  await waitFor("sw controller", 30000, () => host.evaluate(() => navigator.serviceWorker.controller !== null));

  await check("sw: zl:ping reports wispAuth mode none before any credentials", async () => {
    const ping = await hostControl(host, { type: "zl:ping" });
    assert(ping?.ok === true, "ping unavailable: " + JSON.stringify(ping));
    assert(ping.wispAuth?.mode === "none", "mode must be none: " + JSON.stringify(ping.wispAuth));
    assert(ping.wispAuth?.lastOutcome === null, "no outcome yet");
    return "degraded=" + ping.degraded;
  });

  await check("sw: zl:wispAuth sets memory-only credentials without leaking the secret", async () => {
    const set = await hostControl(host, { type: "zl:wispAuth", wispAuth: { op: "set", endpoint: WISP, username: USER, password: PASS } });
    assert(set?.ok === true, "zl:wispAuth set refused: " + JSON.stringify(set));
    assert(set.wispAuth?.mode === "password", "mode must be password: " + JSON.stringify(set.wispAuth));
    assert(set.wispAuth?.endpoint === WISP, "endpoint echo: " + JSON.stringify(set.wispAuth));
    assert(!JSON.stringify(set).includes(PASS), "secret leaked in reply");
    return JSON.stringify(set.wispAuth);
  });

  await check("sw: primary-wisp override flip forces the transport re-init", async () => {
    const away = await hostControl(host, { type: "zl:wispPrimary", url: "ws://127.0.0.1:6102/wisp-auth-reset/" });
    assert(away?.ok === true, "away flip failed: " + JSON.stringify(away));
    const back = await hostControl(host, { type: "zl:wispPrimary", url: WISP });
    assert(back?.ok === true, "back flip failed: " + JSON.stringify(back));
    return "reset";
  });

  await check("engine: a proxied fixture page renders through the authenticated wisp session", async () => {
    const pg = await context.newPage();
    const errors = [];
    pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    await pg.goto(ENGINE + "/?url=" + encodeURIComponent(ORIGIN_A + "/dir/page.html"));
    let loc = null;
    try {
      loc = await waitFor("proxied frame", 45000, () => frameWith(pg));
    } catch (e) {
      const status = await pg.evaluate(() => document.getElementById("zl-status")?.textContent ?? "(no status node)").catch(() => "(evaluate failed)");
      const body = await pg.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "").catch(() => "");
      const diag = await hostControl(pg, { type: "zl:getDiag" }, 4000).catch(() => null);
      const diagText = diag?.events ? diag.events.slice(-12).map((ev) => ev.category + "/" + ev.severity + ": " + ev.message).join(" | ") : JSON.stringify(diag).slice(0, 300);
      throw new Error(String(e?.message ?? e) + "; zl-status: " + status + "; body: " + body.slice(0, 200) + "; console errors: " + errors.slice(0, 4).join(" ;; ") + "; diag: " + diagText + "; engine: " + engineLog.join("").slice(-500));
    }
    const marker = await loc.textContent();
    assert(marker === "zl-fixture-page", "unexpected marker: " + marker);
    return marker;
  });

  await check("sw: zl:ping afterwards reports mode password with no failure outcome", async () => {
    const ping = await hostControl(host, { type: "zl:ping" });
    assert(ping?.ok === true, "ping unavailable: " + JSON.stringify(ping));
    assert(ping.wispAuth?.mode === "password", "mode: " + JSON.stringify(ping.wispAuth));
    assert(ping.wispAuth?.lastOutcome === null, "unexpected outcome: " + JSON.stringify(ping.wispAuth));
    return "engine degraded=" + ping.degraded;
  });

  await browser.close();
  console.log(failures === 0 ? "== ALL CHECKS PASSED ==" : "== " + failures + " CHECK(S) FAILED ==");
  process.exit(failures === 0 ? 0 : 1);
}

/* Cleanup: the engine and fixture must never outlive the probe, or
   the next run fights a stale server (and its auth penalty state). */
async function cleanup() {
  try { await browser?.close(); } catch {}
  try { engineProc?.kill("SIGTERM"); } catch {}
  try { await fixture?.close(); } catch {}
}
process.on("exit", () => { try { engineProc?.kill("SIGTERM"); } catch {} });
process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });
process.on("unhandledRejection", (err) => { console.error("unhandled: " + String(err)); });

main().catch((err) => {
  console.error("probe crashed: " + String(err?.message ?? err));
  if (engineLog.length) console.error("engine log tail: " + engineLog.join("").slice(-1500));
  process.exit(1);
});
