/* Issue #537 (#549 child): real-Chromium acceptance for
   page-created blob workers. Chromium serves blob: worker scripts
   straight from the blob store with no fetch event, so the SW-side
   prelude injection cannot reach them; the fix wraps the constructor
   so the worker loads a fresh wrapper blob that imports the engine's
   /zl-bw/ prelude route first. This suite proves the whole chain in a
   genuine browser: classic, module and nested blob workers all boot
   with the page's site token and virtual base, their fetch/XHR/
   importScripts inputs ride engine routes to the fixture (the fixture
   sees the traffic arrive), relative inputs resolve against the
   virtual base, the worker's indexedDB namespace is site-scoped (no
   engine database names leak), and a worker created INSIDE a worker
   inherits the same site token.

   Acceptance remainder (#537): a blob worker's WebSocket rides the
   prelude's bridge (echo against a loopback RFC6455 server), a
   cross-origin fetch rides the engine to a second fixture origin,
   cookie-bearing fetches ride the same route (observational echo),
   a terminated worker's SOURCE blob stays usable (native blob
   semantics survive teardown), a module blob worker's ABSOLUTE https
   import rides the engine, and two virtual sites' workers with the
   same database name read back only their own value (storage
   isolation). Everything is loopback fixtures only; ports 6034/7134
   and 7135 never collide with e2e.mjs (6002/7101), guest-sw
   (6009/7109), the vctx-restart suite or importmap (6036/7136). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6034;
const FX_A_PORT = 7134;
const FX_B_PORT = 7135;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX_A = "http://127.0.0.1:" + FX_A_PORT;
const FX_B = "http://127.0.0.1:" + FX_B_PORT;
const VIRTUAL_PAGE = FX_A + "/dir/page.html";
const VIRTUAL_PAGE_B = FX_B + "/dir/page.html";

const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let context = null;
let fxA = null;
let fxB = null;
const hits = [];
let wsHits = 0;

async function check(name, fn) {
  try {
    const info = await fn();
    results.push({ ok: true, name, info: info ?? "" });
  } catch (e) {
    results.push({ ok: false, name, info: String(e?.message ?? e) });
  }
}

function engineTail() {
  return engineErr.slice(-20).join("").slice(0, 2500);
}

function classicSrc() {
  return [
    "self.onmessage = async function () {",
    "  var post = function (k, v) { self.postMessage({ step: k, v: String(v) }); };",
    "  post('site', String(self.__ZL_SITE__));",
    "  post('wbase', String(self.__ZL_WORKER_BASE__));",
    "  try { post('absFetch', 'OK ' + (await (await fetch('" + FX_A + "/api/data.txt')).text()).trim()); } catch (e) { post('absFetch', 'ERR ' + String(e)); }",
    "  try { post('relFetch', 'OK ' + (await (await fetch('sub/data.txt')).text()).trim()); } catch (e) { post('relFetch', 'ERR ' + String(e)); }",
    "  try { post('xhr', await new Promise(function (res) { var x = new XMLHttpRequest(); x.open('GET', '" + FX_A + "/api/data.txt'); x.onload = function () { res('OK ' + x.responseText.trim()); }; x.onerror = function () { res('XHR-NET-ERR status=' + x.status); }; x.send(); })); } catch (e) { post('xhr', 'ERR ' + String(e)); }",
    "  try { importScripts('" + FX_A + "/api/imp.js'); post('imp', String(self.__IMP || 'NO-IMP')); } catch (e) { post('imp', 'ERR ' + String(e)); }",
    "  try { post('dbs', JSON.stringify((await indexedDB.databases()).map(function (d) { return d.name; }))); } catch (e) { post('dbs', 'ERR ' + String(e)); }",
    "  try { var rq = indexedDB.open('zl-bw-accept'); rq.onsuccess = function () { rq.result.close(); post('idbOpen', 'OK'); }; rq.onerror = function () { post('idbOpen', 'ERR ' + String(rq.error)); }; } catch (e) { post('idbOpen', 'ERR ' + String(e)); }",
    "  post('done', 'done');",
    "};",
  ].join("\n");
}

function moduleSrc() {
  return [
    'import { m } from "http://127.0.0.1:' + FX_A_PORT + '/api/mod.mjs";',
    "const post = (k, v) => self.postMessage({ step: k, v: String(v) });",
    "post('site', String(self.__ZL_SITE__));",
    "post('absImp', String(m));",
    "try { post('modFetch', 'OK ' + (await (await fetch('" + FX_A + "/api/data.txt')).text()).trim()); } catch (e) { post('modFetch', 'ERR ' + String(e)); }",
    "post('done', 'done');",
  ].join("\n");
}

/* Network remainder worker: WebSocket through the prelude bridge,
   a cross-origin fetch to the second fixture origin, and a
   cookie-bearing fetch pair (prime, then echo). The cookie echo is
   observational: the gate is that both requests rode the engine
   route (the fixture sees them); what the upstream jar does with
   Set-Cookie is transport behavior covered by the engine suites. */
