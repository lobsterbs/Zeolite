/* #533 acceptance suite: virtual-origin cross-window postMessage matrix.
   The same fixture page runs twice: direct (the raw Chromium oracle)
   and proxied (through the Zeolite engine). Asserts parity facts
   (delivery, ordering, MessageChannel port transfer round trips,
   ev.source identity in nested engine frames, downstream leaf
   delivery), pins the documented divergences (engine-origin
   ev.origin, top-path routing, "/" target delivery, literal
   targetOrigin matching, the shared cookie/localStorage jar) and the
   opaque-sandbox platform limit: a sandboxed frame without
   allow-same-origin bypasses the service worker entirely, so its
   document load serves the engine bypass notice instead of the page
   (#533). Ports 6027/7128/7129 never collide with the other suites. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6027;
const PORT_A = 7128;
const PORT_B = 7129;
const A = "http://127.0.0.1:" + PORT_A;
const B = "http://127.0.0.2:" + PORT_B;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const PARITY_PAGES = ["c-same", "c-same2", "c-sandB", "c-cross"];

const FAILURES = [];
let passed = 0;
function ok(cond, name, detail) {
  if (cond) { passed += 1; return; }
  const line = "[FAIL] " + name + (detail === undefined ? "" : " :: " + String(detail));
  FAILURES.push(line);
  console.log(line);
}

function childBody(pageId) {
  return '<!doctype html><html><head><title>zl pm child</title></head><body>' +
'<p id="zl-pm-' + pageId + '">child</p>' +
'<script>' +
'(function () {' +
'  var C = window.__pmChild = { page: "' + pageId + '", started: false, log: [] };' +
'  function post(t, d, o, p) { try { if (p) t.postMessage(d, o, p); else t.postMessage(d, o); return "ok"; } catch (e) { return "throw:" + (e && e.name ? e.name : String(e)); } }' +
'  C.alive = post(window.parent, { kind: "alive", page: C.page }, "*");' +
'  window.addEventListener("message", function (ev) {' +
'    var d = ev.data;' +
'    if (!d || typeof d !== "object") return;' +
'    C.log.push({ kind: String(d.kind), origin: ev.origin, ports: !!(ev.ports && ev.ports.length) });' +
'    if (d.kind === "ping") { C.pong = post(window.parent, { kind: "pong", page: C.page }, "*"); }' +
'    if (d.kind === "portEcho" && ev.ports && ev.ports[0]) {' +
'      try { var p2 = ev.ports[0]; p2.onmessage = function () { p2.postMessage("child-ack"); }; p2.start(); C.portEchoOk = true; } catch (e) { C.portEchoErr = String(e); }' +
'    }' +
'    if (d.kind === "downPing" && ev.ports && ev.ports[0]) {' +
'      try { ev.ports[0].start(); ev.ports[0].postMessage("down-pong"); C.downPortPost = "ok"; } catch (e) { C.downPortPost = "throw:" + String(e); }' +
'    }' +
'    if (d.kind === "crossPing") { C.crossPong = post(window.parent, { kind: "crossPong", page: C.page }, "*"); }' +
'    if (d.kind === "crossVO") { C.crossVOPong = post(window.parent, { kind: "crossVOPong", page: C.page }, "*"); }' +
'    if (d.kind === "slashCross") { C.slashCrossPong = post(window.parent, { kind: "slashCrossPong", page: C.page }, "*"); }' +
'    if (d.kind === "readStorage") {' +
'      var local = null, cookie = "";' +
'      try { local = localStorage.getItem("zlK"); } catch (e) { local = "ERR"; }' +
'      try { cookie = document.cookie; } catch (e) { cookie = "ERR"; }' +
'      post(window.parent, { kind: "bStorage", page: C.page, local: local, cookie: cookie }, "*");' +
'    }' +
'  });' +
'  var t0 = Date.now();' +
'  (function poll() {' +
'    var vo = window.__zlVO;' +
'    if ((typeof vo === "string" && vo) || Date.now() - t0 > 8000) run(typeof vo === "string" && vo ? vo : location.origin);' +
'    else setTimeout(poll, 100);' +
'  })();' +
'  function run(vo) {' +
'    C.vo = vo; C.realOrigin = location.origin;' +
'    C.selfPost = post(window, { kind: "selfEcho" }, vo);' +
'    C.up = post(window.parent, { kind: "voPost", page: C.page }, vo);' +
'    C.wrong = post(window.parent, { kind: "wrongPost", page: C.page }, "https://definitely-not-there.example");' +
'    C.star = post(window.parent, { kind: "starPost", page: C.page }, "*");' +
'    C.slash = post(window.parent, { kind: "slashPost", page: C.page }, "/");' +
'    C.malformed = post(window.parent, { kind: "malPost", page: C.page }, "http://");' +
'    C.order = (function () { var a = post(window.parent, { kind: "order1", page: C.page }, "*"); var b = post(window.parent, { kind: "order2", page: C.page }, "*"); return a + "/" + b; })();' +
'    C.top = post(window.parent.parent, { kind: "topPath", page: C.page }, vo);' +
'    try {' +
'      var ch = new MessageChannel();' +
'      ch.port1.onmessage = function () { C.portDone = post(window.parent, { kind: "portDone", page: C.page }, "*"); };' +
'      ch.port1.start();' +
'      C.portOffer = post(window.parent, { kind: "portOffer", page: C.page }, vo, [ch.port2]);' +
'    } catch (e) { C.portOffer = "throw:" + String(e); }' +
'    C.started = true;' +
'  }' +
'})();' +
'</script></body></html>';
}

function midBody() {
  return '<!doctype html><html><head><title>zl pm mid</title></head><body>' +
'<p id="zl-pm-mid">mid</p>' +
'<iframe id="leaf" src="/pm/leaf.html"></iframe>' +
'<script>' +
'(function () {' +
'  var M = window.__pmMid = { started: false };' +
'  window.addEventListener("message", function (ev) {' +
'    var d = ev.data;' +
'    if (!d || typeof d !== "object") return;' +
'    if (d.kind === "leafUp") {' +
'      M.leafUpOrigin = ev.origin;' +
'      M.leafUpSrcEqCW = (function () { try { var el = document.getElementById("leaf"); return ev.source === el.contentWindow; } catch (e) { return "ERR"; } })();' +
'      try { window.parent.postMessage({ kind: "midUp" }, M.vo); M.midUpPost = "ok"; } catch (e) { M.midUpPost = "throw:" + String(e); }' +
'    }' +
'  });' +
'  var t0 = Date.now();' +
'  (function poll() {' +
'    var vo = window.__zlVO;' +
'    if ((typeof vo === "string" && vo) || Date.now() - t0 > 8000) run(typeof vo === "string" && vo ? vo : location.origin);' +
'    else setTimeout(poll, 100);' +
'  })();' +
'  function run(vo) { M.vo = vo; M.realOrigin = location.origin; M.started = true; }' +
'})();' +
'</script></body></html>';
}

function leafBody() {
  return '<!doctype html><html><head><title>zl pm leaf</title></head><body>' +
'<p id="zl-pm-leaf">leaf</p>' +
'<script>' +
'(function () {' +
'  var L = window.__pmLeaf = { started: false };' +
'  window.addEventListener("message", function (ev) {' +
'    var d = ev.data;' +
'    if (d && d.kind === "downToLeaf") {' +
'      L.gotDown = true; L.downOrigin = ev.origin;' +
'      try { window.parent.parent.postMessage({ kind: "leafEcho" }, "*"); L.echo = "ok"; } catch (e) { L.echo = "throw:" + String(e); }' +
'    }' +
'  });' +
'  var t0 = Date.now();' +
'  (function poll() {' +
'    var vo = window.__zlVO;' +
'    if ((typeof vo === "string" && vo) || Date.now() - t0 > 8000) run(typeof vo === "string" && vo ? vo : location.origin);' +
'    else setTimeout(poll, 100);' +
'  })();' +
'  function run(vo) { L.vo = vo; L.realOrigin = location.origin; try { window.parent.postMessage({ kind: "leafUp" }, vo); L.leafUp = "ok"; } catch (e) { L.leafUp = "throw:" + String(e); } L.started = true; }' +
'})();' +
'</script></body></html>';
}

function parentBody() {
  return '<!doctype html><html><head><title>zl pm parent</title></head><body>' +
'<p id="zl-pm-parent">parent</p>' +
'<iframe id="same" name="same" src="/pm/child-c-same.html"></iframe>' +
'<iframe id="same2" name="same2" src="/pm/child-c-same2.html"></iframe>' +
'<iframe id="sandA" name="sandA" sandbox="allow-scripts" src="/pm/child-c-sandA.html"></iframe>' +
'<iframe id="sandB" name="sandB" sandbox="allow-scripts allow-same-origin" src="/pm/child-c-sandB.html"></iframe>' +
'<iframe id="sandC" name="sandC" sandbox="" src="/pm/child-c-sandC.html"></iframe>' +
'<iframe id="sand2" name="sand2" sandbox="allow-scripts" src="/pm/child-c-sand2.html"></iframe>' +
'<iframe id="cross" name="cross" src="' + B + '/pm/child-c-cross.html"></iframe>' +
'<iframe id="mid" name="mid" src="/pm/mid.html"></iframe>' +
'<script>' +
'(function () {' +
'  var pm = window.__pm = { log: [], done: false };' +
'  function post(t, d, o, p) { try { if (p) t.postMessage(d, o, p); else t.postMessage(d, o); return "ok"; } catch (e) { return "throw:" + (e && e.name ? e.name : String(e)); } }' +
'  function CW(id) { return document.getElementById(id).contentWindow; }' +
'  function IFR(id) { return document.getElementById(id); }' +
'  window.addEventListener("message", function (ev) {' +
'    var d = ev.data;' +
'    if (!d || typeof d !== "object") return;' +
'    pm.log.push({ kind: String(d.kind), page: d.page ? String(d.page) : "", origin: ev.origin, ports: !!(ev.ports && ev.ports.length) });' +
'    if (d.kind === "portOffer" && ev.ports && ev.ports[0]) {' +
'      if (!pm.portOfferPages) pm.portOfferPages = {}; pm.portOfferPages[d.page] = 1; pm.portOfferLast = d.page;' +
'      try { var p2 = ev.ports[0]; p2.onmessage = function () { pm.portBackOk = true; }; p2.start(); p2.postMessage("back"); pm.portEchoPost = "ok"; } catch (e) { pm.portEchoPost = "throw:" + String(e); }' +
'    }' +
'    if (d.kind === "bStorage") { pm.bLocal = d.local; pm.bCookie = d.cookie; pm.bFrom = d.page; }' +
'  });' +
'  var t0 = Date.now();' +
'  (function voPoll() {' +
'    var vo = window.__zlVO;' +
'    if ((typeof vo === "string" && vo) || Date.now() - t0 > 8000) { pm.vo = (typeof vo === "string" && vo) ? vo : location.origin; afterVo(); }' +
'    else setTimeout(voPoll, 100);' +
'  })();' +
'  function afterVo() {' +
'    var waited = 0;' +
'    (function docPoll() {' +
'      var midDoc = null;' +
'      try { midDoc = IFR("mid").contentDocument; } catch (e) {}' +
'      var midReady = !!(midDoc && midDoc.getElementById && midDoc.getElementById("leaf"));' +
'      if (midReady || waited > 20000) { runMatrix(); return; }' +
'      waited += 250; setTimeout(docPoll, 250);' +
'    })();' +
'  }' +
'  function runMatrix() {' +
'    pm.realOrigin = location.origin;' +
'    pm.pings = {};' +
'    ["same", "same2", "sandA", "sandB", "sand2", "cross"].forEach(function (id) { pm.pings[id] = post(CW(id), { kind: "ping" }, "*"); });' +
'    try {' +
'      var ch = new MessageChannel();' +
'      ch.port1.onmessage = function () { pm.downPortOk = true; };' +
'      ch.port1.start();' +
'      pm.downPost = post(CW("same"), { kind: "downPing" }, pm.vo, [ch.port2]);' +
'    } catch (e) { pm.downPost = "throw:" + String(e); }' +
'    pm.crossStar = post(CW("cross"), { kind: "crossPing" }, "*");' +
'    pm.crossVO = post(CW("cross"), { kind: "crossVO" }, "' + B + '");' +
'    pm.slashCross = post(CW("cross"), { kind: "slashCross" }, "/");' +
'    try { localStorage.setItem("zlK", "A"); } catch (e) { pm.aLocalErr = String(e); }' +
'    try { document.cookie = "zlC=A; path=/"; } catch (e) {}' +
'    pm.aLocal = (function () { try { return localStorage.getItem("zlK"); } catch (e) { return "ERR"; } })();' +
'    pm.aCookieHasZlC = document.cookie.indexOf("zlC=") !== -1;' +
'    pm.crossAccess = (function () { try { var c = document.getElementById("cross").contentDocument.cookie; return "ok:" + (c === "" ? "empty" : "nonempty"); } catch (e) { return "throw:" + (e && e.name ? e.name : String(e)); } })();' +
'    post(CW("cross"), { kind: "readStorage" }, "*");' +
'    pm.sandDoc = {};' +
'    ["sandA", "sandB", "sandC", "sand2"].forEach(function (id) {' +
'      try { var d2 = document.getElementById(id).contentDocument; pm.sandDoc[id] = d2 ? "read" : "null"; }' +
'      catch (e) { pm.sandDoc[id] = "throw:" + (e && e.name ? e.name : String(e)); }' +
'    });' +
'    pm.midAccess = (function () { try { var doc = IFR("mid").contentDocument; return doc ? "ok" : "null"; } catch (e) { return "throw:" + (e && e.name ? e.name : String(e)); } })();' +
'    try {' +
'      var leafEl = IFR("mid").contentDocument.getElementById("leaf");' +
'      pm.leafDown = post(leafEl.contentWindow, { kind: "downToLeaf" }, "*");' +
'    } catch (e) { pm.leafDown = "throw:" + String(e); }' +
'    pm.done = true;' +
'  }' +
'})();' +
'</script></body></html>';
}

const CHILD_IDS = ["c-same", "c-same2", "c-sandA", "c-sandB", "c-sandC", "c-sand2", "c-cross"];

function makeFixture(port, host) {
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (path === "/pm/parent.html") send(200, "text/html; charset=utf-8", parentBody());
    else if (path === "/pm/mid.html") send(200, "text/html; charset=utf-8", midBody());
    else if (path === "/pm/leaf.html") send(200, "text/html; charset=utf-8", leafBody());
    else if (path.indexOf("/pm/child-") === 0) {
      const id = path.slice("/pm/child-".length, -5);
      if (CHILD_IDS.indexOf(id) !== -1) send(200, "text/html; charset=utf-8", childBody(id));
      else send(404, "text/plain", "nope");
    }
    else send(404, "text/plain", "nope");
  });
  return new Promise((r) => server.listen(port, host, () => r(server)));
}

async function startEngine() {
  try { const r = await fetch(ENGINE + "/"); if (r.status === 200) return { proc: null, reused: true }; } catch {}
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) throw new Error("zeolite-server not built: " + bin);
  const proc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], {
    env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const err = [];
  proc.stdout.on("data", (c) => err.push(String(c)));
  proc.stderr.on("data", (c) => err.push(String(c)));
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try { const r = await fetch(ENGINE + "/"); if (r.status === 200) return { proc, err, reused: false }; } catch {}
    await sleep(250);
  }
  throw new Error("engine never came up: " + err.join("").slice(-500));
}

async function collect(page) {
  const out = { pm: null, children: {}, mid: null, leaf: null, others: [] };
  for (const f of page.frames()) {
    let n = 0;
    try { n = await f.locator("#zl-pm-parent").count(); } catch { n = 0; }
    if (n > 0) {
      const t = await f.evaluate("(() => (window.__pm ? JSON.stringify(window.__pm) : null))()");
      if (t) { out.pm = JSON.parse(t); continue; }
    }
    try { n = await f.locator('[id^="zl-pm-c-"]').count(); } catch { n = 0; }
    if (n > 0) {
      const t = await f.evaluate("(() => (window.__pmChild ? JSON.stringify(window.__pmChild) : null))()");
      if (t) { const c = JSON.parse(t); out.children[c.page] = c; continue; }
    }
    try { n = await f.locator("#zl-pm-mid").count(); } catch { n = 0; }
    if (n > 0) {
      const t = await f.evaluate("(() => (window.__pmMid ? JSON.stringify(window.__pmMid) : null))()");
      if (t) { out.mid = JSON.parse(t); continue; }
    }
    try { n = await f.locator("#zl-pm-leaf").count(); } catch { n = 0; }
    if (n > 0) {
      const t = await f.evaluate("(() => (window.__pmLeaf ? JSON.stringify(window.__pmLeaf) : null))()");
      if (t) { out.leaf = JSON.parse(t); continue; }
    }
    let dump = null;
    try { dump = JSON.parse(await f.evaluate("(() => JSON.stringify({ title: document.title, text: (document.body ? document.body.innerText : String()).slice(0, 160) }))()")); } catch (e) { dump = { err: String(e).slice(0, 120) }; }
    out.others.push({ url: f.url().slice(0, 120), dump });
  }
  return out;
}

async function runPass(browser, mode) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (mode === "direct") await page.goto(A + "/pm/parent.html");
  else await page.goto(ENGINE + "/?url=" + encodeURIComponent(A + "/pm/parent.html"));
  const end = Date.now() + 60000;
  let done = false;
  while (Date.now() < end && !done) {
    for (const fr of page.frames()) {
      try { if ((await fr.locator("#zl-pm-parent").count()) > 0) { done = await fr.evaluate("(() => !!(window.__pm && window.__pm.done === true))()"); } } catch {}
    }
    if (!done) await sleep(500);
  }
  await sleep(10000);
  const facts = await collect(page);
  facts.mode = mode;
  facts.sawDone = done;
  await ctx.close();
  return facts;
}

function logIndexOf(pm, kind, page) {
  for (let i = 0; i < pm.log.length; i += 1) {
    const e = pm.log[i];
    if (e.kind === kind && (!page || e.page === page)) return i;
  }
  return -1;
}
function assertPass(mode, f) {
  const E = mode === "proxied";
  const pm = f.pm;
  ok(!!pm && pm.done === true, mode + " matrix ran to completion");
  if (!pm) return;
  const alive = (p) => logIndexOf(pm, "alive", p) !== -1;
  const pong = (p) => logIndexOf(pm, "pong", p) !== -1;
  for (const p of PARITY_PAGES) {
    ok(alive(p), mode + " alive from " + p);
    ok(pong(p), mode + " pong from " + p);
  }
  const same = f.children["c-same"];
  ok(!!same && same.started === true, mode + " same child started");
  ok(!!f.children["c-cross"] && f.children["c-cross"].started === true, mode + " cross child started");
  ok(logIndexOf(pm, "order1") !== -1 && logIndexOf(pm, "order1") < logIndexOf(pm, "order2"), mode + " delivery order preserved");
  ok(same && same.selfPost === "ok", mode + " self postMessage accepted", same && same.selfPost);
  ok(!!same && same.log.some((e) => e.kind === "selfEcho"), mode + " self postMessage delivered");
  ok(logIndexOf(pm, "voPost", "c-same") !== -1, mode + " vo-target post delivered");
  ok(logIndexOf(pm, "starPost", "c-same") !== -1, mode + " star-target post delivered");
  ok(!!pm.portOfferPages && Object.keys(pm.portOfferPages).length >= 3, mode + " MessageChannel port offered with transfer", JSON.stringify(pm.portOfferPages));
  ok(pm.portEchoPost === "ok", mode + " port echoed back with transfer");
  ok(pm.portEchoPost === "ok", mode + " parent posted on the received transferred port", pm.portEchoPost);

  ok(!!pm.portOfferLast && !!f.children[pm.portOfferLast] && f.children[pm.portOfferLast].portDone === "ok", mode + " child portDone posted", pm.portOfferLast);
  ok(logIndexOf(pm, "portDone") !== -1, mode + " portDone delivered");
  ok(pm.downPost === "ok", mode + " downstream port post accepted");
  ok(pm.downPortOk === true, mode + " downstream port round trip");
  ok(!!same && same.downPortPost === "ok", mode + " child posted on downstream port");
  const mid = f.mid;
  ok(!!mid && mid.leafUpSrcEqCW === true, mode + " mid ev.source === leaf contentWindow (#533 fix)", mid && mid.leafUpSrcEqCW);
  ok(!!mid && mid.midUpPost === "ok", mode + " mid relayed leafUp upward");
  ok(logIndexOf(pm, "midUp") !== -1, mode + " midUp delivered to parent");
  ok(logIndexOf(pm, "leafUp") !== -1 || logIndexOf(pm, "midUp") !== -1, mode + " leaf upward chain visible");
  ok(!!f.leaf && f.leaf.gotDown === true, mode + " leaf received downstream message");
  ok(!!f.leaf && f.leaf.echo === "ok", mode + " leafEcho posted");
  ok(logIndexOf(pm, "leafEcho") !== -1, mode + " leafEcho delivered to parent");
  ok(pm.leafDown === "ok", mode + " parent reached leaf through mid document", pm.leafDown);
  ok(pm.midAccess === "ok", mode + " mid contentDocument readable", pm.midAccess);
  const childEvOrigin = same && same.log.length ? same.log[0].origin : "";
  ok(E ? childEvOrigin === ENGINE : childEvOrigin === A, mode + " child ev.origin is " + (E ? "the engine origin (documented)" : "the site origin"), childEvOrigin);
  const aliveCross = pm.log.find((e) => e.kind === "alive" && e.page === "c-cross");
  ok(!!aliveCross && (E ? aliveCross.origin === ENGINE : aliveCross.origin === B), mode + " cross child ev.origin", aliveCross && aliveCross.origin);
  const topIdx = logIndexOf(pm, "topPath");
  ok(E ? topIdx === -1 : topIdx !== -1, mode + " top-path routing " + (E ? "goes to the UI frame (documented divergence)" : "reaches the top page"));
  const slashIdx = logIndexOf(pm, "slashPost", "c-same");
  ok(!!same && same.slash === "ok" && slashIdx !== -1, mode + " / target delivers to own origin");
  const slashCrossIdx = logIndexOf(pm, "slashCrossPong");
  if (E) {
    ok(slashCrossIdx !== -1, "proxied / target reaches cross-site frame (documented divergence)");
  } else {
    ok(slashCrossIdx === -1, "direct / target drops cross-site delivery");
  }
  const wrongIdx = logIndexOf(pm, "wrongPost");
  if (E) {
    ok(wrongIdx !== -1, "proxied wrong-origin target delivered (literal targetOrigin rewrite, documented divergence)");
  } else {
    ok(wrongIdx === -1, "direct wrong-origin target dropped");
  }
  ok(!!same && String(same.malformed).indexOf("throw:") === 0 && logIndexOf(pm, "malPost") === -1, mode + " malformed target rejected", same && same.malformed);
  ok(pm.crossVO === "ok", mode + " cross-target post accepted", pm.crossVO);
  ok(logIndexOf(pm, "crossVOPong") !== -1, mode + " cross-target post round trip");
  ok(pm.aLocal === "A" && pm.aCookieHasZlC === true, mode + " parent storage round trip", JSON.stringify({ l: pm.aLocal, c: pm.aCookieHasZlC }));
  ok(pm.bFrom === "c-cross" && pm.bLocal === null, mode + " cross-site virtual storage stays partitioned", JSON.stringify({ from: pm.bFrom, l: pm.bLocal }));
  if (E) {
    ok(pm.bCookie === "", "proxied cross site cookie jar stays isolated (parity)", pm.bCookie);
    ok(pm.crossAccess === "ok:empty", "proxied cross contentDocument readable, cookie invisible (documented divergence)", pm.crossAccess);
  } else {
    ok(pm.bCookie === "", "direct cross site cookie jar isolated", pm.bCookie);
    ok(String(pm.crossAccess).indexOf("throw:") === 0, "direct cross contentDocument blocked", pm.crossAccess);
  }
  ok(alive("c-sandC") === false && pong("c-sandC") === false, mode + " no-scripts sandbox stays silent");
  ok(pm.sandDoc.sandB === "read", mode + " allow-same-origin sandbox document readable", pm.sandDoc.sandB);
  for (const id of ["sandA", "sandC", "sand2"]) {
    ok(pm.sandDoc[id] === "null", mode + " opaque sandbox contentDocument blocked: " + id, pm.sandDoc[id]);
  }
  if (E) {
    for (const p of ["c-sandA", "c-sand2"]) {
      ok(alive(p) === false && pong(p) === false, "proxied opaque sandbox child never runs (platform limit): " + p);
      ok(!f.children[p], "proxied opaque sandbox frame has no child state: " + p);
    }
    const noticeFrames = f.others.filter((o) => o.dump && o.dump.title === "Zeolite engine route");
    ok(noticeFrames.length >= 3, "proxied opaque sandbox frames show the engine bypass notice", JSON.stringify(f.others.map((o) => (o.dump ? o.dump.title : "?"))));
  } else {
    for (const p of ["c-sandA", "c-sand2"]) {
      ok(alive(p) === true && pong(p) === true, "direct allow-scripts sandbox child runs: " + p);
    }
    ok(pm.pings.sandA === "ok" && pm.pings.sand2 === "ok", "direct sandbox postMessage accepted");
  }
  ok(pm.pings.same === "ok" && pm.pings.cross === "ok" && pm.pings.sandB === "ok", mode + " parent posts accepted");
}

function observe(name, f) {
  const kinds = {};
  f.pm.log.forEach((e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
  console.log("OBSERVE " + name + " kinds=" + JSON.stringify(kinds));
  const c = f.children["c-same"];
  if (c) console.log("OBSERVE " + name + " child slash=" + c.slash + " wrong=" + c.wrong + " malformed=" + c.malformed + " top=" + c.top + " portOffer=" + c.portOffer + " order=" + c.order);
  console.log("OBSERVE " + name + " crossVO=" + f.pm.crossVO + " slashCross=" + f.pm.slashCross + " crossStar=" + f.pm.crossStar + " downPost=" + f.pm.downPost + " crossAccess=" + f.pm.crossAccess);
  console.log("OBSERVE " + name + " sandDoc=" + JSON.stringify(f.pm.sandDoc) + " midAccess=" + f.pm.midAccess + " pings=" + JSON.stringify(f.pm.pings));
  console.log("OBSERVE " + name + " others=" + JSON.stringify(f.others.map((o) => (o.dump ? o.dump.title : "?"))));
}

async function assertNotice() {
  const r1 = await fetch(ENGINE + "/j/vorigin-suite-notice-check");
  const t1 = await r1.text();
  ok(r1.status === 404 && t1.indexOf("Zeolite engine route") !== -1, "engine route bypass serves the notice", r1.status);
  const r2 = await fetch(ENGINE + "/__zl_nav__/eHl6");
  const t2 = await r2.text();
  ok(r2.status === 404 && t2.indexOf("Zeolite engine route") !== -1, "nav route bypass serves the notice", r2.status);
  const r3 = await fetch(ENGINE + "/definitely-not-a-file-vorigin");
  const t3 = await r3.text();
  ok(r3.status === 404 && t3.indexOf("Zeolite engine route") === -1, "static miss keeps its bare 404", r3.status + ":" + t3.slice(0, 40));
}

const fa = await makeFixture(PORT_A, "127.0.0.1");
const fb = await makeFixture(PORT_B, "127.0.0.2");
const engine = await startEngine();
await assertNotice();
const browser = await chromium.launch();
const direct = await runPass(browser, "direct");
const proxied = await runPass(browser, "proxied");
observe("direct", direct);
observe("proxied", proxied);
assertPass("direct", direct);
assertPass("proxied", proxied);
if (engine.proc) engine.proc.kill();
fa.close();
fb.close();
await browser.close();
if (FAILURES.length) {
  console.log("HARNESS-ERROR " + FAILURES.length + " failures, " + passed + " passed");
  process.exit(1);
}
console.log("VORIGIN-MSG-OK " + passed + " assertions");
