/* Real-Chromium E2E harness (issue #35). The transport-level compat
   suite cannot see browser-runtime behavior; this harness launches a
   controlled Chromium, registers the built engine (app/dist through
   zeolite-server), loads deterministic fixture origins through it,
   runs page JavaScript and asserts routing, browser APIs, rewriter
   seams, and the #32/#34 privacy properties.

   How a browser-direct escape is distinguished from an engine request
   (issue #35 acceptance):
   1. Canary: fixture /api/data sends no CORS headers. A browser-direct
      cross-origin fetch from the engine page is unreadable (CORS
      error); an engine-served response is (applyEngineCors stamps the
      engine's facts). Reading the body is proof of routing.
   2. Wire log: the engine re-stamps Referer from the real destination,
      so any fixture hit whose Referer mentions the engine origin or a
      /j/ route was sent browser-direct.
   3. CDP: the network capture must show no fixture-origin request that
      was served with fromServiceWorker !== true, or that failed with
      no response at all. A request whose SW-served stream the page
      aborted afterwards (EventSource close) reports loadingFailed WITH
      its 200: the response did come from the engine, so it is not an
      escape. The gate fails only on positive evidence.

   Honest gaps (documented, not faked): WebSocket targets are skipped
      (the engine upgrades ws to wss by design; the local fixture is
      plain HTTP, so the bridge cannot be exercised against loopback
      without a TLS fixture) and the SW-restart group is not covered -
      see suite/e2e/README.md. The #36 rewriter constructs have
      real-Chromium checks below (meta refresh, iframe srcdoc, base
      href, srcset data URL candidates); SVG paint url() attributes
      are covered by the rewriter's Rust unit tests instead (a
      computed-style check would only observe the unresolvable-
      reference fallback, not the rewrite itself).

   Run: node suite/e2e/e2e.mjs   (from the repo root, after
   `cargo build -p zeolite-server --release`, an app/dist build with
   the wasm artifacts, `npm install` in suite/e2e, and
   `npx playwright install chromium`). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { startFixture, ORIGIN_A, ORIGIN_B } from "./fixtures.mjs";

const ENGINE = "http://127.0.0.1:6002";
const results = [];
const recorders = [];
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

/* CDP recorder: fails only on positive evidence of a browser-direct
   fixture request (a response NOT served by the service worker, or a
   failure that never received any response - status 0). An SW-served
   stream the page later aborts (es.close()) reports loadingFailed
   alongside its 200: served by the engine, not an escape (#34). */