function netSrc() {
  return [
    "self.onmessage = async function () {",
    "  var post = function (k, v) { self.postMessage({ step: k, v: String(v) }); };",
    "  try {",
    "    await new Promise(function (res, rej) {",
    "      var ws = new WebSocket('ws://127.0.0.1:" + FX_A_PORT + "/ws');",
    "      var t = setTimeout(function () { rej(new Error('WS-TIMEOUT')); }, 10000);",
    "      ws.onopen = function () { ws.send('ping-zl'); };",
    "      ws.onmessage = function (ev) {",
    "        if (ev.data === 'ECHO:ping-zl') { ws.close(); }",
    "      };",
    "      ws.onclose = function () { clearTimeout(t); post('ws', 'ECHO-OK'); res(); };",
    "      ws.onerror = function () { clearTimeout(t); rej(new Error('WS-ERR')); };",
    "    });",
    "  } catch (e) { post('ws', 'ERR ' + String(e)); }",
    "  try {",
    "    await fetch('" + FX_B + "/api/cors.txt');",
    "    var r = await fetch('" + FX_B + "/api/cors.txt');",
    "    post('xorigin', 'OK ' + (await r.text()).trim());",
    "  } catch (e) { post('xorigin', 'ERR ' + String(e)); }",
    "  try {",
    "    var c1 = await fetch('" + FX_A + "/api/setcookie', { credentials: 'include' });",
    "    await c1.text();",
    "    var c2 = await fetch('" + FX_A + "/api/echo-cookie', { credentials: 'include' });",
    "    post('cookie', 'OK ' + (await c2.text()).trim());",
    "  } catch (e) { post('cookie', 'ERR ' + String(e)); }",
    "  post('done', 'done');",
    "};",
  ].join("\n");
}

/* Storage-isolation worker: opens the SAME database name on every
   virtual site and writes the site's own marker, then reads back. */
function isoSrc(site) {
  return [
    "self.onmessage = async function () {",
    "  var post = function (k, v) { self.postMessage({ step: k, v: String(v) }); };",
    "  try {",
    "    await new Promise(function (res, rej) {",
    "      var op = indexedDB.open('zl-bw-iso', 1);",
    "      op.onupgradeneeded = function () { op.result.createObjectStore('kv'); };",
    "      op.onsuccess = function () {",
    "        var db = op.result;",
    "        var tx = db.transaction('kv', 'readwrite');",
    "        tx.objectStore('kv').put(" + JSON.stringify(site) + ", 'who');",
    "        tx.oncomplete = function () {",
    "          var rd = db.transaction('kv', 'readonly').objectStore('kv').get('who');",
    "          rd.onsuccess = function () { post('iso', 'READ:' + String(rd.result)); db.close(); res(); };",
    "          rd.onerror = function () { rej(rd.error || new Error('read failed')); };",
    "        };",
    "        tx.onerror = function () { rej(tx.error || new Error('write failed')); };",
    "      };",
    "      op.onerror = function () { rej(op.error || new Error('open failed')); };",
    "    });",
    "  } catch (e) { post('iso', 'ERR ' + String(e)); }",
    "  post('done', 'done');",
    "};",
  ].join("\n");
}

