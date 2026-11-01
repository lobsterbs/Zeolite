/* Issue #528: which about:srcdoc parser subresources reach a service
   worker's fetch handler in real Chromium, and which bypass it?
   Direct-vs-proxied acceptance, two arms:

   - Direct control (a plain recording SW on the fixture origin, no
     engine): every srcdoc parser class (script, module script,
     stylesheet, image, CSS url(), nested srcdoc script) plus the
     child runtime fetch must BOTH reach the origin server (loads
     succeed) AND reach the SW fetch handler - Chromium 156 exposes
     about:srcdoc documents as service-worker clients (the
     crbug.com/41411856 limitation no longer reproduces; this suite
     pins the new platform truth). The about:blank control (a
     parent-written document.write child) is the REMAINING
     unsupported class: its parser requests still bypass the SW.
   - Proxied control (the real engine): the served srcdoc attribute
     must carry engine routes only (no fixture-origin leak), the
     parent page's own subresource must load through the engine,
     and the srcdoc child's parser subresources must now be served
     through the normal engine pipeline (the SW decodes the routes
     and fetches the fixture upstream), because the child is an SW
     client. An about:blank document.write child in the same page
     stays the honest residual: its requests bypass the SW and 404
     on the engine static server.

   Together these state the integration contract: on current Chromium
   a service-worker-only path now covers srcdoc parser subresources
   (nothing left to implement engine-side for srcdoc); the embedder
   contract applies only to the remaining opaque-client class
   (about:blank document.write children), which needs host-side
   interception that is not client-bound, or an engine-served
   child-document architecture. Ports 6031/7131 never collide with
   e2e.mjs (6002/7101), guest-sw (6009/7109), computed-sinks
   (6023/7123), replay-spool (6025/7125/7126), csp-enforce
   (6026/7127), vorigin-msg (6027/7128), sri (6041/7141) or
   vctx-restart (6034/7134). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6031;
const FX_PORT = 7131;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX = "http://127.0.0.1:" + FX_PORT;

/* 1x1 transparent PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const NL = String.fromCharCode(10);

/* The recording SW: logs every request URL it is asked about, answers
   a MessageChannel request with the list. */
const SW = [
  "const seen = [];",
  "self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));",
  "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
  "self.addEventListener('fetch', (e) => { seen.push(e.request.url); });",
  "self.addEventListener('message', (ev) => {",
  "  if (ev.data !== 'zl-srcdoc-seen') return;",
  "  ev.ports[0].postMessage(seen.slice());",
  "});",
].join(NL);

const D_PAGE = [
  "<!doctype html><title>direct srcdoc client fixture</title>",
  "<script>",
  "window.__ZL_READY = false;",
  "navigator.serviceWorker.register('/sw.js').then(async () => {",
  "  await navigator.serviceWorker.ready;",
  "  for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++)",
  "    await new Promise((r) => setTimeout(r, 100));",
  "  window.__ZL_READY = !!navigator.serviceWorker.controller;",
  "});",
  "</script>",
].join("");

/* Child markup for the DIRECT arm: relative URLs resolve against the
   parent base (about:srcdoc inherits it), so every class hits the FX
   origin. Asset bodies set flags on whichever window runs them. */
const D_CHILD = [
  "<script>",
  "window.__CLS = { app: 0, mod: 0, runtime: 0, errors: [] };",
  "addEventListener('error', function (e) {",
  "  var t = e.target;",
  "  if (t && t.getAttribute) window.__CLS.errors.push(String(t.getAttribute('data-cls') || t.tagName));",
  "}, true);",
  "</script>",
  "<script src='/d/app.js' data-cls='app'></script>",
  "<script type='module' src='/d/mod.mjs' data-cls='mod'></script>",
  "<link rel='stylesheet' href='/d/style.css' data-cls='css'>",
  "<img src='/d/img.png' data-cls='img'>",
  "<style>.zlbg { background: url('/d/bg.png'); }</style>",
  "<div class='zlbg' id='bgel'>bg</div>",
  "<iframe srcdoc=\"<script src=&quot;/d/nested.js&quot;></script>\"></iframe>",
  "<script>fetch('/d/runtime.js').then(function (r) { window.__CLS.runtime = r.status; })",
  ".catch(function (e) { window.__CLS.runtime = 'ERR'; });</script>",
].join("");

/* Engine-arm parent: the srcdoc is in the served markup so the REWRITER
   rewrites the attribute (absolute fixture URLs, so a leak is
   assertable), and the parent's own script proves the controlled
   path. */