function attachRecorder(pg) {
  const rec = { requests: [] };
  (async () => {
    const cdp = await context.newCDPSession(pg);
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
  recorders.push(rec);
  return rec;
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

async function openProxied(target) {
  const pg = await context.newPage();
  const rec = attachRecorder(pg);
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  let frame = null;
  try {
    frame = await waitFor("proxied frame for " + target, 45000, () => frameWith(pg, "#zl-marker"));
  } catch (e) {
    const status = await pg
      .evaluate(() => document.getElementById("zl-status")?.textContent ?? "(no status node)")
      .catch(() => "(page evaluate failed)");
    /* Registration probe: when the embed fails, say which registration
       forms the running Chromium accepts. The first browser run of
       this suite (30 Sep 2026) failed everything on one line: the SW
       bundle is an ES module and the embedder registered it as a
       classic script, so evaluation died and every later check timed
       out on a frame that could never exist. */
    const probe = await pg
      .evaluate(async () => {
        const out = {};
        try {
          await navigator.serviceWorker.register("/sw.js", { scope: "/" });
          out.classic = "registered";
        } catch (err) {
          out.classic = String(err?.message ?? err);
        }
        try {
          await navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" });
          out.module = "registered";
        } catch (err) {
          out.module = String(err?.message ?? err);
        }
        return out;
      })
      .catch(() => "(probe failed)");
    throw new Error(
      e.message + "; embedder status: " + status + "; registration probe: " + JSON.stringify(probe) + "; url: " + pg.url(),
    );
  }
  return { page: pg, frame, rec };
}

async function evalIn(frame, label, js, timeoutMs = 15000) {
  /* Playwright treats a string argument to evaluate() as an
     EXPRESSION, never as a function to invoke: the first browser run
     had every page probe "passing" evaluate with undefined because the
     function strings were evaluated to function values and dropped.
     Wrapping in "(" + js + ")()" makes the expression invoke the
     function and return its result. */
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
  engineProc = spawn(bin, ["--port", "6002", "--static", resolve("app/dist")], {
    env: {
      ...process.env,
      /* Test-only SSRF hatch: the engine may reach the loopback
         fixture origins. Same escape the compat job uses. */
      ZL_TEST_ALLOW_PRIVATE_DESTS: "1",
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
  await waitFor("sw.js served", 20000, async () => {
    try {
      const r = await fetch(ENGINE + "/sw.js");
      return r.status === 200;
    } catch {
      return false;
    }
  });
}

async function fixtureHits(fx, path) {
  const hits = await (await fetch(fx.origin + "/__hits")).json();
  return path ? hits.filter((h) => h.path === path) : hits;
}

async function main() {
  console.log("== Zeolite browser E2E (issue #35) ==");
  fixtureA = await startFixture(7101);
  fixtureB = await startFixture(7102);
  await startEngine();

  await check("engine serves the built bundle (index + sw.js)", async () => {
    const sw = await fetch(ENGINE + "/sw.js");
    eq(sw.status, 200, "sw.js status");
    const ix = await fetch(ENGINE + "/?url=x");
    eq(ix.status, 200, "index status");
    return "ok";
  });

  browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
  context = await browser.newContext();

  /* ---- embed + routing ------------------------------------------- */

  await check("embed: the SW controls the engine page and the target renders proxied", async () => {
    const { page, frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    eq(await frame.locator("#zl-marker").textContent(), "zl-fixture-page", "marker");
    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    assert(controlled, "no SW controller on the engine page");
    assert(page.url().startsWith(ENGINE), "embed URL");
    return "frame " + frame.url().slice(0, 44);
  });

  /* Fail fast: every later check opens the same proxied frame, so a
     broken embed would just burn its 45s timeout twenty-seven more
     times and the log would say nothing new. */
  if (results[results.length - 1].ok !== true) {
    console.log("");
    console.log("[HARNESS] embed failed; skipping the remaining checks (all of them need a proxied frame).");
    console.log("engine server output tail:");
    console.log(engineErr.join("").split("\n").slice(-30).join("\n"));
    process.exitCode = 1;
    return;
  }

  await check("routing: an absolute cross-origin link navigates through the engine", async () => {
    const { page } = await openProxied(ORIGIN_A + "/dir/page.html");
    await (await waitFor("frame", 10000, () => frameWith(page, "#zl-marker"))).locator("#abs").click();
    const landing = await waitFor("landing frame", 30000, () => frameWith(page, "#zl-landing"));
    assert(landing.url().startsWith(ENGINE + "/j/"), "landing frame URL is not an engine route: " + landing.url());
    eq(await landing.locator("#zl-landing").textContent(), "zl-landing", "landing marker");
    return landing.url().slice(0, 44);
  });

  await check("routing: a relative link resolves against the virtual target", async () => {
    const { page } = await openProxied(ORIGIN_A + "/dir/page.html");
    await (await waitFor("frame", 10000, () => frameWith(page, "#zl-marker"))).locator("#rel").click();
    const landing = await waitFor("landing frame", 30000, () => frameWith(page, "#zl-landing"));
    assert(landing.url().startsWith(ENGINE + "/j/"), "landing frame URL is not an engine route: " + landing.url());
    return landing.url().slice(0, 44);
  });

  await check("routing: a 302 redirect is followed engine-side", async () => {
    const { page } = await openProxied(ORIGIN_A + "/dir/page.html");
    await (await waitFor("frame", 10000, () => frameWith(page, "#zl-marker"))).locator("#redir").click();
    const landing = await waitFor("landing frame", 30000, () => frameWith(page, "#zl-landing"));
    assert(landing.url().startsWith(ENGINE + "/j/"), "post-redirect URL is not an engine route: " + landing.url());
    return landing.url().slice(0, 44);
  });

  await check("routing: SPA pushState stays engine-origin and API fetches reroute to the fixture", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "pushState", `async () => {
      history.pushState(null, "", "/spa-here");
      const r = await fetch("/api/data");
      const j = await r.json();
      return { href: location.href, status: r.status, zl: j.zl };
    }`);
    assert(out.href === ENGINE + "/spa-here", "SPA URL is not engine-origin: " + out.href);
    eq(out.zl, "api", "rerouted fetch body");
    return out.href;
  });

  await check("routing: reload keeps the page proxied", async () => {
    const { page } = await openProxied(ORIGIN_A + "/dir/page.html");
    await page.reload();
    const frame = await waitFor("frame after reload", 45000, () => frameWith(page, "#zl-marker"));
    eq(await frame.locator("#zl-marker").textContent(), "zl-fixture-page", "marker after reload");
    return frame.url().slice(0, 44);
  });

  /* ---- browser APIs ---------------------------------------------- */

  await check("api: same-origin (engine-path) fetch is rerouted to the fixture", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const zl = await evalIn(frame, "fetch reroute", `async () => {
      const r = await fetch("/api/data");
      return (await r.json()).zl;
    }`);
    eq(zl, "api", "rerouted fetch body");
    return "ok";
  });

  await check("privacy/api: cross-origin fetch to the no-CORS fixture is engine-served (#34 canary)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "cross fetch", `async () => {
      try {
        const r = await fetch("${ORIGIN_B}/api/data");
        return "http " + r.status + " " + (await r.text());
      } catch (e) { return "CORS-ERROR " + e; }
    }`);
    assert(out.includes('"api"'), "cross-origin fetch was not engine-served (browser-direct = unreadable CORS error): " + out);
    return out;
  });

  await check("api: cross-origin XHR to the no-CORS fixture is engine-served", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "xhr", `() => new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open("GET", "${ORIGIN_B}/api/data");
      x.onload = () => resolve("ok " + x.responseText);
      x.onerror = () => resolve("XHR-ERROR");
      x.send();
    })`);
    assert(out.includes('"api"'), "XHR was not engine-served: " + out);
    return out;
  });

  await check("api: EventSource (same virtual origin) receives streamed events", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "eventsource", `() => new Promise((resolve) => {
      const es = new EventSource("/sse");
      es.onmessage = (e) => { es.close(); resolve(e.data); };
      es.onerror = () => { es.close(); resolve("ES-ERROR"); };
      setTimeout(() => { es.close(); resolve("ES-TIMEOUT"); }, 12000);
    })`);
    eq(out, "zl-sse-1", "EventSource first event");
    return out;
  });

  await check("api: cross-origin EventSource to the no-CORS fixture is engine-served", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "eventsource cross", `() => new Promise((resolve) => {
      const es = new EventSource("${ORIGIN_B}/sse");
      es.onmessage = (e) => { es.close(); resolve(e.data); };
      es.onerror = () => { es.close(); resolve("ES-ERROR"); };
      setTimeout(() => { es.close(); resolve("ES-TIMEOUT"); }, 12000);
    })`);
    eq(out, "zl-sse-1", "cross-origin EventSource first event (browser-direct would be a CORS error)");
    return out;
  });

  await check("api: sendBeacon (engine path + cross-origin) both accepted", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "beacon", `() => {
      const a = navigator.sendBeacon("/beacon", "zl-beacon-local");
      const b = navigator.sendBeacon("${ORIGIN_B}/beacon", "zl-beacon-cross");
      return a + "/" + b;
    }`);
    eq(out, "true/true", "sendBeacon results");
    return out;
  });

  await check("privacy/api: the cross-origin beacon landed engine-forwarded (wire referer)", async () => {
    await sleep(800);
    const bh = await fixtureHits(fixtureB, "/beacon");
    assert(bh.length >= 1, "no /beacon hit recorded at fixture B");
    assert(bh.some((h) => h.body === "zl-beacon-cross"), "cross beacon body missing at the fixture");
    const direct = bh.filter((h) => (h.referer ?? "").includes("127.0.0.1:6002") || (h.referer ?? "").includes("/j/"));
    assert(direct.length === 0, "browser-direct beacon detected (engine-origin referer): " + JSON.stringify(direct));
    return "beacon referer: " + (bh[0].referer ?? "(none)");
  });

  await check("api: a classic worker is served with the prelude (importScripts + fetch routed)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "worker", `() => new Promise((resolve) => {
      const w = new Worker("/dir/worker.js");
      const msgs = [];
      w.onmessage = (e) => {
        msgs.push(e.data && e.data.type ? e.data.value : e.data);
        if (msgs.length >= 2) { w.terminate(); resolve(msgs.join(",")); }
      };
      w.onerror = (e) => { w.terminate(); resolve("WORKER-ERROR " + (e.message ?? "")); };
      setTimeout(() => { w.terminate(); resolve("WORKER-TIMEOUT " + msgs.join(",")); }, 15000);
    })`, 25000);
    eq(out, "wlib-ok,api", "worker messages");
    return out;
  });

  await check("api: a shared worker relays through the page-side relay", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "sharedworker", `() => new Promise((resolve) => {
      const sw = new SharedWorker("/dir/shared.js");
      const p = sw.port;
      p.onmessage = (e) => resolve("shared:" + e.data);
      p.start();
      setTimeout(() => resolve("SHARED-TIMEOUT"), 12000);
    })`, 20000);
    eq(out, "shared:shared-ok", "shared worker message");
    return out;
  });

  await check("api: localStorage/sessionStorage round-trip inside the virtual origin", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "storage", `async () => {
      localStorage.setItem("zlE2e", "local");
      sessionStorage.setItem("zlE2e", "session");
      return localStorage.getItem("zlE2e") + "/" + sessionStorage.getItem("zlE2e");
    }`);
    eq(out, "local/session", "storage round-trip");
    return out;
  });

  await check("api: document.cookie is jar-backed", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "cookie", `async () => {
      document.cookie = "zl_e2e=jar; path=/";
      await new Promise((r) => setTimeout(r, 500));
      return document.cookie;
    }`);
    assert(out.includes("zl_e2e=jar"), "cookie not visible: " + out);
    return out;
  });

  await check("api: upstream Set-Cookie is captured into the jar", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "setcookie", `async () => {
      await fetch("/setcookie");
      await new Promise((r) => setTimeout(r, 500));
      return document.cookie;
    }`);
    assert(out.includes("fx=1"), "jar cookie missing: " + out);
    return out;
  });

  await check("api: IndexedDB round-trips inside the virtual origin", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "idb", `async () => {
      const db = await new Promise((res, rej) => {
        const o = indexedDB.open("zl-e2e-db", 1);
        o.onupgradeneeded = () => o.result.createObjectStore("s");
        o.onsuccess = () => res(o.result);
        o.onerror = () => rej(o.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction("s", "readwrite");
        tx.objectStore("s").put("v", "k");
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return await new Promise((res, rej) => {
        const rq = db.transaction("s", "readonly").objectStore("s").get("k");
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
    }`);
    eq(out, "v", "IndexedDB value");
    return out;
  });

  await check("api: Cache API round-trips inside the virtual origin", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "cache", `async () => {
      const c = await caches.open("zl-e2e-cache");
      await c.put(new Request("k"), new Response("v"));
      const m = await c.match("k");
      return m ? await m.text() : "MISS";
    }`);
    eq(out, "v", "Cache API value");
    return out;
  });

  await check("api: navigator.serviceWorker.register in a proxied page is a virtual record", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "swshim", `async () => {
      try {
        const r = await navigator.serviceWorker.register("/sw-probe.js");
        return r ? "ok" : "none";
      } catch (e) { return "REJECTED " + e; }
    }`);
    eq(out, "ok", "virtual registration");
    return out;
  });

  /* ---- rewriter ---------------------------------------------------- */

  await check("rewriter: HTML img + srcset + CSS url() (file + inline) resolve inside the engine", async () => {
    const { frame, rec } = await openProxied(ORIGIN_A + "/dir/page.html");
    /* Failure forensics. Engine routes are base64, so the old
       url.includes("img.png") filter could never match anything and
       the dump only ran after the asserts had already thrown. Dump
       every engine-route request, before the asserts. */
    const dump = () => {
      const rs = rec.requests
        .filter((r) => r.url.includes("aHR0cDov") || r.url.includes("/wisp/"))
        .map((r) => ({ url: r.url.slice(-36), fromSW: r.fromSW, status: r.status, failed: r.failed }));
      console.log("  [assets-rec] " + JSON.stringify(rs));
    };
    let out;
    try {
      out = await evalIn(frame, "assets", `async () => {
      /* The wait resolves on ANY settled state (complete, load, error
         or 12s) and reports it: a complete-but-zero image used to
         hang this promise forever, reporting a timeout that hid the
         real state from the failure message. */
      const one = (id) => new Promise((r) => {
        const i = document.getElementById(id);
        const st = (extra) => r({ id, complete: i.complete, w: i.naturalWidth, src: i.currentSrc ?? i.src ?? "", ...extra });
        if (!i) { r({ id, missing: true }); return; }
        if (i.complete) { st(); return; }
        i.onload = () => st();
        i.onerror = () => st({ error: true });
        setTimeout(() => st({ timeout: true }), 12000);
      });
      const st = await Promise.all([one("img1"), one("ss")]);
      const img1 = document.getElementById("img1")?.naturalWidth ?? -1;
      const ss = document.getElementById("ss")?.naturalWidth ?? -1;
      const ssSrc = document.getElementById("ss")?.currentSrc ?? "";
      const bg = getComputedStyle(document.getElementById("cssbg")).backgroundImage;
      const inl = getComputedStyle(document.getElementById("inlbg")).backgroundImage;
      /* Resource Timing sees through the SW: responseStatus and body
         sizes classify a 404 passthrough vs a broken replay vs a good
         hit. Engine routes all start with the base64 of "http://". */
      const rt = performance.getEntriesByType("resource")
        .filter((e) => e.name.includes("aHR0cDov"))
        .map((e) => ({ n: e.name.slice(-24), s: e.responseStatus, t: e.transferSize, eb: e.encodedBodySize, db: e.decodedBodySize, ms: Math.round(e.duration) }));
      /* A refetch of the already-loaded route from the controlled page
         tells whether the SW answers a repeat request with real bytes. */
      const src1 = document.getElementById("img1")?.currentSrc ?? "";
      const probe = await Promise.race([
        fetch(src1)
          .then(async (r) => [r.status, r.headers.get("content-type"), (await r.arrayBuffer()).byteLength])
          .catch((e) => ["ERR", String(e).slice(0, 90)]),
        new Promise((r) => setTimeout(() => r(["HUNG"]), 8000)),
      ]);
      return JSON.stringify({ st, img1, ss, ssSrc, bg, inl, rt, probe, ctrl: !!navigator.serviceWorker?.controller });
    }`);
    } catch (e) {
      dump();
      throw e;
    }
    const o = JSON.parse(out);
    if (o.img1 <= 0 || o.ss <= 0) dump();
    assert(o.img1 > 0, "src img did not decode: " + out);
    assert(o.ss > 0, "srcset img did not decode: " + out);
    for (const k of ["bg", "inl"]) {
      assert(!String(o[k]).includes("7101"), k + " leaks the fixture origin: " + o[k]);
    }
    return "img " + o.img1 + "px, bg " + o.bg.slice(0, 40);
  });

  await check("rewriter: iframe src is proxied", async () => {
    const pg = (await openProxied(ORIGIN_A + "/dir/page.html")).page;
    const inner = await waitFor("inner frame", 30000, async () => {
      for (const f of pg.frames()) {
        try {
          if (f.url().startsWith(ENGINE + "/j/") && (await f.locator("#zl-inner-marker").count())) return f;
        } catch {}
      }
      return null;
    });
    eq(await inner.locator("#zl-inner-marker").textContent(), "zl-inner", "inner marker");
    return inner.url().slice(0, 44);
  });

  await check("rewriter: meta http-equiv=refresh navigates inside the engine (#36)", async () => {
    const pg = await context.newPage();
    attachRecorder(pg);
    await pg.goto(ENGINE + "/?url=" + encodeURIComponent(ORIGIN_A + "/dir/refresh.html"));
    const landing = await waitFor("post-refresh landing frame", 30000, () => frameWith(pg, "#zl-landing"));
    assert(landing.url().startsWith(ENGINE + "/j/"), "post-refresh URL is not an engine route: " + landing.url());
    eq(await landing.locator("#zl-landing").textContent(), "zl-landing", "landing marker");
    return landing.url().slice(0, 44);
  });

  await check("rewriter: iframe srcdoc URLs are rewritten in the nested document (#36)", async () => {
    const { page: pg, rec } = await openProxied(ORIGIN_A + "/dir/page.html");
    const doc = await waitFor("srcdoc frame", 30000, async () => {
      for (const f of pg.frames()) {
        try {
          if ((await f.locator("#zl-srcdoc").count()) > 0) return f;
        } catch {}
      }
      return null;
    });
    /* The img poll reports complete/error state instead of only the
       width, and a raced in-frame fetch of the same engine route says
       whether the SW answers the request at all (status + body bytes)
       or never responds. */
    const out = await evalIn(doc, "srcdoc img", `async () => {
      const img = document.getElementById("sdi");
      for (let i = 0; i < 100; i++) {
        if (img.complete && img.naturalWidth) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const probe = await Promise.race([
        fetch(img.src)
          .then(async (r) => [r.status, r.headers.get("content-type"), (await r.arrayBuffer()).byteLength])
          .catch((e) => ["FETCH-ERR", String(e)]),
        new Promise((r) => setTimeout(() => r(["FETCH-HUNG"]), 8000)),
      ]);
      return JSON.stringify({ w: img.naturalWidth, complete: img.complete, src: img.src, probe, ctrl: !!navigator.serviceWorker?.controller });
    }`, 25000);
    const o = JSON.parse(out);
    if (o.w <= 0) {
      /* Engine routes are base64: filter on the base64 of "http://"
         instead of the target filename, which never appears. */
      const rs = rec.requests
        .filter((r) => r.url.includes("aHR0cDov") || r.url.includes("/wisp/"))
        .map((r) => ({ url: r.url.slice(-36), fromSW: r.fromSW, status: r.status, failed: r.failed }));
      console.log("  [srcdoc-rec] " + JSON.stringify(rs));
    }
    assert(o.w > 0, "srcdoc image did not decode (srcdoc not rewritten?): " + out);
    assert(!String(o.src).includes("7101"), "srcdoc img src leaks the fixture origin: " + o.src);
    return o.src.slice(0, 44);
  });

  await check("rewriter: base href folds later relative URLs (#36)", async () => {
    const pg = await context.newPage();
    attachRecorder(pg);
    await pg.goto(ENGINE + "/?url=" + encodeURIComponent(ORIGIN_A + "/dir/based.html"));
    const frame = await waitFor("based frame", 45000, () => frameWith(pg, "#zl-based"));
    const out = await evalIn(frame, "base fold", `async () => {
      const img = document.getElementById("bi");
      for (let i = 0; i < 100; i++) {
        if (img.complete && img.naturalWidth) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return JSON.stringify({ w: img.naturalWidth, src: img.src });
    }`, 20000);
    const o = JSON.parse(out);
    eq(o.w, 7, "base-folded SVG did not decode at its intrinsic width (base not folded?): " + out);
    await sleep(500);
    const hits = await fixtureHits(fixtureA, "/sub/logo.svg");
    assert(hits.length >= 1, "no engine-side hit for /sub/logo.svg (base not folded)");
    return o.src.slice(0, 44);
  });

  await check("rewriter: srcset data URL candidate stays intact, other candidates routed (#36)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "srcset data url", `async () => {
      const img = document.getElementById("ssd");
      for (let i = 0; i < 100; i++) {
        if (img.complete && img.naturalWidth) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return JSON.stringify({ w: img.naturalWidth, cur: img.currentSrc, set: img.srcset });
    }`, 20000);
    const o = JSON.parse(out);
    assert(o.w > 0, "data URL srcset candidate did not decode (split on its payload comma?): " + out);
    assert(String(o.cur).startsWith("data:image/png"), "currentSrc is not the intact data URL: " + o.cur);
    assert(String(o.set).includes("base64,iVBORw0KGgo"), "data URL candidate was split on its payload comma: " + o.set);
    assert(String(o.set).includes("/j/"), "second candidate not routed: " + o.set);
    return String(o.cur).slice(0, 32);
  });

  await check("rewriter: module script import specifiers resolve through the engine", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "module import", `async () => {
      for (let i = 0; i < 100; i++) {
        if (document.documentElement.dataset.zlMod) return document.documentElement.dataset.zlMod;
        await new Promise((r) => setTimeout(r, 100));
      }
      return "MODULE-MISSING";
    }`, 20000);
    eq(out, "mod-ok", "module import did not resolve (specifier not rewritten?)");
    return out;
  });

  /* ---- privacy ----------------------------------------------------- */

  await check("privacy: window.__ZL carries no plaintext destination (#32)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const s = await evalIn(frame, "__ZL", `() => JSON.stringify(window.__ZL ?? null)`);
    assert(!s.includes("7101"), "__ZL leaks the fixture destination: " + s);
    return s;
  });

  await check("privacy: page surfaces show only engine routes (#32)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "surfaces", `() => JSON.stringify({
      href: location.href, base: document.baseURI, ref: document.referrer,
    })`);
    const o = JSON.parse(out);
    for (const k of Object.keys(o)) {
      assert(!String(o[k]).includes("7101"), k + " leaks the fixture origin: " + o[k]);
    }
    assert(o.href.startsWith(ENGINE + "/j/"), "location is not an engine route: " + o.href);
    return o.href;
  });

  await check("privacy: two virtual contexts stay isolated (storage, cookies, cache)", async () => {
    const a = await openProxied(ORIGIN_A + "/dir/page.html");
    const b = await openProxied(ORIGIN_B + "/dir/page.html");
    await evalIn(a.frame, "isolation A", `async () => {
      localStorage.setItem("zlIso", "fromA");
      document.cookie = "zlIso=fromA; path=/";
      const c = await caches.open("zl-iso-cache");
      await c.put(new Request("k"), new Response("v"));
      return "put";
    }`);
    await sleep(600);
    const out = await evalIn(b.frame, "isolation B", `async () => {
      const ls = localStorage.getItem("zlIso");
      const ck = document.cookie;
      const hasCache = await caches.has("zl-iso-cache");
      return JSON.stringify({ ls, ck, hasCache });
    }`);
    const o = JSON.parse(out);
    eq(o.ls, null, "localStorage leaked across virtual contexts");
    assert(!o.ck.includes("fromA"), "cookie jar leaked across virtual contexts: " + o.ck);
    eq(o.hasCache, false, "Cache API name leaked across virtual contexts");
    return "isolated";
  });

  await check("privacy: no browser-direct fixture request in the network capture (#34)", async () => {
    const fx = [];
    for (const rec of recorders) {
      for (const r of rec.requests) {
        if (r.url.includes(":7101") || r.url.includes(":7102")) fx.push(r);
      }
    }
    const bad = fx.filter((r) => r.fromSW === false || (r.failed && r.status === 0));
    assert(bad.length === 0, "browser-direct fixture requests (not SW-served, or failed with no response): " + JSON.stringify(bad.slice(0, 6)));
    return fx.length + " fixture-URL entries observed, none browser-direct";
  });

  await check("privacy: fixture wire log shows no engine-referer (browser-direct) hits (#34)", async () => {
    const bads = [];
    for (const fx of [fixtureA, fixtureB]) {
      const hits = await fixtureHits(fx);
      for (const h of hits) {
        const ref = h.referer ?? "";
        if (ref.includes("127.0.0.1:6002") || ref.includes("/j/")) bads.push(fx.origin + " " + JSON.stringify(h));
      }
    }
    assert(bads.length === 0, "browser-direct hits (engine-origin referer): " + bads.slice(0, 6).join(" | "));
    const n = (await fixtureHits(fixtureA)).length + (await fixtureHits(fixtureB)).length;
    return n + " fixture hits total, all engine-referered or refererless";
  });

  /* ---- report ------------------------------------------------------ */

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("== browser E2E summary: " + (results.length - failed.length) + " passed, " + failed.length + " failed ==");
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
    try { if (browser) await browser.close(); } catch {}
    try { fixtureA?.stop(); } catch {}
    try { fixtureB?.stop(); } catch {}
    try { engineProc?.kill("SIGKILL"); } catch {}
  });
