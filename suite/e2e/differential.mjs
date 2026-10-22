/* Injector differential suite: the same reference pages through the
   engine in BOTH committed-route shapes - queryRoutes off (the NAVH
   path form) and on (the query shape) - asserting that page-observed
   behavior is IDENTICAL across modes, that the committed URL shape
   differs exactly as designed, that a NATIVE (unrenamed) location
   pathname read sees the real destination path only in the query
   shape (the LegacyUnforgeable constraint: no shim can fix pathname
   reads, only the committed-URL shape can), and that neither shape
   leaks a destination or answers an engine error page.

   Reference case: the #236 pathname-routed SPA fixture (the modeled
   Brave Ask class - an inline router matching location.pathname), so
   history virtualization, the decode seams and the deep-link
   recovery are all exercised in both shapes. The #180 anchor read
   virtualization is asserted in both shapes too. A fresh-page load
   of the pushed route (no settled page context) is the URL-bar /
   deep-link escape check, the e293ecc5 seam class.

   Differential fallout: a CDP recorder watches every mode's
   requests - zero browser-direct fixture requests and zero 5xx
   responses are the cross-mode invariants, and the fixture wire log
   must show no engine-origin referer (the #34 escape oracle).

   Conventions mirror e2e.mjs: zeolite-server on 127.0.0.1:6002 with
   the two-key test-only SSRF hatch (#213), the fixture origin on
   7101, run from the repo root after `cargo build -p zeolite-server
   --release`, an app/dist build (with the wasm artifacts and the
   vendored transports), `npm install` in suite/e2e and
   `npx playwright install chromium`. ZL_STATIC overrides the served
   bundle directory for local runs. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { startFixture, ORIGIN_A } from "./fixtures.mjs";

const ENGINE = "http://127.0.0.1:6002";
const STATIC = process.env.ZL_STATIC ?? resolve("app/dist");
const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let fixtureA = null;

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

/* CDP recorder, the e2e.mjs #35 shape: fromServiceWorker + status on
   every request, so the fallout check sees browser-direct escapes
   and 5xx answers without touching page JavaScript. */
function attachRecorder(ctx, pg) {
  const rec = { requests: [] };
  (async () => {
    const cdp = await ctx.newCDPSession(pg);
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (p) => {
      rec.requests.push({ id: p.requestId, url: p.request.url, fromSW: undefined, failed: false, status: 0 });
    });
    cdp.on("Network.responseReceived", (p) => {
      const e = rec.requests.find((r) => r.id === p.requestId);
      if (e) {
        e.fromSW = p.response.fromServiceWorker === true;
        e.status = p.response.status;
      }
    });
    cdp.on("Network.loadingFailed", (p) => {
      const e = rec.requests.find((r) => r.id === p.requestId);
      if (e) e.failed = true;
    });
  })().catch((e) => console.log("[WARN] CDP attach failed: " + e));
  return rec;
}

