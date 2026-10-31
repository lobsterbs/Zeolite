/* Computed-URL sink suite (#525): direct-vs-proxied differential
   acceptance for runtime-computed URL operands. Every case builds a
   URL at RUNTIME (concatenation, template substitution, conditional,
   new URL with a computed base) and feeds it to a browser URL sink
   (fetch, dynamic import, element property, Worker, module Worker,
   WebSocket, postMessage targetOrigin). The suite runs the fixture
   page DIRECT first, then through the engine proxy, and asserts:
   1. every case settles with the same observable value in both modes
      (the value is upstream-echoed, so it must be engine-independent);
   2. the upstream hit sets are identical across modes: the final
      upstream destination, including the query string, is exactly
      what #525's acceptance criteria demand;
   3. an ordinary URL-shaped configuration string that no sink
      consumes stays byte-identical in page-observed script state.
   Conventions mirror e2e.mjs/guest-sw.mjs: zeolite-server on
   127.0.0.1:6023, fixture on 7123, marker-based proxied frame
   discovery, ZL_STATIC for the served bundle, exit 1 on any FAIL. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6023;
const FX_PORT = 7123;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX = "http://127.0.0.1:" + FX_PORT;
const STATIC = process.env.ZL_STATIC ?? resolve("app/dist");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let hits = [];
const echo = (u) => JSON.stringify({ path: u.pathname + u.search });

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const MOD = (name) => "export default '" + name + "-ok';";
const PAGE_CASES = 17;

const PAGE = [
  "<!doctype html><html><body><p id='pm'>cs-marker</p>",
  "<script>",
  "window.__r = {};",
  "function rec(n, p){ return p.then(function(v){window.__r[n]={ok:true,val:v};},function(e){window.__r[n]={ok:false,err:String(e && e.message || e)};}); }",
  "function j(r){ return r.text().then(function(t){ try { return JSON.parse(t).path; } catch(e){ return 'BAD:'+t.slice(0,60); } }); }",
  "rec('fetchRelConcat', fetch('api/rel' + '').then(j));",
  "rec('fetchTplQuery', fetch(\`/api/tpl?\${'q=1'}\`).then(j));",
  "rec('fetchCond', fetch(true ? '/api/cond?a=1' : '/api/nope').then(j));",
  "rec('newUrlBaseUri', (function(){ var u = new URL('./api/base?b=2' + '', document.baseURI); return fetch(u).then(j); })());",
  "rec('dynImportRoot', import('/mods/root.js' + '').then(function(m){return m.default;}));",
  "rec('dynImportRel', import('./mods/rel.js' + '').then(function(m){return m.default;}));",
  "rec('dynImportTpl', import(\`./mods/\${'tpl.js'}\`).then(function(m){return m.default;}));",
  "rec('dynImportQuery', import('/mods/q.js?x=9' + '').then(function(m){return m.default;}));",
  "rec('imgPropComputed', new Promise(function(res, rej){ var i = new Image(); i.onload = function(){ res('loaded'); }; i.onerror = function(){ rej(new Error('img error')); }; i.src = './img/pic.png' + ''; }));",
  "rec('classicWorker', new Promise(function(res, rej){ var w = new Worker('./w.js' + ''); w.onmessage = function(e){ res(e.data && e.data.dep); }; w.onerror = function(e){ rej(new Error('worker err ' + (e.message || ''))); }; }));",
  "rec('moduleWorker', new Promise(function(res, rej){ var w = new Worker('/mw.js' + '', {type: 'module'}); w.onmessage = function(e){ res(e.data && e.data.dep2); }; w.onerror = function(e){ rej(new Error('worker err ' + (e.message || ''))); }; }));",
  "rec('wsEcho', new Promise(function(res, rej){ try { var s = new WebSocket('ws://127.0.0.1:" + FX_PORT + "/ws' + ''); var done = false; s.onopen = function(){ s.send('hi'); }; s.onmessage = function(ev){ if (done) return; done = true; try { res(String(ev.data)); } catch (e) { res('opaque'); } }; s.onerror = function(){ rej(new Error('ws error')); }; setTimeout(function(){ if (!done) rej(new Error('ws timeout')); }, 12000); } catch (e) { rej(e); } }));",
  "window.addEventListener('message', function(ev){ if (ev.data === 'cs-ping') { window.__r.postMsgTarget = { ok: true, val: 'delivered' }; } });",
  "try { window.postMessage('cs-ping', new URL('.', location.href).origin + ''); window.__r.postMsgSent = { ok: true, val: 'sent' }; } catch (e) { window.__r.postMsgSent = { ok: false, err: String(e) }; }",
  "var cfg = '/api/notafetch' + '';",
  "window.__r.cfgUnchanged = { ok: cfg === '/api/notafetch', val: cfg };",
  "window.__r.baseUriShape = { ok: true, val: String(document.baseURI).slice(0, 120) };",
  "<" + "/script>",
  "<script type='module'>",
  "(async function(){ try {",
  "  const u = new URL('./res.json?m=3' + '', import.meta.url);",
  "  const t = await (await fetch(u)).text();",
  "  window.__r.metaUrlInline = { ok: true, val: JSON.parse(t).path };",
  "} catch (e) { window.__r.metaUrlInline = { ok: false, err: String(e) }; } })();",
  "<" + "/script>",
  "</body></html>",
].join("\n");

const W_CLASSIC = "importScripts('./dep.js' + ''); postMessage({ dep: globalThis.DEP });";
const DEP_CLASSIC = "globalThis.DEP = 'dep-ok';";
const W_MODULE = [
  "try {",
  "  const m = await import('./dep2.js' + '');",
  "  postMessage({ dep2: m.default });",
  "} catch (e) { postMessage({ dep2: 'ERR ' + String(e && e.message || e) }); }",
].join("\n");

/* The one fixture routing table, shared by the normal request path
   and the upgrade-classified fallback so both serve identical
   content types and bodies. */