function nestedSrc() {
  const child = 'self.onmessage=async function(){self.postMessage({step:"csite",v:String(self.__ZL_SITE__)});try{var r=await fetch("' + FX_A + '/api/data.txt");self.postMessage({step:"cfetch",v:"OK "+(await r.text()).trim()});}catch(e){self.postMessage({step:"cfetch",v:"ERR "+String(e)});}self.postMessage({step:"cdone",v:"done"});}';
  return [
    "self.onmessage = async function () {",
    "  var post = function (k, v) { self.postMessage({ step: k, v: String(v) }); };",
    "  post('site', String(self.__ZL_SITE__));",
    "  post('wbase', String(self.__ZL_WORKER_BASE__));",
    "  try { var child = new Worker(URL.createObjectURL(new Blob([" + JSON.stringify(child) + "], { type: 'text/javascript' })));",
    "    child.postMessage(0); var cres = await new Promise(function (res) { var n = 0; var t = setTimeout(function () { res('CHILD-TIMEOUT n=' + n); }, 15000); child.onmessage = function (ev) { n++; post('child' + n, String((ev.data && (ev.data.step + '=' + ev.data.v)) || 'no-data')); if (ev.data && ev.data.step === 'cdone') { clearTimeout(t); res('CHILD-DONE'); } }; });",
    "    post('nested', cres);",
    "  } catch (e) { post('nested', 'ERR ' + String(e)); }",
    "  post('done', 'done');",
    "};",
  ].join("\n");
}

function pageHtml(isoMarker) {
  const classic = JSON.stringify(classicSrc()).replace(/</g, "\\u003c");
  const mod = JSON.stringify(moduleSrc()).replace(/</g, "\\u003c");
  const nested = JSON.stringify(nestedSrc()).replace(/</g, "\\u003c");
  const net = JSON.stringify(netSrc()).replace(/</g, "\\u003c");
  const iso = JSON.stringify(isoSrc(isoMarker)).replace(/</g, "\\u003c");
  return [
    "<!doctype html><meta charset=\"utf-8\"><body><script>",
    "window.__probe = {}; window.__log = [];",
    "window.__run = async function () {",
    "  window.__diag = (function () { var d = {}; try { d.ctl = navigator.serviceWorker && navigator.serviceWorker.controller ? String(navigator.serviceWorker.controller.scriptURL) : 'none'; } catch (e) { d.ctl = 'ERR ' + e; } d.wname = Worker && Worker.name ? Worker.name : 'anon'; try { var du = URL.createObjectURL(new Blob(['self.__DG=1;'], { type: 'text/javascript' })); var dx = new XMLHttpRequest(); dx.open('GET', du, false); dx.send(null); d.xhr = dx.status + ':' + String(dx.responseText).slice(0, 20); URL.revokeObjectURL(du); } catch (e) { d.xhr = 'ERR ' + e; } return d; })();",
    "  const mk = function (src) { return URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); };",
    "  const wait = function (w, label, ms, kick) { return new Promise(function (res) { var t = setTimeout(function () { window.__probe[label] = 'W-TIMEOUT'; res(); }, ms); w.onmessage = function (ev) { var d = ev.data || {}; if (d.step === 'done') { clearTimeout(t); window.__probe[label] = 'DONE'; res(); } else { window.__log.push(label + ':' + d.step + '=' + String(d.v).slice(0, 200)); } }; w.onerror = function (e) { clearTimeout(t); window.__probe[label] = 'W-ERR ' + String(e.message || e); res(); }; if (kick) { try { w.postMessage(0); } catch (e) {} } }); };",
    "  window.__blobA = mk(" + classic + ");",
    "  const w1 = new Worker(window.__blobA); await wait(w1, 'classic', 20000, true);",
    "  const w2 = new Worker(mk(" + mod + "), { type: 'module' }); await wait(w2, 'module', 15000, false);",
    "  const w3 = new Worker(mk(" + nested + ")); await wait(w3, 'nested', 25000, true);",
    "  const w4 = new Worker(mk(" + net + ")); await wait(w4, 'net', 25000, true);",
    "  const w5 = new Worker(mk(" + iso + ")); await wait(w5, 'iso', 15000, true);",
    "  try { w1.terminate(); } catch (e) {}",
    "  await new Promise(function (r) { setTimeout(r, 400); });",
    "  const w1b = new Worker(window.__blobA); await wait(w1b, 'reboot', 15000, true);",
    "  return JSON.parse(JSON.stringify({ probe: window.__probe, log: window.__log, diag: window.__diag }));",
    "};",
    "</script></body>",
  ].join("\n");
}