async function startEngine() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  engineProc = spawn(bin, ["--port", "6002", "--static", STATIC], {
    env: {
      ...process.env,
      /* Test-only SSRF hatch: the engine may reach the loopback
         fixture origins. Same two-key escape the compat job uses
         (#213: one variable alone must never disable the policy). */
      ZL_TEST_ALLOW_PRIVATE_DESTS: "1",
      ZL_TEST_EGRESS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await waitFor("engine on " + ENGINE, 60000, async () => {
    try {
      const r = await fetch(ENGINE + "/sw.js");
      return r.status === 200;
    } catch {
      return false;
    }
  });
}

/* Control-plane round trip from a host page at the engine root: the
   same MessageChannel postMessage the LB UI and games-play use. */
function send(pg, msg, timeoutMs = 10000) {
  return pg.evaluate(([m, t]) => new Promise((res) => {
    const ch = new MessageChannel();
    const c = navigator.serviceWorker.controller;
    if (!c) return res({ ok: false, error: "no controller" });
    ch.port1.onmessage = (e) => res(e.data);
    c.postMessage(m, [ch.port2]);
    setTimeout(() => res({ ok: false, error: "timeout" }), t);
  }), [msg, timeoutMs]);
}

/* A controlled host page at the engine root. The engine's own index
   registers the worker; the explicit module registration is the
   idempotent fallback (a half-loaded index would otherwise burn the
   whole controller timeout - the first browser-run lesson in
   e2e.mjs). */
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

/* One mode pass: a fresh context (its own SW registration, its own
   route key in its own storage), the config flip, then every
   differential check inside it. Checks after a failed mode-echo are
   skipped: they all burn a 45s timeout on the same broken
   registration and say nothing new. */
async function runMode(mode) {
  const label = mode ? "on" : "off";
  const ctx = await browser.newContext();
  const recs = [];
  const rec = (pg) => {
    const r = attachRecorder(ctx, pg);
    recs.push(r);
    return r;
  };
  let spaHandle = null;
  let pushedUrl = null;

  await check(label + ": zl:config flips the query-shape opt-in and zl:ping echoes it", async () => {
    const host = await controlledHost(ctx);
    const cfg = await send(host, { type: "zl:config", queryRoutes: mode });
    assert(cfg && cfg.ok === true, "config refused: " + JSON.stringify(cfg));
    eq(cfg.queryRoutes, mode, "config ack echo");
    const ping = await send(host, { type: "zl:ping" });
    eq(ping.queryRoutes, mode, "ping echo");
    await host.close();
    return "queryRoutes " + ping.queryRoutes + ", prefix " + ping.prefix + ", scheme " + ping.scheme;
  });

  if (results[results.length - 1].ok !== true) {
    console.log("[HARNESS] mode " + label + " echo failed; skipping the remaining " + label + " checks.");
    await ctx.close();
    return;
  }

  await check(label + ": zl:navHandle mints the " + (mode ? "query" : "path") + "-shape handle", async () => {
    const host = await controlledHost(ctx);
    const h = await send(host, { type: "zl:navHandle", dest: ORIGIN_A + "/spa/home" });
    assert(h && h.ok === true, "mint refused: " + JSON.stringify(h));
    assert(typeof h.url === "string" && h.url.length > 0, "no handle url: " + JSON.stringify(h));
    spaHandle = h.url;
    if (mode) {
      const u = new URL(ENGINE + h.url);
      eq(u.pathname, "/spa/home", "committed pathname is not the real path: " + h.url);
      assert(u.searchParams.get("zlNavh"), "zlNavh token missing: " + h.url);
      assert(!String(h.url).includes("/__zl_navh__/"), "path-form handle in query mode: " + h.url);
    } else {
      assert(String(h.url).startsWith("/__zl_navh__/"), "handle route shape: " + h.url);
      assert(String(h.url).endsWith("/spa/home"), "visible path suffix missing: " + h.url);
      assert(!String(h.url).includes("zlNavh="), "query token in path mode: " + h.url);
    }
    assert(!JSON.stringify(h).includes("7101"), "handle reply leaks the destination: " + JSON.stringify(h));
    await host.close();
    return String(h.url).slice(0, 64);
  });

  await check(label + ": the SPA router reads the same route in both shapes (native fidelity)", async () => {
    const pg = await ctx.newPage();
    rec(pg);
    await pg.goto(ENGINE + spaHandle, { waitUntil: "commit", timeout: 60000 });
    const route = await waitFor("spa route", 45000, () =>
      pg.locator("#zl-spa-route").textContent().then((x) => (x === "/spa/home" ? x : null)),
    );
    eq(route, "/spa/home", "router matched the virtual path");
    /* Native (unrenamed) pathname read: window["location"] defeats
       the #235 identifier rename, so this is what unshimmed page
       code and third-party scripts actually see. THE differential:
       opaque in the path form, the real path in the query form. */
    const natPath = await pg.evaluate(() => window["location"].pathname);
    if (mode) {
      eq(natPath, "/spa/home", "native pathname read is not the real path: " + natPath);
    } else {
      assert(String(natPath).startsWith("/__zl_navh__/"), "native pathname is not the opaque route: " + natPath);
    }
    const committed = new URL(pg.url());
    if (mode) {
      eq(committed.pathname, "/spa/home", "committed pathname after navigation");
      assert(committed.searchParams.has("zlNavh"), "token missing from the committed query");
    } else {
      assert(committed.pathname.startsWith("/__zl_navh__/"), "committed route after navigation: " + pg.url());
    }
    return "route " + route + "; native pathname " + (mode ? "= real path" : "opaque");
  });

  await check(label + ": pushState re-anchors in the live shape and the router keeps the virtual path", async () => {
    const pg = await ctx.newPage();
    rec(pg);
    await pg.goto(ENGINE + spaHandle, { waitUntil: "commit", timeout: 60000 });
    await waitFor("spa route", 45000, () =>
      pg.locator("#zl-spa-route").textContent().then((x) => (x === "/spa/home" ? x : null)),
    );
    await pg.locator("#zl-spa-go").click();
    const route = await waitFor("spa route swap", 15000, () =>
      pg.locator("#zl-spa-route").textContent().then((x) => (x === "/spa/about?q=1" ? x : null)),
    );
    pushedUrl = pg.url();
    const u = new URL(pushedUrl);
    const natPath = await pg.evaluate(() => window["location"].pathname);
    if (mode) {
      eq(u.pathname, "/spa/about", "committed pathname after pushState: " + pushedUrl);
      eq(u.searchParams.get("q"), "1", "the real query survives the re-commit");
      assert(u.searchParams.has("zlNavh"), "token missing from the re-committed query: " + pushedUrl);
      eq(natPath, "/spa/about", "native pathname after pushState: " + natPath);
    } else {
      assert(u.pathname.startsWith("/__zl_navh__/"), "re-anchor left the handle route: " + pushedUrl);
      assert(pushedUrl.includes("/__zl_prel__/"), "pushState did not re-anchor: " + pushedUrl);
      assert(String(natPath).startsWith("/__zl_navh__/"), "native pathname after pushState: " + natPath);
    }
    /* the eval counter proves the same document routed in-app: a
       fallback document reload would reset it to 1 */
    const n = await pg.evaluate(() => window.__zlSpaN);
    eq(n, 1, "the document reloaded instead of routing in-app");
    return route + (mode ? " @ " + u.pathname + u.search.slice(0, 20) + "..." : " @ prel re-anchor");
  });

  await check(label + ": a fresh-page load of the pushed route restores the SPA state (deep link / URL-bar class)", async () => {
    assert(typeof pushedUrl === "string", "no pushed URL recorded (the pushState check failed)");
    const pg = await ctx.newPage();
    rec(pg);
    await pg.goto(pushedUrl, { waitUntil: "commit", timeout: 60000 });
    const route = await waitFor("restored route", 45000, () =>
      pg.locator("#zl-spa-route").textContent().then((x) => (x === "/spa/about?q=1" ? x : null)),
    );
    eq(route, "/spa/about?q=1", "deep link restored the SPA state");
    const after = new URL(pg.url());
    if (mode) {
      eq(after.pathname, "/spa/about", "committed pathname after the deep link");
      assert(after.searchParams.has("zlNavh"), "token missing after the deep link");
    } else {
      assert(after.pathname.startsWith("/__zl_navh__/"), "deep link left the handle route: " + pg.url());
    }
    return "restored at " + after.pathname.slice(0, 40);
  });

  await check(label + ": anchor reads stay virtual while the raw attribute keeps the route (#180, both shapes)", async () => {
    const host = await controlledHost(ctx);
    const h = await send(host, { type: "zl:navHandle", dest: ORIGIN_A + "/dir/page.html" });
    await host.close();
    assert(h && h.ok === true, "mint refused: " + JSON.stringify(h));
    const pg = await ctx.newPage();
    rec(pg);
    await pg.goto(ENGINE + h.url, { waitUntil: "commit", timeout: 60000 });
    await waitFor("page marker", 45000, () =>
      pg.locator("#zl-marker").textContent().then((x) => (x === "zl-fixture-page" ? x : null)),
    );
    /* the anchor scan debounces 200ms and decodes in bounded batches;
       6 anchors on this page, so a couple of seconds covers it */
    const out = await waitFor("anchor decode", 20000, () =>
      pg.evaluate(() => {
        const a = document.getElementById("rel");
        return { virt: a.href, raw: a.attributes.getNamedItem("href").value };
      }).then((o) => (o.virt && !o.virt.startsWith("http://127.0.0.1:6002") ? o : null)),
    );
    eq(out.virt, ORIGIN_A + "/dir/landing.html", "virtual anchor read");
    assert(String(out.raw).startsWith(ENGINE), "raw attribute is not an engine route: " + out.raw);
    assert(!String(out.raw).includes("7101"), "raw route leaks the destination: " + out.raw);
    return "virt " + out.virt;
  });

  await check(label + ": no browser-direct fixture request and no 5xx in this shape (fallout)", async () => {
    const fx = [];
    for (const r of recs) for (const q of r.requests) if (q.url.includes(":7101")) fx.push(q);
    const direct = fx.filter((q) => q.fromSW === false || (q.failed && q.status === 0));
    assert(direct.length === 0, "browser-direct fixture requests: " + JSON.stringify(direct.slice(0, 4)));
    const errs = [];
    for (const r of recs) for (const q of r.requests) if (q.status >= 500) errs.push(q.url.slice(0, 80) + " " + q.status);
    assert(errs.length === 0, "5xx responses in mode " + label + ": " + JSON.stringify(errs.slice(0, 6)));
    return fx.length + " fixture-URL entries observed, none browser-direct; 0 5xx";
  });

  await ctx.close();
}

async function main() {
  console.log("== Injector differential suite (queryRoutes off vs on) ==");
  fixtureA = await startFixture(7101);
  await startEngine();
  browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });

  await runMode(false);
  await runMode(true);

  /* Cross-mode wire oracle (#34): the fixture's own hit log must show
     no engine-origin referer in EITHER shape - a route-shape change
     must not open an escape. */
  await check("cross-mode: the fixture wire log shows no browser-direct hits in either shape (#34)", async () => {
    const hits = await (await fetch(fixtureA.origin + "/__hits")).json();
    const bad = hits.filter((h) => (h.referer ?? "").includes("127.0.0.1:6002") || (h.referer ?? "").includes("/j/"));
    assert(bad.length === 0, "browser-direct fixture hits (engine-origin referer): " + JSON.stringify(bad.slice(0, 4)));
    return hits.length + " fixture hits, all engine-referered or refererless";
  });

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("== differential summary: " + (results.length - failed.length) + " passed, " + failed.length + " failed ==");
  for (const f of failed) console.log("   [FAIL] " + f.name + ": " + f.error);
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
      fixtureA?.stop();
    } catch {}
    try {
      engineProc?.kill("SIGKILL");
    } catch {}
  });