function fixtureRoute(p, u) {
  if (p === "/dir/page.html") return { ct: "text/html", body: PAGE };
  if (p === "/dir/w.js") return { ct: "application/javascript", body: W_CLASSIC };
  if (p === "/dir/dep.js") return { ct: "application/javascript", body: DEP_CLASSIC };
  if (p === "/mw.js") return { ct: "application/javascript", body: W_MODULE };
  if (p === "/dep2.js") return { ct: "application/javascript", body: MOD("dep2") };
  if (p === "/dir/mods/rel.js") return { ct: "application/javascript", body: MOD("rel") };
  if (p === "/dir/mods/tpl.js") return { ct: "application/javascript", body: MOD("tpl") };
  if (p === "/mods/root.js" || p === "/mods/q.js") return { ct: "application/javascript", body: MOD(p === "/mods/root.js" ? "root" : "q") };
  if (p === "/dir/img/pic.png") return { ct: "image/png", body: PNG_1x1 };
  return { ct: "application/json", body: echo(u) };
}

function wsEcho(server) {
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    /* A proxied navigation can arrive carrying hop-by-hop h2c upgrade
       tokens ("Upgrade: h2c", "Connection: Upgrade, HTTP2-Settings"):
       Node routes it here, and destroying the socket would read as an
       empty reply upstream (curl error 52). Answer it as the ordinary
       request it semantically is. */
    if (!key) {
      const u = new URL(req.url, FX);
      hits.push(u.pathname + u.search);
      const rt = fixtureRoute(u.pathname, u);
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: " + rt.ct + "\r\nContent-Length: " + Buffer.byteLength(rt.body) + "\r\nConnection: close\r\n\r\n" + rt.body);
      socket.end();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept + "\r\n\r\n",
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (d) => {
      pending = Buffer.concat([pending, d]);
      if (pending.length < 2) return;
      const opcode = pending[0] & 0x0f;
      if (opcode !== 0x1) { pending = pending.subarray(2); return; }
      let len = pending[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (pending.length < 4) return; len = pending.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (pending.length < 10) return; len = Number(pending.readBigUInt64BE(2)); off = 10; }
      if (pending.length < off + 4 + len) return;
      const mask = pending.subarray(off, off + 4); off += 4;
      const payload = pending.subarray(off, off + len);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      const head = out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126]);
      socket.write(Buffer.concat([head, out]));
      pending = pending.subarray(off + len);
    });
    socket.on("error", () => {});
  });
}

async function waitFor(label, timeoutMs, fn) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = String(e?.message ?? e); }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label + (last ? "; last: " + last : ""));
}

const results = [];
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

const CASE_KEYS = [
  "fetchRelConcat", "fetchTplQuery", "fetchCond", "newUrlBaseUri", "dynImportRoot",
  "dynImportRel", "dynImportTpl", "dynImportQuery", "imgPropComputed", "classicWorker",
  "moduleWorker", "wsEcho", "cfgUnchanged", "metaUrlInline",
];

let engineProc = null;
const engineErr = [];
const pageNoise = [];

