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
      failed or was served with fromServiceWorker !== true. The gate
      fails only on positive evidence of a non-SW request; SW-served
      entries (fromServiceWorker) and unattributable entries pass.

   Honest gaps (documented, not faked): WebSocket targets are skipped
      (the engine upgrades ws to wss by design; the local fixture is
      plain HTTP, so the bridge cannot be exercised against loopback
      without a TLS fixture), the SW-restart group and the #36 rewriter
      constructs (meta refresh, srcdoc, base, SVG, srcset edge
      parsing) are not covered yet - see suite/e2e/README.md.

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
   fixture request (loadingFailed, or a response that was NOT served
   by the service worker). */
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
  attachRecorder(pg);
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
  return { page: pg, frame };
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
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "assets", `async () => {
      await new Promise((r) => {
        const i = document.getElementById("img1");
        if (i.complete && i.naturalWidth) r();
        else { i.onload = () => r(); i.onerror = () => r(); }
      });
      const img1 = document.getElementById("img1").naturalWidth;
      const ss = document.getElementById("ss").naturalWidth;
      const bg = getComputedStyle(document.getElementById("cssbg")).backgroundImage;
      const inl = getComputedStyle(document.getElementById("inlbg")).backgroundImage;
      return JSON.stringify({ img1, ss, bg, inl });
    }`);
    const o = JSON.parse(out);
    assert(o.img1 > 0, "src img did not decode (naturalWidth 0)");
    assert(o.ss > 0, "srcset img did not decode (naturalWidth 0)");
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
    const bad = fx.filter((r) => r.failed || r.fromSW === false);
    assert(bad.length === 0, "browser-direct fixture requests (failed or not SW-served): " + JSON.stringify(bad.slice(0, 6)));
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
