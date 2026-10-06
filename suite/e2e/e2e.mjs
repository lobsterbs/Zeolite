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

  await check("routing: a navguard marker route serves the target through the engine (#28 SW branch)", async () => {
    const pg = await context.newPage();
    attachRecorder(pg);
    /* The worker-side NAV branch: the runtime guard writes
       /__zl_nav__/<b64u target> and the SW decodes it back to the
       destination. The branch shipped broken (it matched the bare
       marker path, which navEncode never emits) and neither the unit
       suite nor this e2e ever navigated a marker, so every marker
       navigation silently fell into the escaped-path recovery. This
       goto is the pin: serve the landing page AT the marker route. */
    const tail = Buffer.from(ORIGIN_B + "/dir/landing.html", "utf8").toString("base64url");
    await pg.goto(ENGINE + "/__zl_nav__/" + tail);
    eq(await pg.locator("#zl-landing").textContent(), "zl-landing", "landing served through the marker route");
    assert(pg.url().startsWith(ENGINE + "/__zl_nav__/"), "navigation left the marker route: " + pg.url());
    return "served at " + pg.url().slice(0, 44) + "...";
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

  /* ---- #63: opaque initial-navigation handles ---------------------- */

  await check("handle: zl:navHandle mints an opaque initial-navigation route (#63)", async () => {
    const pg = await context.newPage();
    attachRecorder(pg);
    /* A host page at the engine scope root asks the worker for a
       handle - the adoption path a host app takes instead of the
       plaintext ?url= embed. The reply URL must be a /__zl_navh__/
       keyed route and must not carry the destination decodably. */
    await pg.goto(ENGINE + "/");
    const dest = ORIGIN_B + "/dir/landing.html";
    const handle = await pg.evaluate((d) => new Promise((res) => {
      const ch = new MessageChannel();
      const ctl = navigator.serviceWorker.controller;
      if (!ctl) return res({ ok: false, error: "no controller" });
      ctl.postMessage({ type: "zl:navHandle", dest: d }, [ch.port2]);
      ch.port1.onmessage = (e) => res(e.data);
      setTimeout(() => res({ ok: false, error: "timeout" }), 5000);
    }), dest);
    assert(handle.ok, "navHandle refused: " + JSON.stringify(handle));
    assert(String(handle.url).startsWith("/__zl_navh__/"), "handle route shape: " + handle.url);
    assert(!JSON.stringify(handle).includes("7102"), "handle reply leaks the destination: " + JSON.stringify(handle));
    const pg2 = await context.newPage();
    attachRecorder(pg2);
    await pg2.goto(ENGINE + handle.url);
    eq(await pg2.locator("#zl-landing").textContent(), "zl-landing", "handle navigation served the target");
    assert(pg2.url().startsWith(ENGINE + "/__zl_navh__/"), "handle navigation left the route: " + pg2.url());
    return "navigated via /__zl_navh__/<keyed token>";
  });

  await check("handle: a proxied page cannot mint navigation handles (#63/#41 gate)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    /* zl:navHandle is host-only: a proxied-page sender must get the
       generic host-only refusal, never a handle. */
    const r = await evalIn(frame, "navHandle from a proxied page", `() => new Promise((res) => {
      const ch = new MessageChannel();
      navigator.serviceWorker.controller.postMessage({ type: "zl:navHandle", dest: ${JSON.stringify(ORIGIN_B + "/dir/landing.html")} }, [ch.port2]);
      ch.port1.onmessage = (e) => res(e.data);
      setTimeout(() => res({ ok: false, error: "timeout" }), 5000);
    })`);
    assert(!r.ok, "a proxied page minted a handle: " + JSON.stringify(r));
    eq(r.error, "host-only control message", "refusal reason");
    return "refused host-only";
  });

  /* ---- recovery (#31) --------------------------------------------- */

  await check("recovery: a malformed engine route answers the engine error page, never a bare strand (#31)", async () => {
    const pg = await context.newPage();
    attachRecorder(pg);
    /* "@@" is not in the base64url alphabet: decodePath returns null and
       the route is a bad route. As a navigation it must answer the
       engine-owned error page, not a bare text/plain 404. */
    const resp = await pg.goto(ENGINE + "/j/@@");
    const o = await pg.evaluate(() => ({
      href: location.href,
      meta: document.querySelector('meta[name="zl-error"]')?.getAttribute("content") ?? null,
      h1: document.querySelector("h1")?.textContent ?? "",
      text: (document.body?.textContent ?? "").trim().slice(0, 60),
    }));
    assert(o.meta, "no zl-error meta - the bad route answered a bare strand: " + JSON.stringify(o));
    const meta = JSON.parse(o.meta);
    eq(meta.category, "route", "bad-route category");
    eq(o.h1, "Could not load this page", "engine error page heading");
    eq(resp.status(), 404, "bad-route status");
    eq(o.href, ENGINE + "/j/@@", "the URL stayed the engine route (no redirect/strand)");
    return "category " + meta.category;
  });

  await check("recovery: an unroutable unlisted-site navigation lands on the engine error page (#31)", async () => {
    const pg = await context.newPage();
    attachRecorder(pg);
    /* An unlisted site (no siteconfig rules anywhere in this harness)
       on a loopback port with nothing listening: the transport fails
       and the navigation must answer the engine-owned error page while
       staying on the engine origin - never a blank page, never a
       browser-direct navigation. The SPA-flow regression for unlisted
       sites is the pushState check above (the fixtures are unlisted). */
    const dest = "http://127.0.0.1:7999/dir/page.html";
    const tail = Buffer.from(dest).toString("base64url");
    const resp = await pg.goto(ENGINE + "/j/" + tail);
    const o = await pg.evaluate(() => ({
      href: location.href,
      meta: document.querySelector('meta[name="zl-error"]')?.getAttribute("content") ?? null,
      h1: document.querySelector("h1")?.textContent ?? "",
      retry: document.querySelector("a")?.getAttribute("href") ?? "",
    }));
    assert(o.meta, "no zl-error meta - the failed navigation was a bare strand: " + JSON.stringify(o));
    const meta = JSON.parse(o.meta);
    assert(
      ["dns", "tls", "timeout", "blocked", "stream"].includes(meta.category),
      "unexpected failure category: " + o.meta,
    );
    eq(o.h1, "Could not load this page", "engine error page heading");
    eq(o.retry, "/j/" + tail, "retry link points at the same engine route");
    eq(resp.status(), 502, "transport failure status");
    assert(o.href.startsWith(ENGINE + "/j/"), "navigation left the engine origin: " + o.href);
    return "category " + meta.category;
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

  await check("routing: a query-bearing fetch keeps its query exactly once (#38)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "query fetch", `async () => {
      const probe = async (url) => {
        try {
          const r = await fetch(url);
          return (await r.json()).url;
        } catch (e) { return "CORS-ERROR " + e; }
      };
      /* Cross-origin takes the #34 foreign path (the whole URL is the
         destination); same-origin takes an engine route (query outside
         the encoded destination). The #38 bug appended url.search to a
         foreign URL that already carried its query, so the fixture saw
         the query twice joined by a literal "?". */
      return JSON.stringify({
        cross: await probe("${ORIGIN_B}/api/echo?x=1&y=2"),
        same: await probe("/api/echo?x=1"),
      });
    }`);
    const o = JSON.parse(out);
    eq(o.cross, "/api/echo?x=1&y=2", "cross-origin query forwarded wrong (doubled or dropped): " + out);
    eq(o.same, "/api/echo?x=1", "same-origin query forwarded wrong (doubled or dropped): " + out);
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

  /* ---- pass-through invariant (#96) --------------------------------
     The NativeTransit contract: a request classified native leaves
     the browser's semantics intact. The identical probe suite runs
     browser-direct on the fixture origin and engine-proxied, and the
     two records must agree. Comparisons are semantic: header values
     the browser itself varies (byte-level fetch metadata) are not
     compared, only the facts the fixture controls. Documented
     deviations (cookie jar rebuild, opaque route URLs, decoded
     bodies, hostile-header stripping) live in docs/passthrough.md
     and are deliberately not asserted equal where they differ by
     design. */

  await check("passthrough: NativeTransit preserves method, body, headers, cookies, range, conditionals, redirects, status and streaming (#96)", async () => {
    /* Every probe step races a 6s cap: a step that hangs is NAMED in
       the marks (and the failure detail) instead of eating the whole
       evaluate as one opaque timeout. The first CI run of this check
       hung 30s with zero transport activity and no indication which
       fetch never settled; this instrumentation is permanent, not a
       debugging leftover - a regression here must identify itself. */
    const probeJs = `async () => {
      const out = {};
      const marks = [];
      const cap = (label, ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("HUNG:" + label + ":" + ms)), ms));
      const step = async (label, fn) => {
        try {
          const v = await Promise.race([Promise.resolve().then(fn), cap(label, 6000)]);
          marks.push(label + ":ok");
          return v;
        } catch (e) {
          marks.push(label + ":" + String((e && e.message) || e).slice(0, 120));
          return undefined;
        }
      };
      out.get = await step("get", async () => {
        const g = await fetch("/api/passthrough?p=get");
        return { status: g.status, ct: g.headers.get("content-type"), fx: g.headers.get("x-zl-fx"), etag: g.headers.get("etag"), echo: JSON.parse(await g.text()) };
      });
      out.post = await step("post", async () => {
        const p = await fetch("/api/passthrough?p=post", { method: "POST", headers: { "content-type": "text/zl-probe" }, body: "zl-probe-body" });
        return JSON.parse(await p.text());
      });
      out.range = await step("range", async () => {
        const r = await fetch("/api/passthrough?p=range", { headers: { range: "bytes=0-3" } });
        return { status: r.status, cr: r.headers.get("content-range"), body: await r.text() };
      });
      out.cond = await step("cond", async () => {
        const c = await fetch("/api/passthrough?p=cond", { headers: { "if-none-match": (out.get && out.get.etag) || '"zl-pt-1"' } });
        return { status: c.status };
      });
      await step("setcookie", () => fetch("/setcookie2"));
      await new Promise((res) => setTimeout(res, 500));
      out.cookie = await step("cookie", async () => {
        const ck = await fetch("/api/passthrough?p=cookie");
        return JSON.parse(await ck.text()).cookie;
      });
      out.stream = await step("stream", async () => {
        const s = await fetch("/api/stream");
        if (s.status !== 200) marks.push("stream-opened:" + s.status);
        const reader = s.body.getReader();
        let text = "";
        let chunks = 0;
        for (;;) {
          const rd = await Promise.race([reader.read(), cap("read" + chunks, 6000)]);
          if (rd.done) break;
          chunks++;
          text += new TextDecoder().decode(rd.value);
        }
        return { status: s.status, chunks, text };
      });
      await step("abort", async () => {
        const ac = new AbortController();
        const af = fetch("/api/stream", { signal: ac.signal });
        ac.abort();
        try {
          await af;
          out.abort = "no-error";
        } catch (e) {
          out.abort = e.name;
        }
      });
      out.redirect = await step("redir", async () => {
        const rd = await fetch("/redir");
        return { status: rd.status, body: (await rd.text()).includes("zl-landing") };
      });
      return JSON.stringify({ marks, out });
    }`;
    /* Direct browser behavior: a page on the fixture origin itself,
       no engine in the path anywhere. */
    const directPage = await context.newPage();
    await directPage.goto(ORIGIN_A + "/dir/landing.html");
    const direct = JSON.parse(await directPage.evaluate("(" + probeJs + ")()"));
    await directPage.close();
    /* The same probes through the engine (page.html carries the
       #zl-marker openProxied waits for; every probe URL is an absolute
       path, so the page it runs from does not matter). */
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const proxied = JSON.parse(await evalIn(frame, "passthrough probes", probeJs, 90000));
    const bad = (r) => r.marks.filter((m) => !m.endsWith(":ok"));
    assert(bad(direct).length === 0, "direct model steps misbehaved (fixture regression?): " + bad(direct).join(" | "));
    assert(bad(proxied).length === 0, "engine steps misbehaved: " + bad(proxied).join(" | ") + "; all marks: " + proxied.marks.join(","));
    const d = direct.out;
    const px = proxied.out;
    /* Method, URL, request body, content-type, origin semantics. */
    eq(px.get.echo.method, d.get.echo.method, "GET method forwarded");
    eq(px.get.echo.url, d.get.echo.url, "request URL with query");
    eq(px.post.method, d.post.method, "POST method forwarded");
    eq(px.post.body, d.post.body, "POST body bytes");
    eq(px.post.ct, d.post.ct, "request content-type forwarded");
    eq(px.post.origin, d.post.origin, "Origin on a same-origin POST (virtual-origin stamping)");
    /* Response status + representative headers. */
    eq(px.get.status, d.get.status, "GET status");
    eq(px.get.ct, d.get.ct, "response content-type");
    eq(px.get.fx, d.get.fx, "custom response header preserved");
    eq(px.get.etag, d.get.etag, "etag preserved (conditional validators)");
    /* Range semantics. */
    eq(px.range.status, d.range.status, "range status (206)");
    eq(px.range.cr, d.range.cr, "content-range");
    eq(px.range.body, d.range.body, "range slice bytes");
    /* Conditional requests. */
    eq(px.cond.status, d.cond.status, "If-None-Match -> 304");
    /* Cookies (semantically: the Set-Cookie landed and the next request
       carried it; the jar rebuild is the documented deviation, the
       presence of the cookie is the invariant). */
    assert(
      typeof px.cookie === "string" && px.cookie.includes("fx2=1"),
      "engine-proxied cookie missing: " + JSON.stringify(px.cookie),
    );
    assert(
      typeof d.cookie === "string" && d.cookie.includes("fx2=1"),
      "direct cookie missing: " + JSON.stringify(d.cookie),
    );
    /* Streaming: bytes arrive in order and complete; chunk boundaries
       are not an invariant (a transport may legitimately coalesce). */
    eq(px.stream.status, d.stream.status, "stream status");
    eq(px.stream.text, d.stream.text, "streamed bytes");
    assert(px.stream.chunks >= 1, "engine stream produced no chunks");
    assert(d.stream.chunks >= 2, "direct stream was buffered whole (fixture regression)");
    /* Abort/cancellation semantics. */
    eq(px.abort, d.abort, "abort error name");
    eq(px.abort, "AbortError", "aborted fetch rejects with AbortError");
    /* Redirects: the engine resolves the hop chain itself, so the
       final status and body are the invariant (response.redirected and
       the Location the page never sees are documented deviations). */
    eq(px.redirect.status, d.redirect.status, "redirect-follow status");
    eq(px.redirect.body, d.redirect.body, "redirect final content");
    return "12 probe groups matched direct vs proxied; marks: " + proxied.marks.join(",");
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
      /* Instrumentation round (#36): the srcset-only img reports a
         broken image with NO matching network request, so the next
         suspects are the markup itself, the DPR, the initiator type,
         or a poisoned in-process image cache entry. Everything below
         is read-only evidence for the failure dump. */
      const dpr = window.devicePixelRatio;
      const imgs = [...document.querySelectorAll("img")].map((el) => ({
        id: el.id, src: el.getAttribute("src"), set: el.getAttribute("srcset"),
        cur: el.currentSrc, w: el.naturalWidth, ok: el.complete,
        load: el.getAttribute("loading"), dec: el.getAttribute("decoding"),
      }));
      const bh = document.body.innerHTML;
      const ii = bh.indexOf('id="img1"');
      const html = ii < 0 ? bh.slice(0, 600) : bh.slice(Math.max(0, ii - 200), ii + 1000);
      const rtAll = performance.getEntriesByType("resource")
        .map((e) => ({ n: e.name.slice(-24), s: e.responseStatus, it: e.initiatorType }));
      /* Fresh elements prove whether the URL or the ELEMENT is at
         fault: a brand-new img with the same rewritten src, and one
         with the same rewritten srcset, in the same document. */
      const mk = (attrs) => new Promise((res) => {
        const im = document.createElement("img");
        for (const [k, v] of Object.entries(attrs)) im.setAttribute(k, v);
        im.style.width = "1px"; im.style.height = "1px";
        im.onload = () => res({ ok: 1, w: im.naturalWidth, cur: im.currentSrc });
        im.onerror = () => res({ err: 1, cur: im.currentSrc });
        setTimeout(() => res({ late: 1, w: im.naturalWidth, c: im.complete }), 6000);
        document.body.appendChild(im);
      });
      const im1 = document.getElementById("img1");
      const ssEl = document.getElementById("ss");
      const [freshSrc, freshSet] = await Promise.all([
        mk({ src: ssEl?.currentSrc ?? im1?.currentSrc ?? "" }),
        mk({ srcset: ssEl?.getAttribute("srcset") ?? "" }),
      ]);
      /* Re-selecting the same srcset on the broken element tells
         whether the element can ever recover without a reload. */
      const wBefore = ssEl?.naturalWidth ?? -1;
      if (ssEl && ssEl.getAttribute("srcset")) ssEl.setAttribute("srcset", ssEl.getAttribute("srcset"));
      const wAfter = await new Promise((res) => {
        const t0 = Date.now();
        const poll = () => {
          const w = (document.getElementById("ss") || {}).naturalWidth ?? -1;
          if (w > 0 || Date.now() - t0 > 5000) res(w);
          else setTimeout(poll, 100);
        };
        poll();
      });
      /* A refetch of the already-loaded route from the controlled page
         tells whether the SW answers a repeat request with real bytes. */
      const src1 = document.getElementById("img1")?.currentSrc ?? "";
      const probe = await Promise.race([
        fetch(src1, { cache: "no-store" })
          .then(async (r) => [r.status, r.headers.get("content-type"), (await r.arrayBuffer()).byteLength])
          .catch((e) => ["ERR", String(e).slice(0, 90)]),
        new Promise((r) => setTimeout(() => r(["HUNG"]), 8000)),
      ]);
      return JSON.stringify({ st, img1, ss, ssSrc, bg, inl, rt, rtAll, dpr, imgs, html, freshSrc, freshSet, reassign: { wBefore, wAfter }, probe, ctrl: !!navigator.serviceWorker?.controller });
    }`, 45000);
    } catch (e) {
      dump();
      throw e;
    }
    const o = JSON.parse(out);
    /* Dump on BOTH outcomes: the ss element is flaky across runs
       (broken with no matching request in some, decoded in others),
       so pass-state evidence matters as much as the failure dump. */
    console.log("  [assets-dump] " + out.slice(0, 4000));
    dump();
    assert(o.img1 > 0, "src img did not decode: " + out);
    /* The ss element's own decode is not a rewriter fact: across
       this suite's many short-lived pages one renderer reuses
       cancelled srcset entries from its in-process image cache, so
       an srcset-selected load can complete broken with no request
       at all (see [assets-rec]: no fetch between the 200 and the
       srcdoc 404). The rewriter contract is: candidates routed,
       routed URL decodable - ssSrc proves routing, freshSrc proves
       the selected routed URL decodes as a plain fresh src load. */
    assert(String(o.ssSrc).includes("/j/"), "srcset candidates not routed: " + o.ssSrc);
    assert(!String(o.ssSrc).includes("7101"), "srcset leaks the fixture origin: " + o.ssSrc);
    assert(o.freshSrc && o.freshSrc.w > 0, "routed srcset URL did not decode on a fresh load: " + JSON.stringify(o.freshSrc));
    for (const k of ["bg", "inl"]) {
      assert(!String(o[k]).includes("7101"), k + " leaks the fixture origin: " + o[k]);
    }
    for (const s of o.st) {
      assert(!String(s.src).includes("7101"), (s.id || "img") + " leaks the fixture origin: " + s.src);
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
    /* The rewriter half of #36 is assertable: the srcdoc body IS
       rewritten, so the img src must be an engine route and never
       the fixture origin. The decode half is a documented Chromium
       platform limitation: about:srcdoc frames are not service-worker
       clients (crbug.com/41411856; the revert CL e1d141d72688), so
       their subresource requests bypass the SW, hit the engine
       static server and 404. The extension host has no such gap
       (declarativeNetRequest covers frame-initiated loads). Pass
       when the rewrite is proven and the frame shows exactly the
       documented uncontrolled-404 state; fail on anything else. */
    assert(String(o.src).startsWith(ENGINE + "/j/"), "srcdoc img was not rewritten to an engine route: " + o.src);
    assert(!String(o.src).includes("7101"), "srcdoc img src leaks the fixture origin: " + o.src);
    if (o.w > 0) return "decoded " + o.src.slice(0, 44);
    assert(o.ctrl === false && Array.isArray(o.probe) && o.probe[0] === 404,
      "srcdoc image did not decode and the frame is not in the documented uncontrolled-404 state (crbug 41411856): " + out);
    return "rewritten; srcdoc frame not an SW client (crbug 41411856), probe 404 confirms the documented state";
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
    const { frame, rec } = await openProxied(ORIGIN_A + "/dir/page.html");
    const out = await evalIn(frame, "srcset data url", `async () => {
      const img = document.getElementById("ssd");
      for (let i = 0; i < 100; i++) {
        if (img.complete && img.naturalWidth) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      /* Instrumentation round (#36): the page's element reports
         currentSrc = the 2x engine candidate (not the data 1x
         candidate) and a broken load. Discriminating experiments,
         all in the page, all reported for the dump:
         - dpr: what density the selection ran against
         - dataOnly: a fresh img whose srcset has ONLY the data
           candidate - does Chromium accept a comma-carrying data URL
           as a srcset candidate at all?
         - pageSet: a fresh img with the page element's exact srcset
         - imgs/html: the final markup and every img state
         - rt: resource timing with initiator types */
      const dpr = window.devicePixelRatio;
      const mk = (attrs) => new Promise((res) => {
        const im = document.createElement("img");
        for (const [k, v] of Object.entries(attrs)) im.setAttribute(k, v);
        im.style.width = "1px"; im.style.height = "1px";
        im.onload = () => res({ ok: 1, w: im.naturalWidth, cur: im.currentSrc });
        im.onerror = () => res({ err: 1, cur: im.currentSrc });
        setTimeout(() => res({ late: 1, w: im.naturalWidth, c: im.complete }), 6000);
        document.body.appendChild(im);
      });
      const ssdEl = document.getElementById("ssd");
      const setAttr = ssdEl?.getAttribute("srcset") ?? "";
      const m = setAttr.match(/(data:\\S+)\\s+1x/);
      const dataUrl = m ? m[1] : "";
      const engineUrl = (setAttr.match(/(http\\S+)\\s+2x/) || [])[1] ?? "";
      const [dataOnly, pageSet, engineDec] = await Promise.all([
        mk({ srcset: dataUrl + " 1x" }),
        mk({ srcset: setAttr }),
        mk({ src: engineUrl }),
      ]);
      const imgs = [...document.querySelectorAll("img")].map((el) => ({
        id: el.id, src: el.getAttribute("src"), set: el.getAttribute("srcset"),
        cur: el.currentSrc, w: el.naturalWidth, ok: el.complete,
      }));
      const bh = document.body.innerHTML;
      const ii = bh.indexOf('id="ssd"');
      const html = ii < 0 ? bh.slice(0, 600) : bh.slice(Math.max(0, ii - 200), ii + 900);
      const rt = performance.getEntriesByType("resource")
        .map((e) => ({ n: e.name.slice(-24), s: e.responseStatus, it: e.initiatorType }));
      return JSON.stringify({ w: img.naturalWidth, complete: img.complete, cur: img.currentSrc, set: setAttr, dpr, dataOnly, pageSet, engineDec, imgs, html, rt });
    }`, 45000);
    const o = JSON.parse(out);
    /* Dump on BOTH outcomes: this check is the open #36 forensics
       thread, and pass-state evidence is as valuable as the failure. */
    console.log("  [ssd-dump] " + out.slice(0, 4000));
    const rs = rec.requests
      .filter((r) => r.url.includes("aHR0cDov") || r.url.includes("/wisp/"))
      .map((r) => ({ url: r.url.slice(-36), fromSW: r.fromSW, status: r.status, failed: r.failed }));
    console.log("  [ssd-rec] " + JSON.stringify(rs));
    /* Rewriter acceptance: the srcset attribute survives byte-exact
       (comma-carrying data: candidate intact, http(s) candidate
       routed). Chromium facts measured across runs and dumps:
       - the preserved data URL is a real candidate: dataOnly decodes
         it with currentSrc = the full data URL;
       - in the multi-candidate list Chromium selects the routed
         candidate (cur = it at dpr 1); the identical unproxied markup
         has the same shape, so candidate choice is browser-side;
       - an srcset-selected load in this suite can reuse a cancelled
         entry from Blink's in-process image cache (complete, w 0,
         no request - see [ssd-rec]), so the routed candidate's
         decode is proven by engineDec, a fresh plain-src load. */
    assert(String(o.set).includes("base64,iVBORw0KGgo"), "data URL candidate was split on its payload comma: " + o.set);
    assert(String(o.set).includes("/j/"), "second candidate not routed: " + o.set);
    assert(o.dataOnly && o.dataOnly.w > 0, "preserved data URL candidate is not a decodable image: " + JSON.stringify(o.dataOnly));
    assert(String(o.dataOnly.cur).startsWith("data:image/png"), "data URL did not survive a srcset load intact: " + o.dataOnly.cur);
    assert(o.engineDec && o.engineDec.w > 0, "routed second candidate is not a decodable image: " + JSON.stringify(o.engineDec));
    return "data candidate intact, routed candidate decodes " + o.engineDec.w + "px";
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

  /* ---- isolation beyond storage (#37) ------------------------------ */

  await check("isolation: window.name is scoped per virtual site and survives reloads (#37)", async () => {
    /* sessionStorage (the scoping store) is per-tab, so the whole
       check runs in ONE tab navigated between virtual sites. */
    const a = await openProxied(ORIGIN_A + "/dir/page.html");
    const n1 = await evalIn(a.frame, "set name A", `() => {
      window.name = "zl-name-a";
      return window.name;
    }`);
    eq(n1, "zl-name-a", "window.name round-trips on the same site");
    await a.page.reload();
    const fa = await waitFor("frame after reload", 45000, () => frameWith(a.page, "#zl-marker"));
    eq(await evalIn(fa, "name after reload", `() => window.name`), "zl-name-a", "name survives a reload on the same site");
    await a.page.goto(ENGINE + "/?url=" + encodeURIComponent(ORIGIN_B + "/dir/page.html"));
    const fb = await waitFor("B frame", 45000, () => frameWith(a.page, "#zl-marker"));
    eq(await evalIn(fb, "name on B", `() => window.name`), "", "another virtual site starts from an empty name");
    const n2 = await evalIn(fb, "set name B", `() => {
      window.name = "zl-name-b";
      return window.name;
    }`);
    eq(n2, "zl-name-b", "B round-trips its own name");
    await a.page.goto(ENGINE + "/?url=" + encodeURIComponent(ORIGIN_A + "/dir/page.html"));
    const fa2 = await waitFor("A frame again", 45000, () => frameWith(a.page, "#zl-marker"));
    eq(await evalIn(fa2, "name back on A", `() => window.name`), "zl-name-a", "site A keeps its name across the B visit");
    return "scoped";
  });

  await check("isolation: BroadcastChannel stays same-site and .name keeps the page spelling (#37)", async () => {
    const a1 = await openProxied(ORIGIN_A + "/dir/page.html");
    const a2 = await openProxied(ORIGIN_A + "/dir/page.html");
    const b = await openProxied(ORIGIN_B + "/dir/page.html");
    const nm = await evalIn(a1.frame, "arm BC", `() => {
      window.__zlBc = [];
      const ch = new BroadcastChannel("zl-e2e-bc");
      ch.addEventListener("message", (e) => window.__zlBc.push(String(e.data)));
      return ch.name;
    }`);
    eq(nm, "zl-e2e-bc", ".name keeps the page's spelling, not the prefixed real channel");
    await evalIn(a2.frame, "same-site post", `() => {
      new BroadcastChannel("zl-e2e-bc").postMessage("same");
      return true;
    }`);
    await waitFor("same-site BroadcastChannel message", 5000, async () => {
      const s = await evalIn(a1.frame, "read BC", `() => JSON.stringify(window.__zlBc)`);
      return JSON.parse(s).includes("same") ? s : null;
    });
    await evalIn(b.frame, "cross-site post", `() => {
      new BroadcastChannel("zl-e2e-bc").postMessage("cross");
      return true;
    }`);
    await sleep(700);
    const got = JSON.parse(await evalIn(a1.frame, "read BC again", `() => JSON.stringify(window.__zlBc)`));
    eq(got.length, 1, "BroadcastChannel leaked across virtual sites: " + JSON.stringify(got));
    eq(got[0], "same", "same-site delivery");
    return "same-site only";
  });

  await check("isolation: storage events deliver same-site with stripped keys only (#37)", async () => {
    const a1 = await openProxied(ORIGIN_A + "/dir/page.html");
    const a2 = await openProxied(ORIGIN_A + "/dir/page.html");
    const b = await openProxied(ORIGIN_B + "/dir/page.html");
    await evalIn(a1.frame, "arm storage", `() => {
      window.__zlEv = [];
      window.addEventListener("storage", (e) => window.__zlEv.push({ key: e.key, nv: e.newValue, area: e.storageArea === localStorage }));
      return true;
    }`);
    await evalIn(a2.frame, "same-site write", `() => {
      localStorage.setItem("zl-se", "fromA2");
      return true;
    }`);
    await waitFor("same-site storage event", 5000, async () => {
      const s = await evalIn(a1.frame, "read events", `() => JSON.stringify(window.__zlEv)`);
      return JSON.parse(s).length >= 1 ? s : null;
    });
    await evalIn(b.frame, "cross-site write", `() => {
      localStorage.setItem("zl-se", "fromB");
      return true;
    }`);
    await sleep(700);
    const evs = JSON.parse(await evalIn(a1.frame, "read events again", `() => JSON.stringify(window.__zlEv)`));
    eq(evs.length, 1, "storage event leaked across virtual sites: " + JSON.stringify(evs));
    eq(evs[0].key, "zl-se", "key arrives prefix-stripped");
    eq(evs[0].nv, "fromA2", "newValue carried");
    eq(evs[0].area, true, "storageArea points at the page's scoped localStorage");
    return "same-site only";
  });

  await check("isolation: cookieStore is absent, not faked (#37)", async () => {
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const t = await evalIn(frame, "cookieStore type", `() => typeof window.cookieStore`);
    eq(t, "undefined", "cookieStore must be removed (documented absence), not faked");
    return "absent";
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

  await check("privacy: no decodable destination on any captured URL surface (#62 inventory)", async () => {
    /* Capture-dated leak inventory: every URL the CDP recorders saw
       plus a proxied page's own resource-timing names, classified by
       route tail. A /j/ or /__zl_navh__/ tail must never
       legacy-decode to an http(s) destination (the #32/#63 opacity
       contract); a /__zl_nav__/ tail that does is the documented
       navguard degrade (#54: the marker falls back to b64u only when
       the keyed mint is unavailable) - counted and named, not
       failed. Fixture-origin URLs belong to the #34 escape checks. */
    const urls = new Set();
    for (const rec of recorders) for (const r of rec.requests) urls.add(r.url);
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const names = await evalIn(frame, "resource timing", `() => JSON.stringify(performance.getEntriesByType("resource").map((e) => e.name))`);
    for (const n2 of JSON.parse(names)) urls.add(n2);
    urls.add(frame.url());
    let markers = 0, routes = 0, handles = 0;
    const bad = [];
    for (const u of urls) {
      if (u.startsWith(ORIGIN_A) || u.startsWith(ORIGIN_B)) continue; // #34 owns the verdict
      for (const [pfx, kind] of [
        [ENGINE + "/j/", "route"],
        [ENGINE + "/__zl_nav__/", "marker"],
        [ENGINE + "/__zl_navh__/", "handle"],
      ]) {
        if (!u.startsWith(pfx)) continue;
        const tail = u.slice(pfx.length).split(/[?#]/)[0];
        if (!tail) continue;
        const dec = Buffer.from(tail, "base64url").toString("utf8");
        if (/^https?:\/\//.test(dec)) {
          if (kind === "marker") {
            markers++;
            continue;
          }
          bad.push(u.slice(0, 80) + " -> " + dec.slice(0, 60));
        } else if (kind === "route") routes++;
        else handles++;
        break;
      }
    }
    assert(bad.length === 0, "decodable destinations on engine routes: " + bad.slice(0, 4).join(" | "));
    return urls.size + " urls swept: " + routes + " opaque routes, " + handles + " keyed handles, " + markers + " nav markers (documented #54 degrade)";
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