const P_PAGE = [
  "<!doctype html><title>proxied srcdoc client fixture</title>",
  "<script src='own.js'></script>",
  "<iframe id='sd' srcdoc=\"",
  "<script>window.__CLS = { app: 0, mod: 0, errors: [] }; addEventListener('error', function (e) { var t = e.target; if (t && t.getAttribute) window.__CLS.errors.push(String(t.getAttribute('data-cls') || t.tagName)); }, true);</script>",
  "<script src='" + FX + "/p/app.js' data-cls='app'></script>",
  "<script type='module' src='" + FX + "/p/mod.mjs' data-cls='mod'></script>",
  "<link rel='stylesheet' href='" + FX + "/p/style.css' data-cls='css'>",
  "<img src='" + FX + "/p/img.png' data-cls='img'>",
  "<style>.zlbg { background: url('" + FX + "/p/bg.png'); }</style>",
  "<div class='zlbg' id='bgel'>bg</div>",
  "\"></iframe>",
].join("");

const results = [];
let engineProc = null;
const engineErr = [];
let browser = null;

async function check(name, fn) {
  try {
    const info = await fn();
    results.push({ ok: true, name, info: info ?? "" });
    console.log("  [OK] " + name + (info ? " :: " + info : ""));
  } catch (e) {
    results.push({ ok: false, name, info: String(e?.message ?? e) });
    console.log("  [FAIL] " + name + " :: " + String(e?.message ?? e));
  }
}

function engineTail() {
  return engineErr.join("").slice(-1500);
}

async function startFixture() {
  const hits = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, FX);
    hits.push(u.pathname);
    if (u.pathname === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(SW);
      return;
    }
    if (u.pathname === "/d/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(D_PAGE);
      return;
    }
    /* Direct-arm assets. Each sets a flag on the window that runs it:
       the outer child owns __CLS; the nested srcdoc child and the
       about:blank child own their own windows. */
    if (u.pathname === "/d/app.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.__CLS && (window.__CLS.app = 1);");
      return;
    }
    if (u.pathname === "/d/mod.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("window.__CLS && (window.__CLS.mod = 1);");
      return;
    }
    if (u.pathname === "/d/nested.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.__ZL_NESTED = 1;");
      return;
    }
    if (u.pathname === "/d/blank.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.__ZL_BLANK = 1;");
      return;
    }
    if (u.pathname === "/d/parent.js" || u.pathname === "/d/runtime.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("/* direct-arm asset */");
      return;
    }
    if (u.pathname === "/d/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(".zl { color: rgb(4, 4, 4); }");
      return;
    }
    if (u.pathname === "/d/img.png" || u.pathname === "/d/bg.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    /* Engine-arm fixtures: served when the engine's upstream fetches
       decode the rewritten srcdoc routes. */
    if (u.pathname === "/p/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(P_PAGE);
      return;
    }
    if (u.pathname === "/p/own.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.__ZL_P_OWN = 1;");
      return;
    }
    if (u.pathname === "/p/app.js" || u.pathname === "/p/mod.mjs") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.__CLS && (window.__CLS." + (u.pathname === "/p/app.js" ? "app" : "mod") + " = 1);");
      return;
    }
    if (u.pathname === "/p/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(".zl { color: rgb(5, 5, 5); }");
      return;
    }
    if (u.pathname === "/p/img.png" || u.pathname === "/p/bg.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    res.writeHead(404);
    res.end("no");
  });
  await new Promise((r) => srv.listen(FX_PORT, "127.0.0.1", r));
  return { srv, hits };
}

