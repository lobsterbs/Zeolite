/* Issue #551 second slice: real-Chromium acceptance for privacy-safe
   cosmetic filtering. The build pins the filter-list origin to a
   loopback fixture (VITE_ZL_LISTS_ORIGIN=http://127.0.0.1:7305), so
   the wasm arm loads a pinned list and every check is deterministic:
   static hostname rules hidden at head splice, generic class rules
   hidden by the page runtime's token loop, late-inserted elements
   hidden by the MutationObserver arm, exception hosts left visible,
   scriptlets refused under the wasm arm, the per-site adblock:false
   override disabling both arms, network blocking still working, the
   host page untouched, and oversized page token queries bounded
   without wedging. Ports 6051/7151/7152/7305 never collide with
   e2e.mjs (6002/7101), sri.mjs (6041/7141) or the parallel agents'
   engine instances on this host. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6051;
const FXA_PORT = 7151;
const FXB_PORT = 7152;
const LISTS_PORT = 7305;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FXA = "http://127.0.0.1:" + FXA_PORT;
const FXB = "http://127.0.0.2:" + FXB_PORT;
const LISTS_PATH = "/ghostery/adblocker/master/packages/adblocker/assets/";

/* The pinned list: a network floor above the #500 sanity minimum,
   the doubleclick canary, one path-anchored network rule for the
   block check, the cosmetic coverage set, and one allowlisted plus
   one foreign scriptlet for the refusal counts. The SAME body
   serves every list URL; the wasm engine deduplicates. */
function pinnedList() {
  const lines = [
    "! Title: zeolite e2e pinned cosmetic list",
    "||doubleclick.net^",
    "/adframe.js^",
  ];
  for (let i = 0; i < 1200; i++) lines.push("||pad" + i + ".invalid^");
  lines.push(
    "127.0.0.1##.zl-ad-host",
    "127.0.0.2##.zl-ad-host",
    "127.0.0.2#@#.zl-ad-host",
    "##.zl-generic-ad",
    "##.zl-late-ad",
    "127.0.0.1##+js(set-constant, zlE2EConst, 42)",
  );
  return lines.join("\n") + "\n";
}

function fixtureHtml(generic) {
  const late =
    "setTimeout(function () {" +
    "  var d = document.createElement('div');" +
    "  d.className = 'zl-late-ad'; d.id = 'latead';" +
    "  document.body.appendChild(d);" +
    "}, 1500);";
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    '<script src="/cos/adframe.js"></script>' +
    '<script src="/cos/ctl.js"></script>' +
    "</head><body>" +
    '<div id="zl-marker"></div>' +
    '<div class="zl-ad-host" id="staticad">ad</div>' +
    (generic ? '<div class="zl-generic-ad" id="genericad">generic</div>' : "") +
    "<script>" + late + "</script>" +
    "</body></html>"
  );
}

let engineProc = null;
let browser = null;
let fxa = null;
let fxb = null;
let lists = null;
const engineErr = [];

function engineTail() {
  return engineErr.slice(-25).join("");
}

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timeout waiting for " + what);
    await sleep(400);
  }
}

async function hostControl(pg, message, timeoutMs = 8000) {
  return await pg.evaluate(({ message, timeoutMs }) => new Promise((resolve_) => {
    const ctl = navigator.serviceWorker.controller;
    if (!ctl) return resolve_({ ok: false, error: "no controller" });
    const ch = new MessageChannel();
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ch.port1.onmessage = null;
      resolve_(value);
    };
    timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    ch.port1.onmessage = (e) => finish(e.data);
    try {
      ctl.postMessage(message, [ch.port2]);
    } catch {
      finish({ ok: false, error: "postMessage failed" });
    }
  }), { message, timeoutMs });
}

async function openProxied(ctx, target) {
  const pg = await ctx.newPage();
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  let frame = null;
  frame = await waitFor("proxied frame for " + target, 45000, async () => {
    const f = pg.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
    if (!f) return null;
    if ((await f.locator("#zl-marker").count()) > 0) return f;
    return null;
  });
  return { page: pg, frame };
}

async function visibleNow(frame, sel) {
  return await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return getComputedStyle(el).display !== "none";
  }, sel);
}