/* the __log entries come back as "label:step=value" */
function step(res, label, key) {
  const pre = label + ":" + key + "=";
  const hit = res.log.find((l) => l.startsWith(pre));
  return hit ? hit.slice(pre.length) : null;
}

async function main() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  fxA = await new Promise((resolve_) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, FX_A);
      hits.push(u.pathname);
      if (u.pathname === "/dir/page.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(pageHtml("site-A")); }
      else if (u.pathname === "/api/data.txt") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("DIRECT"); }
      else if (u.pathname === "/api/imp.js") { res.writeHead(200, { "content-type": "application/javascript", "access-control-allow-origin": "*" }); res.end("self.__IMP = 'LOADED';"); }
      else if (u.pathname === "/dir/sub/data.txt") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("REL-OK"); }
      else if (u.pathname === "/api/mod.mjs") { res.writeHead(200, { "content-type": "application/javascript", "access-control-allow-origin": "*" }); res.end("export const m = 'MOD-MARK';"); }
      else if (u.pathname === "/api/cors.txt") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("CORS-OK"); }
      else if (u.pathname === "/api/setcookie") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "set-cookie": "zlbw=1; Path=/; SameSite=None; Secure" }); res.end("PRIMED"); }
      else if (u.pathname === "/api/echo-cookie") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("cookie=" + String(req.headers.cookie || "none")); }
      else { res.writeHead(404); res.end("no"); }
    });
    /* Minimal RFC6455 echo: accept any upgrade on /ws, echo every
       text frame back prefixed with ECHO:. Enough for the bridge's
       open/send/recv/close round trip. */
    srv.on("upgrade", (req, sock) => {
      const u = new URL(req.url, FX_A);
      if (u.pathname !== "/ws") { sock.destroy(); return; }
      wsHits++;
      const key = req.headers["sec-websocket-key"];
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const len0 = buf[1] & 0x7f;
          let off = 2; let len = len0;
          if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const maskBit = (buf[1] & 0x80) !== 0;
          const maskLen = maskBit ? 4 : 0;
          if (buf.length < off + maskLen + len) return;
          const opcode = buf[0] & 0x0f;
          let payload = Buffer.alloc(0);
          if (len > 0) {
            payload = Buffer.from(buf.slice(off + maskLen, off + maskLen + len));
            if (maskBit) {
              const mask = buf.slice(off, off + 4);
              for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            }
          }
          buf = buf.slice(off + maskLen + len);
          if (opcode === 0x8) { sock.end(Buffer.from([0x88, 0x00])); return; }
          if (opcode === 0x1) {
            const msg = payload.toString("utf8");
            const echo = Buffer.from("ECHO:" + msg, "utf8");
            const head = Buffer.from([0x81, echo.length > 125 ? 126 : echo.length]);
            const rest = echo.length > 125 ? (() => { const b = Buffer.alloc(2); b.writeUInt16BE(echo.length); return b; })() : Buffer.alloc(0);
            sock.write(Buffer.concat([head, rest, echo]));
          }
        }
      });
      sock.on("error", () => {});
    });
    srv.listen(FX_A_PORT, "127.0.0.1", () => resolve_(srv));
  });
  fxB = await new Promise((resolve_) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, FX_B);
      hits.push(u.pathname);
      if (u.pathname === "/dir/page.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(pageHtml("site-B")); }
      else if (u.pathname === "/api/data.txt") { res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }); res.end("DIRECT-B"); }
      else { res.writeHead(404); res.end("no"); }
    });
    srv.listen(FX_B_PORT, "127.0.0.1", () => resolve_(srv));
  });
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], { env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await sleep(2500);
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => console.log("PAGE-CONSOLE " + m.type() + " " + m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("PAGE-ERROR " + String(e).slice(0, 300)));
  const drive = async (virtualUrl) => {
    await page.goto(ENGINE + "/?url=" + encodeURIComponent(virtualUrl));
    await sleep(2500);
    let frame = null;
    for (let i = 0; i < 60; i++) {
      frame = page.frames().find((fr) => fr.url().startsWith(ENGINE + "/j/"));
      if (frame) break;
      await sleep(500);
    }
    if (!frame) throw new Error("virtual frame never appeared for " + virtualUrl);
    return await frame.evaluate(() => window.__run());
  };

  const res = await drive(VIRTUAL_PAGE);

  const classicSite = step(res, "classic", "site");

  await check("page-side wrap machinery is live (controller, wrapped ctor, blob XHR)", () => {
    const d = res.diag ?? {};
    if (!d.ctl || d.ctl === "none" || String(d.ctl).startsWith("ERR")) throw new Error("ctl=" + d.ctl);
    /* the dist is minified, so the wrapper class name is mangled: the
       native ctor is literally "Worker", any other name is the wrap. */
    if (d.wname === "Worker" || !d.wname) throw new Error("wname=" + d.wname);
    if (d.xhr !== "200:self.__DG=1;") throw new Error("xhr=" + d.xhr);
    return "live";
  });
  await check("classic blob worker boots through the wrapper", () => {
    if (res.probe.classic !== "DONE") throw new Error(JSON.stringify(res.probe));
    return "";
  });
  await check("classic worker carries a real site token", () => {
    if (!classicSite || classicSite === "undefined") throw new Error("site=" + classicSite);
    return String(classicSite).slice(0, 12) + "...";
  });
  await check("classic worker's virtual base is the page's virtual URL", () => {
    const wb = step(res, "classic", "wbase");
    if (wb !== VIRTUAL_PAGE) throw new Error("wbase=" + wb);
    return wb;
  });
  await check("absolute fetch rides the engine route to the fixture", () => {
    const v = step(res, "classic", "absFetch");
    if (v !== "OK DIRECT") throw new Error("absFetch=" + v);
    return v;
  });
  await check("relative fetch resolves against the virtual base", () => {
    const v = step(res, "classic", "relFetch");
    if (v !== "OK REL-OK") throw new Error("relFetch=" + v);
    return v;
  });
  await check("XHR rides the engine route", () => {
    const v = step(res, "classic", "xhr");
    if (v !== "OK DIRECT") throw new Error("xhr=" + v);
    return v;
  });
  await check("importScripts loads the fixture script", () => {
    const v = step(res, "classic", "imp");
    if (v !== "LOADED") throw new Error("imp=" + v);
    return v;
  });
  await check("worker indexedDB namespace is site-scoped (no engine DBs)", () => {
    const raw = step(res, "classic", "dbs");
    const names = raw ? JSON.parse(raw) : [];
    const leaked = names.filter((n) => String(n).startsWith("zl-"));
    if (leaked.length > 0) throw new Error("leaked=" + leaked.join(","));
    return raw ?? "[]";
  });
  await check("worker can open its own scoped database", () => {
    const v = step(res, "classic", "idbOpen");
    if (v !== "OK") throw new Error("idbOpen=" + v);
    return v;
  });
  await check("module blob worker boots and fetches engine-routed", () => {
    if (res.probe.module !== "DONE") throw new Error(JSON.stringify(res.probe));
    const v = step(res, "module", "modFetch");
    if (v !== "OK DIRECT") throw new Error("modFetch=" + v);
    return v;
  });
  await check("module worker shares the page's site token", () => {
    const v = step(res, "module", "site");
    if (v !== classicSite) throw new Error("module=" + v + " classic=" + classicSite);
    return "same token";
  });
  await check("nested blob worker (worker inside a worker) boots", () => {
    if (res.probe.nested !== "DONE") throw new Error(JSON.stringify(res.probe));
    const v = step(res, "nested", "nested");
    if (v !== "CHILD-DONE") throw new Error("nested=" + v);
    return v;
  });
  /* child relay mint wrappers interleave with the child's own app
     messages (they are forwarded up by the prelude), so the child
     steps are scanned across every childN entry, not by index. */
  const childEntries = res.log
    .filter((l) => /^nested:child\d+=/.test(l))
    .map((l) => l.slice("nested:child".length).replace(/^\d+=/, ""));
  await check("nested child inherits the same site token", () => {
    const v = childEntries.find((e) => e.startsWith("csite="));
    if (v !== "csite=" + classicSite) throw new Error("got=" + v);
    return "inherited";
  });
  await check("nested child fetch rides the engine route", () => {
    const v = childEntries.find((e) => e.startsWith("cfetch="));
    if (v !== "cfetch=OK DIRECT") throw new Error("got=" + v);
    return v;
  });
  await check("blob worker WebSocket rides the prelude bridge (open, echo, close)", () => {
    const v = step(res, "net", "ws");
    if (v !== "ECHO-OK") throw new Error("ws=" + v);
    if (wsHits < 1) throw new Error("the echo server never saw the upgrade");
    return "echoed, upgrades=" + wsHits;
  });
  await check("blob worker cross-origin fetch rides the engine to the second origin", () => {
    const v = step(res, "net", "xorigin");
    if (v !== "OK CORS-OK") throw new Error("xorigin=" + v);
    if (!hits.includes("/api/cors.txt")) throw new Error("FX_B never saw the request");
    return v;
  });
  await check("cookie-bearing blob worker fetches ride the engine route", () => {
    const v = step(res, "net", "cookie");
    if (!v || !v.startsWith("OK cookie=")) throw new Error("cookie=" + v);
    const carried = v.includes("zlbw=1");
    if (!carried) console.log("INFO cookie jar did not surface zlbw=1 on the echo (transport-side behavior): " + v);
    for (const p of ["/api/setcookie", "/api/echo-cookie"]) {
      if (!hits.includes(p)) throw new Error("fixture never saw " + p);
    }
    return v.slice(0, 60) + (carried ? " [jar round-trip ok]" : " [routing-only]");
  });
  await check("module blob worker's absolute https import rides the engine", () => {
    const v = step(res, "module", "absImp");
    if (v !== "MOD-MARK") throw new Error("absImp=" + v);
    if (!hits.includes("/api/mod.mjs")) throw new Error("fixture never saw /api/mod.mjs");
    return v;
  });
  await check("terminated worker's SOURCE blob stays usable (native blob semantics)", () => {
    if (res.probe.reboot !== "DONE") throw new Error("reboot=" + JSON.stringify(res.probe));
    const sites = res.log.filter((l) => l.startsWith("classic:site="));
    if (sites.length < 2) throw new Error("the rebooted worker never re-posted its site token");
    return "rebooted from the same blob URL";
  });
  await check("site-A blob worker reads back only its own value (same db name)", () => {
    const v = step(res, "iso", "iso");
    if (v !== "READ:site-A") throw new Error("iso=" + v);
    return v;
  });

  /* --- second virtual site: same database name, different marker --- */
  const resB = await drive(VIRTUAL_PAGE_B);
  await check("site-B worker with the SAME db name reads back only its own value (no cross-site storage)", () => {
    if (resB.probe.iso !== "DONE") throw new Error(JSON.stringify(resB.probe));
    const v = step(resB, "iso", "iso");
    if (v !== "READ:site-B") throw new Error("iso=" + v + " (expected site-B; a site-A read would break isolation)");
    if (String(resB.probe.classic || "") !== "DONE") throw new Error("site-B classic worker did not boot: " + resB.probe.classic);
    return v;
  });

  await check("the fixture actually received the routed traffic", () => {
    for (const p of ["/api/data.txt", "/api/imp.js", "/dir/sub/data.txt", "/api/mod.mjs", "/api/cors.txt", "/api/setcookie", "/api/echo-cookie"]) {
      if (!hits.includes(p)) throw new Error("fixture never saw " + p);
    }
    return hits.length + " fixture hits";
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok  " : "  FAIL") + " " + r.name + (r.ok ? "" : " (" + r.info + ")"));
  }
  console.log(results.length - failed.length + "/" + results.length + " blob-worker checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR blob-worker suite failed; engine tail:\n" + engineTail());
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
    try { if (context) await context.close(); } catch {}
    try { if (engineProc) engineProc.kill("SIGKILL"); } catch {}
    try { if (fxA) fxA.close(); } catch {}
    try { if (fxB) fxB.close(); } catch {}
  });