async function main() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  const { srv, hits } = await startFixture();

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
  const ua = await (await (await browser.newContext()).newPage()).evaluate(() => navigator.userAgent);
  console.log("srcdoc-clients: " + ua);
  console.log("srcdoc-clients: direct control (plain recording SW)");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(FX + "/d/page.html");
    for (let i = 0; i < 100; i++) {
      if (await page.evaluate(() => window.__ZL_READY)) break;
      await sleep(200);
    }
    if (!(await page.evaluate(() => window.__ZL_READY))) {
      await check("direct: SW claims the page", () => {
        throw new Error("controller never arrived");
      });
    } else {
      /* Parent sanity class + all child classes in one shot. */
      await page.evaluate(async (childHtml) => {
        await fetch("/d/parent.js");
        const f = document.createElement("iframe");
        f.id = "sd";
        f.srcdoc = childHtml;
        document.body.appendChild(f);
        /* about:blank control: a parent-written blank child. */
        const b = document.createElement("iframe");
        document.body.appendChild(b);
        b.contentDocument.write("<script src='/d/blank.js'></script>");
        b.contentDocument.close();
      }, D_CHILD);
      /* Let every class settle (loads succeed server-side). */
      await sleep(4000);
      const state = await page.evaluate(async () => {
        const f = document.getElementById("sd");
        const seen = await new Promise((res) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (ev) => res(ev.data);
          navigator.serviceWorker.controller.postMessage("zl-srcdoc-seen", [ch.port2]);
          setTimeout(() => res([]), 5000);
        });
        const cw = f.contentWindow;
        const nested = cw.document.querySelector("iframe");
        const im = cw.document.querySelector("img");
        let blank = null;
        for (const fr of document.querySelectorAll("iframe")) {
          if (fr !== f && fr.contentWindow && fr.contentWindow.__ZL_BLANK) blank = 1;
        }
        return {
          seen: seen.map((s) => s.replace(/^https?:\/\/[^/]+/, "")),
          cls: cw.__CLS,
          childCtrl: !!cw.navigator.serviceWorker.controller,
          nested: nested && nested.contentWindow ? nested.contentWindow.__ZL_NESTED : undefined,
          sheets: cw.document.styleSheets.length,
          img: im ? { w: im.naturalWidth, c: im.complete } : null,
          bgLoaded: getComputedStyle(cw.document.getElementById("bgel")).backgroundImage !== "none",
          blank,
        };
      });
      const seen = state.seen;
      const classes = ["/d/app.js", "/d/mod.mjs", "/d/style.css", "/d/img.png", "/d/bg.png", "/d/nested.js"];
      await check("direct: the SW sees the parent document's own fetch", () => {
        if (!seen.includes("/d/parent.js")) throw new Error("SW never saw the parent fetch; seen=" + JSON.stringify(seen));
        return "sanity class controlled";
      });
      await check("direct: every srcdoc parser class reaches the origin server (loads succeed)", () => {
        const missing = classes.filter((c) => !hits.includes(c));
        if (missing.length) throw new Error("server never saw: " + JSON.stringify(missing) + " hits=" + JSON.stringify(hits));
        return "all 6 classes served";
      });
      await check("direct: script, module, stylesheet, image, css-url classes all load in the child", () => {
        if (!state.cls) throw new Error("child state unavailable (contentWindow blocked?)");
        if (state.cls.app !== 1) throw new Error("app flag unset");
        if (state.cls.mod !== 1) throw new Error("module flag unset");
        if (state.sheets < 2) throw new Error("linked stylesheet not applied (styleSheets=" + state.sheets + ")");
        if (!state.img || state.img.w < 1) throw new Error("image not decoded");
        if (!state.bgLoaded) throw new Error("css url() background not applied");
        return "flags set";
      });
      await check("direct: srcdoc parser classes reach the SW fetch handler (Chromium 156 platform truth)", () => {
        const missed = classes.filter((c) => !seen.includes(c));
        if (missed.length) throw new Error("SW never saw parser classes (regressed to the crbug 41411856 state?): " + JSON.stringify(missed));
        return "the srcdoc child is an SW client; all 6 classes intercepted";
      });
      await check("direct: nested srcdoc script is intercepted and runs", () => {
        if (!seen.includes("/d/nested.js")) throw new Error("nested srcdoc request bypassed the SW");
        if (state.nested !== 1) throw new Error("nested script did not run");
        return "nested class intercepted";
      });
      await check("direct: child runtime fetch is intercepted by the SW", () => {
        if (!seen.includes("/d/runtime.js")) throw new Error("child runtime fetch bypassed the SW");
        if (state.cls && state.cls.runtime !== 200) throw new Error("runtime fetch status: " + state.cls.runtime);
        return "runtime class controlled";
      });
      await check("direct: about:blank document.write child still bypasses the SW (remaining class)", () => {
        if (seen.includes("/d/blank.js")) throw new Error("about:blank child request reached the SW (platform widened: update this suite)");
        if (!hits.includes("/d/blank.js")) throw new Error("about:blank control never hit the server");
        if (state.blank !== 1) throw new Error("about:blank child script never ran");
        return "about: opaque-client class remains uncontrolled";
      });
    }
    await ctx.close();
  }

  /* ================= Arm B: proxied control ================= */
  console.log("srcdoc-clients: proxied control (real engine)");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("PAGE-ERROR " + String(e).slice(0, 200)));
    await page.goto(ENGINE + "/?url=" + encodeURIComponent(FX + "/p/page.html"));
    /* The proxied page lives in a virtual frame under the engine route. */
    let frame = null;
    for (let i = 0; i < 120; i++) {
      frame = page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
      if (frame) break;
      await sleep(250);
    }
    if (!frame) {
      await check("proxied: virtual frame appears", () => {
        throw new Error("no " + ENGINE + "/j/ frame ever appeared");
      });
    } else {
      for (let i = 0; i < 120; i++) {
        const got = await frame.evaluate(() => ({
          own: window.__ZL_P_OWN,
          attr: document.getElementById("sd") ? document.getElementById("sd").getAttribute("srcdoc") : null,
        })).catch(() => null);
        if (got && got.own === 1 && got.attr) break;
        await sleep(250);
      }
      await sleep(4000);
      const st = await frame.evaluate(async () => {
        const f = document.getElementById("sd");
        if (!f) return { missing: true };
        const cw = f.contentWindow;
        const im = cw.document.querySelector("img");
        let probe = null;
        try {
          const r = await fetch(im.src);
          probe = [r.status, (await r.text()).length];
        } catch (e) {
          probe = "FETCH-ERR " + String(e);
        }
        return {
          attr: f.getAttribute("srcdoc"),
          cls: cw.__CLS,
          childCtrl: !!cw.navigator.serviceWorker.controller,
          sheets: cw.document.styleSheets.length,
          imgDecoded: im ? im.naturalWidth > 0 : false,
          probe,
        };
      });
      await check("proxied: the parent page's own subresource loads through the engine", async () => {
        const own = await frame.evaluate(() => window.__ZL_P_OWN);
        if (own !== 1) throw new Error("own.js never ran (parent path broken)");
        if (!hits.includes("/p/own.js")) throw new Error("fixture never saw own.js");
        return "controlled path works";
      });
      await check("proxied: the served srcdoc attribute carries engine routes only", () => {
        const a = st.attr || "";
        if (a.includes("7131")) throw new Error("fixture origin leaked in the served srcdoc: " + a.slice(0, 300));
        const routes = (a.match(/\/j\/[A-Za-z0-9_-]+/g) || []).length;
        if (routes < 4) throw new Error("expected at least 4 engine routes (app, mod, css, img), found " + routes + ": " + a.slice(0, 300));
        return routes + " engine routes";
      });
      await check("proxied: srcdoc child parser subresources are served through the engine pipeline", async () => {
        if (!st.cls) throw new Error("child state unavailable: " + JSON.stringify(st).slice(0, 400));
        if (st.cls.app !== 1) throw new Error("app.js never ran in the child (cls=" + JSON.stringify(st.cls) + ")");
        if (st.cls.mod !== 1) throw new Error("module script never ran");
        if (!st.imgDecoded) throw new Error("image not decoded through the engine");
        const wanted = ["/p/app.js", "/p/mod.mjs", "/p/img.png"];
        const missing = wanted.filter((w) => !hits.includes(w));
        if (missing.length) throw new Error("engine never fetched upstream: " + JSON.stringify(missing) + " hits=" + JSON.stringify(hits));
        return "child is an SW client; the SW decodes its routes and fetches upstream";
      });
      await check("proxied: srcdoc child reports a controller (client-bound pipeline)", () => {
        if (st.childCtrl !== true) throw new Error("child ctrl=" + st.childCtrl + " (uncontrolled: engine SW never claimed the srcdoc client)");
        return "controlled";
      });
      await check("proxied: an about:blank document.write child still bypasses (honest residual)", async () => {
        const obs = await frame.evaluate(async () => {
          /* Reuse a decoded route from the srcdoc attr as the probe URL. */
          const f = document.getElementById("sd");
          const m = /src=["']([^"']+)["']/.exec(f.getAttribute("srcdoc").match(/<img[^>]*>/)[0]);
          const b = document.createElement("iframe");
          document.body.appendChild(b);
          b.contentDocument.write("<script>window.__ZL_B_CHILD = { ctrl: !!navigator.serviceWorker.controller, probe: null };</script>");
          b.contentDocument.close();
          try {
            const r = await b.contentWindow.fetch(m[1]);
            return { ctrl: b.contentWindow.__ZL_B_CHILD.ctrl, probe: r.status };
          } catch (e) {
            return { ctrl: b.contentWindow.__ZL_B_CHILD ? b.contentWindow.__ZL_B_CHILD.ctrl : null, probe: "ERR " + String(e) };
          }
        });
        if (obs.ctrl === true) throw new Error("about:blank child is now controlled too (platform widened: update this suite)");
        if (obs.probe !== 404) throw new Error("about:blank child probe answered " + JSON.stringify(obs.probe) + " (expected static-server 404)");
        return "about:blank runtime fetch bypasses the SW and 404s on the static server";
      });
    }
    await ctx.close();
  }

  await browser.close();
  engineProc?.kill();
  srv.close();

  const fails = results.filter((r) => !r.ok).length;
  console.log("");
  console.log("srcdoc-clients: " + (results.length - fails) + " passed, " + fails + " failed");
  if (fails > 0) {
    console.log("HARNESS-ERROR srcdoc-clients suite failed");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.log("HARNESS-ERROR " + String(e?.stack ?? e));
  process.exit(1);
});
