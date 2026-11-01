/* #456 gate 4 e2e: automatic location targeting, end to end. Real
   Chromium + the built engine (app/dist through zeolite-server) +
   loopback fixture origins. Validates the corroborated mark (own-404
   reports from >= 2 distinct clients AND observed location-read
   rewrites), the netlog scoreboard, the legacy -> hybrid flip made
   observable through event-attribute semantics (legacy rewrites
   onclick location reads, hybrid leaves them native), hostname-only
   scoping (a second port on the same host would share one entry, so
   the control uses a different hostname), and the zl:config kill
   switch. The own-404 watcher is injected by initScript, so the
   fixture title alone triggers zl:spa404; the fixture pages never
   carry destination data in the report (it sends none).

   Run: node suite/e2e/location-targeting.mjs  (repo root, after the
   same build steps as e2e.mjs; ZL_E2E_PORT overrides the engine port). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = Number(process.env.ZL_E2E_PORT ?? 6002);
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const CAND = "http://localhost:7141";
const CTRL = "http://127.0.0.1:7142";
const NL = String.fromCharCode(10);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(msg + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b));
}

/* The SPA-not-found shape: title/h1 match the watcher heuristic and
   the inline read + onclick attribute give the wasm location pass
   something to rewrite (the observed location-reads evidence). */
function spaPage() {
  return [
    "<!doctype html><html><head><title>Not found</title></head><body>",
    "<h1>Not Found</h1>",
    '<div id="zl-marker">zl-fixture-page</div>',
    '<div id="attr" style="width:40px;height:40px" onclick="globalThis.__attr = location.pathname"></div>',
    "<script>globalThis.__inline = location.pathname</script>", "</body></html>",
  ].join("");
}

async function startFixture(port) {
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(spaPage());
  });
  await new Promise((r2) => srv.listen(port, "127.0.0.1", r2));
  return srv;
}

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
      throw new Error("engine never came up on " + ENGINE + NL + engineErr.join("").split(NL).slice(-20).join(NL));
    await sleep(250);
  }
}

async function proxiedFrame(pg) {
  const deadline = Date.now() + 45000;
  for (;;) {
    for (const f of pg.frames()) {
      if (f === pg.mainFrame()) continue;
      try {
        if ((await f.locator("#zl-marker").count()) > 0) return f;
      } catch {}
    }
    if (Date.now() > deadline) throw new Error("proxied frame timeout on " + pg.url());
    await sleep(300);
  }
}