async function main() {
  let directHits = [];
  const fx = createServer((req, res) => {
    const u = new URL(req.url, FX);
    const p = u.pathname;
    if (p === "/__hits") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(hits)); return; }
    hits.push(p + u.search);
    const rt = fixtureRoute(p, u);
    res.setHeader("content-type", rt.ct);
    res.end(rt.body);
  });
  wsEcho(fx);
  await new Promise((r) => fx.listen(FX_PORT, "127.0.0.1", r));

  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) throw new Error("no zeolite-server binary at " + bin);
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", STATIC], {
    env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await waitFor("engine", 60000, async () => { try { return (await fetch(ENGINE + "/")).status === 200; } catch { return false; } });
  await waitFor("sw.js", 30000, async () => { try { return (await fetch(ENGINE + "/sw.js")).status === 200; } catch { return false; } });

  const browser = await chromium.launch();

  /* ---- direct control pass ---- */
  hits = [];
  const dpg = await browser.newPage();
  await dpg.goto(FX + "/dir/page.html");
  await waitFor("direct results", 30000, async () => {
    const n = await dpg.evaluate("Object.keys(window.__r || {}).length").catch(() => -1);
    return n >= PAGE_CASES ? n : null;
  });
  const direct = await dpg.evaluate("window.__r").catch((e) => ({ EVALFAIL: String(e) }));
  directHits = [...hits];
  await dpg.close();

  /* ---- proxied pass ---- */
  hits = [];
  const pg = await browser.newPage();
  pg.on("console", (m) => pageNoise.push("[page] " + m.type() + " " + m.text().slice(0, 200)));
  pg.on("pageerror", (e) => pageNoise.push("[pageerror] " + String(e).slice(0, 300)));
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(FX + "/dir/page.html"));
  let frame = null;
  try {
    frame = await waitFor("proxied frame with marker", 90000, async () => {
      for (const f of pg.frames()) {
        try {
          if (!f.url().startsWith(ENGINE + "/j/") && !f.url().startsWith(ENGINE + "/__zl_")) continue;
          if ((await f.locator("#pm").count()) > 0) return f;
        } catch {}
      }
      return null;
    });
    await waitFor("proxied results", 60000, async () => {
      const n = await frame.evaluate("Object.keys(window.__r || {}).length").catch(() => -1);
      return n >= PAGE_CASES ? n : null;
    });
  } catch (e) {
    console.log("DIAG pg.url=" + pg.url());
    for (const f of pg.frames()) console.log("DIAG frame " + f.url().slice(0, 110));
    for (const f of pg.frames()) {
      if (f.url().startsWith(ENGINE + "/j/")) {
        try { console.log("DIAG body " + (await f.locator("body").innerText()).slice(0, 700)); } catch (e2) { console.log("DIAG body-fail " + String(e2).slice(0, 120)); }
      }
    }
    for (const n of pageNoise.slice(0, 10)) console.log("DIAG " + n);
    throw e;
  }
  await sleep(1500);
  const proxied = await frame.evaluate("window.__r").catch((e) => ({ EVALFAIL: String(e) }));
  await pg.close();
  const proxiedHits = [...hits];
  await browser.close();
  engineProc.kill("SIGKILL");
  fx.close();

  /* ---- differential assertions ---- */
  for (const k of CASE_KEYS) {
    await check(k + " direct-vs-proxied parity", () => {
      const d = direct[k], p = proxied[k];
      if (!d || !d.ok) throw new Error("direct control failed: " + JSON.stringify(d));
      if (!p || !p.ok) throw new Error("proxied failed (direct ok " + JSON.stringify(d.val) + "): " + JSON.stringify(p));
      if (JSON.stringify(d.val) !== JSON.stringify(p.val)) {
        throw new Error("value mismatch: direct " + JSON.stringify(d.val) + " vs proxied " + JSON.stringify(p.val));
      }
      return JSON.stringify(p.val);
    });
  }
  await check("postMsgTarget delivered in proxied mode", () => {
    const p = proxied.postMsgTarget;
    if (!p || !p.ok) throw new Error("postMessage with computed targetOrigin not delivered: " + JSON.stringify(p));
    return p.val;
  });
  await check("upstream hit sets identical across modes", () => {
    const norm = (l) => [...new Set(l)].sort();
    const d = norm(directHits), p = norm(proxiedHits);
    const missing = d.filter((h) => !p.includes(h));
    const extra = p.filter((h) => !d.includes(h));
    if (missing.length || extra.length) {
      throw new Error("upstream mismatch; only-direct=" + JSON.stringify(missing) + " only-proxied=" + JSON.stringify(extra));
    }
    return d.length + " unique upstream requests";
  });
  await check("dynamic-import query string preserved upstream", () => {
    if (!proxiedHits.includes("/mods/q.js?x=9")) throw new Error("upstream never saw /mods/q.js?x=9; hits=" + JSON.stringify(proxiedHits));
    return "present";
  });

  const fails = results.filter((r) => !r.ok);
  console.log(fails.length === 0 ? "COMPUTED-SINKS: ALL " + results.length + " PASS" : "COMPUTED-SINKS: " + fails.length + "/" + results.length + " FAIL");
  if (pageNoise.length) {
    console.log("=== PAGE NOISE ===");
    for (const n of pageNoise.slice(0, 15)) console.log(n);
  }
  if (fails.length > 0) process.exit(1);
}

main().catch((e) => { console.log("HARNESS-ERROR " + String(e?.message ?? e)); console.log("=== ENGINE LOG ==="); console.log(engineErr.join("").slice(-1500)); try { engineProc?.kill("SIGKILL"); } catch {} try { process.exit(1); } catch {} });