async function hiddenWithStyle(frame, sel) {
  return await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    if (getComputedStyle(el).display !== "none") return false;
    const style = el.ownerDocument.querySelector("style[data-zl-cosmetic]");
    if (style && style.textContent.includes(sel.slice(1))) return "static";
    const dyn = el.ownerDocument.querySelector("style[data-zl-cosmetic-dyn]");
    if (dyn && dyn.textContent.includes(sel.slice(1))) return "dyn";
    return false;
  }, sel);
}

async function main() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  const listBody = pinnedList();
  lists = await new Promise((r) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1:" + LISTS_PORT);
      if (u.pathname.startsWith(LISTS_PATH)) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(listBody);
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    srv.listen(LISTS_PORT, "127.0.0.1", () => r(srv));
  });
  const fixture = (html) => (req, res) => {
    const u = new URL(req.url, "http://fixture.invalid");
    if (u.pathname === "/cos/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    } else if (u.pathname === "/cos/adframe.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.zlAdLoaded = 1;");
    } else if (u.pathname === "/cos/ctl.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.zlCtlLoaded = 1;");
    } else {
      res.writeHead(404);
      res.end("no");
    }
  };
  fxa = await new Promise((r) => {
    const srv = createServer(fixture(fixtureHtml(true)));
    srv.listen(FXA_PORT, "127.0.0.1", () => r(srv));
  });
  fxb = await new Promise((r) => {
    const srv = createServer(fixture(fixtureHtml(false)));
    srv.listen(FXB_PORT, "127.0.0.2", () => r(srv));
  });
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
  const ctx = await browser.newContext();

  /* The matcher loads lazily behind the #577 idle gate; reload until
     the static arm proves the wasm list landed. */
  let opened = await openProxied(ctx, FXA + "/cos/page.html");
  for (let i = 0; i < 20; i++) {
    if (await hiddenWithStyle(opened.frame, ".zl-ad-host")) break;
    await sleep(2500);
    await opened.page.reload();
    opened.frame = await waitFor("proxied frame after reload", 45000, async () => {
      const f = opened.page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
      return f && (await f.locator("#zl-marker").count()) > 0 ? f : null;
    });
  }

  const results = [];
  const check = (name, fn) =>
    fn()
      .then(() => ({ name, ok: true, info: "" }))
      .catch((e) => ({ name, ok: false, info: String(e?.message ?? e) }));

  results.push(
    await check("static hostname rule hidden at head splice", async () => {
      const how = await hiddenWithStyle(opened.frame, ".zl-ad-host");
      if (how !== "static") throw new Error("static arm verdict: " + String(how));
    }),
  );

  results.push(
    await check("generic class rule hidden by the token loop", async () => {
      const how = await waitFor("generic hide", 15000, () => hiddenWithStyle(opened.frame, ".zl-generic-ad"));
      if (how !== "dyn") throw new Error("generic arm verdict: " + String(how));
    }),
  );

  results.push(
    await check("late-inserted element hidden by the observer loop", async () => {
      const how = await waitFor("late hide", 15000, () => hiddenWithStyle(opened.frame, ".zl-late-ad"));
      if (how !== "dyn") throw new Error("observer arm verdict: " + String(how));
    }),
  );

  results.push(
    await check("scriptlets refused under the wasm arm", async () => {
      const constant = await opened.frame.evaluate(() => window.zlE2EConst === undefined);
      if (!constant) throw new Error("zlE2EConst was set: a scriptlet executed");
      const diag = await hostControl(opened.page, { type: "zl:getDiag", since: 0 }, 10000);
      const row = (diag.events ?? []).find((e) => String(e.message).includes("wasm arm refuses scriptlets"));
      if (!row) throw new Error("no wasm-arm scriptlet refusal DIAG row: " + JSON.stringify(diag).slice(0, 300));
    }),
  );

  results.push(
    await check("network blocking still works alongside cosmetics", async () => {
      const probe = await opened.frame.evaluate(() => ({
        ad: window.zlAdLoaded === undefined,
        ctl: window.zlCtlLoaded === 1,
      }));
      if (!probe.ad) throw new Error("/adframe.js was NOT blocked");
      if (!probe.ctl) throw new Error("control script was blocked or did not load");
    }),
  );

  results.push(
    await check("per-site adblock:false override disables both arms; restore re-enables", async () => {
      await hostControl(opened.page, { type: "zl:rules", rules: [{ host: "127.0.0.1", adblock: false }] });
      const over = await openProxied(ctx, FXA + "/cos/page.html");
      const noStatic = await over.frame.evaluate(() => {
        const styles = document.querySelectorAll("style[data-zl-cosmetic]").length;
        const runs = document.querySelectorAll("script[data-zl-cosmetic-run]").length;
        return styles === 0 && runs === 0;
      });
      const visible = await visibleNow(over.frame, "#staticad");
      if (!noStatic) throw new Error("cosmetic artifacts still injected under adblock:false");
      if (!visible) throw new Error("static ad hidden despite adblock:false");
      await over.page.close();
      await hostControl(opened.page, { type: "zl:rules", rules: [] });
      const back = await openProxied(ctx, FXA + "/cos/page.html");
      const how = await waitFor("restored static arm", 15000, () => hiddenWithStyle(back.frame, ".zl-ad-host"));
      if (how !== "static") throw new Error("static arm did not return after restore: " + String(how));
      await back.page.close();
    }),
  );

  results.push(
    await check("exception host keeps its element visible", async () => {
      const ex = await openProxied(ctx, FXB + "/cos/page.html");
      const visible = await visibleNow(ex.frame, "#staticad");
      const staticTag = await ex.frame.evaluate(() => {
        const s = document.querySelector("style[data-zl-cosmetic]");
        return s ? s.textContent : "";
      });
      await ex.page.close();
      if (!visible) throw new Error("exception-suppressed element was hidden");
      if (staticTag.includes(".zl-ad-host")) throw new Error("selector leaked into the exception host's styles");
    }),
  );

  results.push(
    await check("the host page carries no cosmetic artifacts", async () => {
      const host = await ctx.newPage();
      await host.goto(ENGINE + "/");
      const clean = await host.evaluate(
        () =>
          document.querySelectorAll("[data-zl-cosmetic],[data-zl-cosmetic-run],[data-zl-cosmetic-dyn]")
            .length === 0,
      );
      await host.close();
      if (!clean) throw new Error("host page carries cosmetic artifacts");
    }),
  );

  results.push(
    await check("oversized token queries are bounded and do not wedge the arm", async () => {
      const verdict = await opened.frame.evaluate(
        () =>
          new Promise((resolve_) => {
            const big = [];
            for (let i = 0; i < 20000; i++) big.push("c" + i);
            const ctl = navigator.serviceWorker.controller;
            const ch = new MessageChannel();
            const timer = setTimeout(() => resolve_("timeout"), 8000);
            ch.port1.onmessage = (e) => {
              clearTimeout(timer);
              resolve_(JSON.stringify({ ok: e.data && e.data.ok, styles: typeof (e.data && e.data.styles) }));
            };
            ctl.postMessage({ type: "zl:cosmeticTokens", classes: big, ids: big }, [ch.port2]);
          }),
      );
      const parsed = JSON.parse(verdict);
      if (parsed.ok !== true || parsed.styles !== "string") {
        throw new Error("oversized query wedged: " + verdict);
      }
      const again = await opened.frame.evaluate(
        () =>
          new Promise((resolve_) => {
            const ctl = navigator.serviceWorker.controller;
            const ch = new MessageChannel();
            const timer = setTimeout(() => resolve_("timeout"), 8000);
            ch.port1.onmessage = (e) => {
              clearTimeout(timer);
              resolve_(e.data && e.data.ok === true ? "ok" : "bad");
            };
            ctl.postMessage({ type: "zl:cosmeticTokens", classes: ["zl-ad-host"], ids: [] }, [ch.port2]);
          }),
      );
      if (again !== "ok") throw new Error("arm wedged after the oversized query: " + again);
    }),
  );

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok  " : "  FAIL") + " " + r.name + (r.ok ? "" : " (" + r.info + ")"));
  }
  console.log(results.length - failed.length + "/" + results.length + " cosmetics checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR cosmetics suite failed; engine tail:\n" + engineTail());
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.log("HARNESS-ERROR " + String(e?.message ?? e));
    console.log("engine tail:\n" + engineTail());
    process.exitCode = 1;
  })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch {}
    try { if (engineProc) engineProc.kill("SIGKILL"); } catch {}
    try { if (fxa) fxa.close(); } catch {}
    try { if (fxb) fxb.close(); } catch {}
    try { if (lists) lists.close(); } catch {}
  });