async function openProxied(target, ctx) {
  const pg = await ctx.newPage();
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  const frame = await proxiedFrame(pg);
  return { page: pg, frame };
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

async function attrRead(frame) {
  await frame.locator("#attr").click();
  return await frame.evaluate(() => globalThis.__attr);
}

async function main() {
  console.log("== #456 gate 4: automatic location targeting e2e ==");
  const fA = await startFixture(7141);
  const fB = await startFixture(7142);
  let browser = null;
  let context = null;
  try {
    await startEngine();
    browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
    context = await browser.newContext();
    /* The pristine default is hybrid ON (#456 operator flip
       2026-11-01); this harness pins the auto-targeting path, which
       is observable only with the global flag deselected. The bare
       engine page registers nothing (main.ts needs ?url=), so the
       harness registers the SW itself and takes the #121 one-reload
       claim path, then deselects through the host channel before
       any proxied load in this context. */
    const warm = await context.newPage();
    await warm.goto(ENGINE + "/");
    const regd = await warm.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" });
      await navigator.serviceWorker.ready;
      return true;
    });
    assert(regd === true, "warm SW registration failed");
    await warm.reload();
    const ctl = await warm.evaluate(() => navigator.serviceWorker.controller !== null);
    assert(ctl === true, "warm page not controlled after the one-reload claim");
    const flagOff = await hostControl(warm, { type: "zl:config", experimental: { hybridLocation: false } });
    assert(flagOff?.ok === true, "hybridLocation deselect refused: " + JSON.stringify(flagOff));
    await warm.close();
    /* 1st distinct client on the candidate origin: legacy semantics
       (onclick rewritten to the virtualized path) + watcher report. */
    const c1 = await openProxied(CAND + "/spa", context);
    eq(await c1.frame.evaluate(() => globalThis.__inline), "/spa", "legacy global read must be virtualized");
    eq(await attrRead(c1.frame), "/spa", "legacy event attribute must be virtualized");
    await sleep(2200);
    await c1.page.close();
    /* 2nd distinct client: corroboration threshold reached. */
    const c2 = await openProxied(CAND + "/spa", context);
    eq(await attrRead(c2.frame), "/spa", "still legacy before the mark lands");
    await sleep(2200);
    await c2.page.close();
    /* Control hostname, ONE load only: reports recorded, never marked. */
    const c3 = await openProxied(CTRL + "/spa", context);
    eq(await attrRead(c3.frame), "/spa", "control origin legacy");
    await sleep(2200);
    /* Scoreboard. */
    const netlog = await hostControl(c3.page, { type: "zl:getNetLog", since: 0 });
    assert(netlog?.ok !== false, "netlog unavailable: " + JSON.stringify(netlog));
    const lt = netlog.stats?.locationTarget;
    assert(lt && Array.isArray(lt.entries), "no locationTarget scoreboard in netlog stats");
    const cand = lt.entries.find((e) => e.origin === "localhost");
    const ctrl = lt.entries.find((e) => e.origin === "127.0.0.1");
    assert(cand, "candidate origin missing from the scoreboard");
    assert(cand.clientIds.length >= 2, "corroboration needs >=2 distinct clients");
    assert(cand.locationReads > 0, "candidate has no recorded location reads");
    assert(cand.markedAt !== null, "candidate origin never marked");
    assert(ctrl, "control origin missing from the scoreboard");
    eq(ctrl.clientIds.length, 1, "single-client control must stay uncorroborated");
    assert(ctrl.markedAt === null, "single-client control must stay unmarked");
    console.log("scoreboard: " + JSON.stringify(lt));
    /* Post-mark load: hybrid leaves the event attribute native. */
    const c4 = await openProxied(CAND + "/spa", context);
    eq(await c4.frame.evaluate(() => globalThis.__inline), "/spa", "hybrid global read must stay virtualized");
    const nativeAttr = await attrRead(c4.frame);
    assert(nativeAttr !== "/spa", "post-mark load is still legacy (attribute rewritten): " + nativeAttr);
    assert(nativeAttr.length > 0 && nativeAttr !== "", "native attribute read is empty");
    console.log("post-mark onclick read (native engine route): " + nativeAttr);
    await c4.page.close();
    /* Kill switch. */
    const cfg = await hostControl(c3.page, { type: "zl:config", locationTargeting: false });
    assert(cfg?.ok === true, "zl:config refused: " + JSON.stringify(cfg));
    eq(cfg.locationTargeting, false, "config ack must echo the kill switch");
    const c5 = await openProxied(CAND + "/spa", context);
    eq(await attrRead(c5.frame), "/spa", "kill switch must revert to legacy semantics");
    await c5.page.close();
    const reenable = await hostControl(c3.page, { type: "zl:config", locationTargeting: true });
    assert(reenable?.ok === true, "zl:config re-enable refused");
    await c3.page.close();
    console.log("PASS location targeting: corroborated mark (2 clients + reads), scoreboard, hybrid flip, control hostname, kill switch");
  } finally {
    await browser?.close();
    await new Promise((r2) => fA.close(r2));
    await new Promise((r2) => fB.close(r2));
    engineProc?.kill();
  }
}

main().catch((err) => {
  console.error("[FAIL] " + (err?.stack ?? err));
  process.exitCode = 1;
});
