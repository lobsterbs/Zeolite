/* #527 acceptance suite: opt-in CSP translation enforcement,
   direct versus proxied in real Chromium.

   What this suite pins:

   - The gate: with the cspTranslation experimental flag off, an
     upstream deny-only CSP is stripped and the page behaves as
     before (the blocked-class form attempt lands; no marker).
   - The enforcement: with the flag on, a candidate policy is served
     on the proxied document response, identical to the direct
     oracle, and the securitypolicyviolation set (frame-src,
     worker-src, object-src, base-uri, form-action) is IDENTICAL in
     both modes while the page own resources still load (no
     script-src/img-src/connect-src in the accepted subset, so the
     allow side never regresses).
   - Shared-origin isolation: the served policy never carries an
     origin, scheme or quoted source, so enforcement can never grant
     one virtual site access to another through the shared engine
     origin.
   - Visible decisions: an enforced candidate marks x-zl-csp with the
     translated directives; an unsupported policy stays stripped and
     marks x-zl-csp with the typed reason; the report-only and
     meta-policy paths stay unenforced and unmarked (their honest
     divergences from the direct oracle are asserted, not hidden).
   - Meta-policy consistency: the rewriter drops CSP meta tags, so the
     effective policy is exactly the header-path decision; the direct
     oracle (meta CSP honored by the browser) diverges exactly as
     documented.

   Run: node suite/e2e/csp-enforce.mjs (engine on 6026, fixture on
   7127 - never colliding with the other suites). */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6026;
const FX = 7127;
const FX2 = 7150;
const CROSS = "http://127.0.0.1:" + FX2;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const ORIGIN = "http://127.0.0.1:" + FX;
const CANDIDATE_CSP = "frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
/* Shared instrumentation for the #527 source pages: CSP-honest in the
   direct oracle (same-origin script, allowed), minted to an engine
   route when proxied. Loads before the page's subresources so the
   violation listener is armed first; image state is read at settle
   time (complete/naturalWidth), which no event ordering can race. */
const PROBE_JS = `(function () {
  window.__zlSrc = { okImg: false, okFetch: false, badFetch: "", violations: [], settled: false };
  document.addEventListener("securitypolicyviolation", function (e) {
    if (window.__zlSrc.violations.indexOf(e.violatedDirective) === -1)
      window.__zlSrc.violations.push(e.violatedDirective);
  });
  fetch("/csp/api/ok").then(function (r) { return r.json(); })
    .then(function (j) { window.__zlSrc.okFetch = j.ok === true; })
    .catch(function () { window.__zlSrc.okFetch = "error"; });
  fetch("${CROSS}/csp/evil-api").then(function () { window.__zlSrc.badFetch = "loaded"; })
    .catch(function () { window.__zlSrc.badFetch = "blocked"; });
  setTimeout(function () {
    var img = document.getElementById("zl-ok-img");
    window.__zlSrc.okImg = !!(img && img.complete && img.naturalWidth > 0);
    window.__zlSrc.settled = true;
  }, 2500);
})();
`;

/* #527 engine source-list pages. The instrumentation rides an
   EXTERNAL same-origin script (probe.js), which a script-src 'self'
   policy honestly allows in the direct oracle; inline instrumentation
   could never run under the very policy under test. probe.js loads
   first so its violation listener is armed before any blocked class
   fires. The cross-origin subresources are parser-inserted (the HTML
   rewriter mints their routes) plus one dynamic fetch literal (the JS
   rewriter mints it), so every blocked class rides the engine seam. */
function srcBody(id) {
  return `<!doctype html><html><head><title>zl csp src</title></head><body>
<p id="${id}">src</p>
<script src="/csp/probe.js"></script>
<img id="zl-ok-img" src="/csp/img.png" alt="i">
<img id="zl-evil-img" src="${CROSS}/csp/evil.png" alt="x">
<script id="zl-evil-script" src="${CROSS}/csp/evil.js"></script>
</body></html>`;
}

/* 1x1 transparent PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/* The candidate page script runs IDENTICALLY in the direct oracle and
   the proxied frame; the harness only reads window.__zlCsp. The
   blocked-class attempts fire securitypolicyviolation events when a
   policy is enforced; without one, the form attempt navigates the
   page to the form-target marker instead (the harness detects that
   as the not-enforced state). */
function candidateBody(path) {
  return `<!doctype html><html><head><title>zl csp</title></head><body>
<p id="zl-csp-marker">zl-csp-page</p>
<img id="zl-csp-img" src="/csp/img.png" alt="i">
<script>
(function () {
  window.__zlCsp = { violations: [], done: false, img: false, fetch: false };
  document.addEventListener("securitypolicyviolation", function (e) {
    if (window.__zlCsp.violations.indexOf(e.violatedDirective) === -1)
      window.__zlCsp.violations.push(e.violatedDirective);
  });
  var img = document.getElementById("zl-csp-img");
  img.addEventListener("load", function () { window.__zlCsp.img = img.naturalWidth > 0; });
  fetch("/csp/api/ok").then(function (r) { return r.json(); })
    .then(function (j) { window.__zlCsp.fetch = j.ok === true; })
    .catch(function () { window.__zlCsp.fetch = false; });
  var f = document.createElement("iframe");
  f.src = "/csp/inner.html";
  f.style.display = "none";
  document.body.appendChild(f);
  try { new Worker("/csp/worker.js"); } catch (err) {}
  var o = document.createElement("object");
  o.data = "/csp/img.png";
  o.type = "image/png";
  o.width = 1;
  o.height = 1;
  document.body.appendChild(o);
  var b = document.createElement("base");
  b.href = "/csp/never/";
  document.body.appendChild(b);
  var form = document.createElement("form");
  form.method = "POST";
  form.action = "/csp/form-target";
  form.style.display = "none";
  document.body.appendChild(form);
  setTimeout(function () {
    window.__zlCsp.formArmed = true;
    form.submit();
    setTimeout(function () { window.__zlCsp.done = true; }, 400);
  }, 600);
})();
</script>
</body></html>`;
}

function liveBody(marker) {
  return `<!doctype html><html><head><title>zl csp live</title></head><body>
<p id="${marker}">live</p>
<img id="zl-csp-img" src="/csp/img.png" alt="i">
<script>window.__zlCspLive = { img: false, live: true };
(function () {
  var img = document.getElementById("zl-csp-img");
  img.addEventListener("load", function () { window.__zlCspLive.img = img.naturalWidth > 0; });
})();
</script>
</body></html>`;
}

function startFixture(port) {
  const server = createServer((req, res) => {
    const send = (status, type, body, headers) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...(headers ?? {}) });
      res.end(body);
    };
    const path = req.url.split("?")[0];
    HITS.set(path, (HITS.get(path) || 0) + 1);
    if (path === "/csp/candidate.html") {
      send(200, "text/html; charset=utf-8", candidateBody(path), { "content-security-policy": CANDIDATE_CSP });
    } else if (path === "/csp/unsupported.html") {
      send(200, "text/html; charset=utf-8", liveBody("zl-csp-unsupported"), {
        "content-security-policy": "script-src 'self'; img-src 'self'",
      });
    } else if (path === "/csp/report-only.html") {
      send(200, "text/html; charset=utf-8", liveBody("zl-csp-reportonly"), {
        "content-security-policy-report-only": "object-src 'none'",
      });
    } else if (path === "/csp/meta.html") {
      send(200, "text/html; charset=utf-8",
        `<!doctype html><html><head><title>zl csp meta</title>
<meta http-equiv="Content-Security-Policy" content="script-src 'self'">
</head><body>
<p id="zl-csp-meta">meta</p>
<img id="zl-csp-img" src="/csp/img.png" alt="i">
<script>window.__zlCspLive = { img: false, live: true };
(function () {
  var img = document.getElementById("zl-csp-img");
  img.addEventListener("load", function () { window.__zlCspLive.img = img.naturalWidth > 0; });
})();
</script>
</body></html>`);
    } else if (path === "/csp/inner.html") {
      send(200, "text/html; charset=utf-8", "<!doctype html><p>inner</p>");
    } else if (path === "/csp/worker.js") {
      send(200, "application/javascript", "self.postMessage('zl-worker-ok');");
    } else if (path === "/csp/img.png") {
      send(200, "image/png", PNG);
    } else if (path === "/csp/api/ok") {
      send(200, "application/json", JSON.stringify({ ok: true }));
    } else if (path === "/csp/form-target") {
      send(200, "text/html; charset=utf-8", '<!doctype html><p id="zl-csp-form-landed">landed</p>');
    } else if (path === "/csp/sources.html") {
      send(200, "text/html; charset=utf-8", srcBody("zl-csp-src"), {
        "content-security-policy": "script-src 'self'; img-src 'self'; connect-src 'self'",
      });
    } else if (path === "/csp/default.html") {
      send(200, "text/html; charset=utf-8", srcBody("zl-csp-def"), {
        "content-security-policy": "default-src 'self'",
      });
    } else if (path === "/csp/nonce.html") {
      send(200, "text/html; charset=utf-8", srcBody("zl-csp-nonce"), {
        "content-security-policy": "script-src 'nonce-zl1' 'strict-dynamic'; img-src 'self'",
      });
    } else if (path === "/csp/probe.js") {
      send(200, "application/javascript", PROBE_JS);
    } else if (path === "/csp/evil.js") {
      send(200, "application/javascript", "window.__zlEvilRan = true;");
    } else if (path === "/csp/evil.png") {
      send(200, "image/png", PNG);
    } else if (path === "/csp/evil-api") {
      send(200, "application/json", JSON.stringify({ ok: true }));
    } else {
      send(404, "text/plain", "nope");
    }
  });
  return new Promise((resolve_) => {
    server.listen(port, "127.0.0.1", () => resolve_({ server, close: () => server.close() }));
  });
}

const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let context = null;
let fixture = null;
let fixture2 = null;
/* Upstream hit counters: the gate must decide before transport, so a
   blocked cross-origin load must NEVER reach the fixture origin. */
const HITS = new Map();

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
async function frameWith(pg, sel) {
  for (const f of pg.frames()) {
    try {
      if (!f.url().startsWith(ENGINE + "/j/")) continue;
      if ((await f.locator(sel).count()) > 0) return f;
    } catch {}
  }
  return null;
}
async function openProxied(target, sel) {
  const pg = await context.newPage();
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  const frame = await waitFor("proxied frame for " + target, 45000, () => frameWith(pg, sel));
  return { page: pg, frame };
}
async function evalIn(frame, label, js, timeoutMs = 30000) {
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
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], {
    env: {
      ...process.env,
      ZL_TEST_ALLOW_PRIVATE_DESTS: "1",
      ZL_TEST_EGRESS: "1",
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
}

async function pushConfig(pg, fields) {
  const ack = await pg.evaluate(
    (cfg) =>
      new Promise((res, rej) => {
        const ctl = navigator.serviceWorker.controller;
        if (!ctl) return rej(new Error("no controller"));
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => {
          ch.port1.close();
          res(e.data);
        };
        ctl.postMessage({ type: "zl:config", ...cfg }, [ch.port2]);
        setTimeout(() => rej(new Error("config ack timeout")), 8000);
      }),
    fields,
  );
  assert(ack && ack.ok === true, "zl:config rejected: " + JSON.stringify(ack));
  return ack;
}

/* Open the engine route of a proxied target as a TOP-LEVEL navigation,
   so the response headers are the document decision the browser
   received (dest=document through the service worker). */
async function topLevelHeaders(path) {
  const probe = await openProxied(ORIGIN + path, "#zl-csp-marker, #zl-csp-unsupported, #zl-csp-reportonly, #zl-csp-meta, #zl-csp-src, #zl-csp-def, #zl-csp-nonce");
  const route = probe.frame.url();
  await probe.page.close();
  const pg = await context.newPage();
  const resp = await pg.goto(route);
  const headers = resp ? resp.headers() : {};
  const body = resp ? await resp.text() : "";
  await pg.close();
  return { headers, body, route };
}

async function collectState(frame, label) {
  await waitFor(label + " collection", 20000, async () => {
    const st = await frame.evaluate("(() => (window.__zlCsp && window.__zlCsp.done === true) || (window.__zlCspLive && window.__zlCspLive.img === true))()");
    return st === true;
  });
  return frame.evaluate("(() => JSON.stringify(window.__zlCsp ?? window.__zlCspLive ?? null))()");
}

async function directPage(path) {
  const pg = await context.newPage();
  await pg.goto(ORIGIN + path);
  return pg;
}

const EXPECTED_VIOLATIONS = ["base-uri", "form-action", "frame-src", "object-src", "worker-src"];

async function main() {
  console.log("== Zeolite CSP translation enforcement suite (issue #527) ==");
  fixture = await startFixture(FX);
  fixture2 = await startFixture(FX2);
  await startEngine();
  browser = await chromium.launch();
  context = await browser.newContext();

  /* ---- the gate: the flag is off, the old behavior holds ---- */

  await check("flag off: a deny-only candidate stays stripped, unmarked, and unenforced", async () => {
    const t = await topLevelHeaders("/csp/candidate.html");
    eq(t.headers["content-security-policy"], undefined, "flag off must not serve a policy");
    eq(t.headers["x-zl-csp"], undefined, "flag off must not mark a decision");
    const probe = await openProxied(ORIGIN + "/csp/candidate.html", "#zl-csp-form-landed");
    return "the unblocked form attempt landed, proving no enforcement";
  });

  await check("flag off: a source-list policy stays unenforced and unmarked, the cross-origin script runs", async () => {
    const t = await topLevelHeaders("/csp/sources.html");
    eq(t.headers["content-security-policy"], undefined, "flag off must not serve a policy");
    eq(t.headers["x-zl-csp"], undefined, "flag off must not mark a decision");
    const probe = await openProxied(ORIGIN + "/csp/sources.html", "#zl-csp-src");
    await waitFor("flag-off sources settle", 30000, () =>
      probe.frame.evaluate("(() => window.__zlSrc && window.__zlSrc.settled === true)()"));
    const ran = await probe.frame.evaluate("(() => window.__zlEvilRan === true)()");
    eq(ran, true, "the engine must not gate source lists while the flag is off");
    await probe.page.close();
    return "cross-origin script loaded unenforced; no marker served";
  });

  /* ---- enable the experimental enforcement ---- */

  const gate = await openProxied(ORIGIN + "/csp/candidate.html", "#zl-csp-marker");
  const ack = await pushConfig(gate.page, { experimental: { cspTranslation: true } });
  eq(ack.experimental.effective.cspTranslation, true, "the ack did not report the flag effective");
  eq(ack.experimental.status.cspTranslation, "deny-only+engine-source-lists", "the ack did not report the deny-only+engine status");
  await gate.page.close();

  /* ---- the enforcement matrix, direct versus proxied ---- */

  let directState = null;
  await check("direct oracle: the candidate policy blocks exactly the five deny-only classes", async () => {
    const pg = await directPage("/csp/candidate.html");
    directState = JSON.parse(await collectState(pg, "direct candidate"));
    await pg.close();
    const v = [...directState.violations].sort();
    eq(JSON.stringify(v), JSON.stringify(EXPECTED_VIOLATIONS), "the direct violation set diverged");
    eq(directState.done, true, "the direct oracle page did not survive its own blocked form");
    return "violations " + v.join(",") + "; allow side intact";
  });

  await check("enforced proxied: the same five violations as the direct oracle, allow side intact", async () => {
    const probe = await openProxied(ORIGIN + "/csp/candidate.html", "#zl-csp-marker");
    const st = JSON.parse(await collectState(probe.frame, "proxied candidate"));
    const v = [...st.violations].sort();
    eq(JSON.stringify(v), JSON.stringify([...directState.violations].sort()), "the proxied violation set diverged from the direct oracle");
    eq(JSON.stringify(v), JSON.stringify(EXPECTED_VIOLATIONS), "the proxied violation set is not the deny-only expectation");
    eq(st.done, true, "the proxied page did not survive its own blocked form");
    eq(st.img, true, "the proxied page image did not load (allow side regressed)");
    eq(st.fetch, true, "the proxied page fetch did not resolve (allow side regressed)");
    await probe.page.close();
    return "identical violation set; image and fetch intact";
  });

  await check("the served policy is identical to the direct oracle and grants nothing on the shared origin", async () => {
    const t = await topLevelHeaders("/csp/candidate.html");
    const directResp = await fetch(ORIGIN + "/csp/candidate.html");
    eq(t.headers["content-security-policy"], CANDIDATE_CSP, "the proxied policy diverged from the upstream policy");
    eq(t.headers["content-security-policy"], directResp.headers.get("content-security-policy"), "the proxied policy diverged from the direct oracle");
    eq(t.headers["x-zl-csp"], "enforced frame-src,worker-src,object-src,base-uri,form-action", "the marker did not name the translated directives");
    assert(!t.headers["content-security-policy"].includes("://"), "the served policy carries an origin");
    assert(!t.headers["content-security-policy"].includes("'self'"), "the served policy carries a self grant");
    assert(!t.headers["content-security-policy"].includes(ENGINE), "the served policy carries the engine origin");
    return "policy byte-identical, marker exact";
  });

  /* ---- the unsupported policy: stripped, visible, never widened ---- */

  await check("unsupported policy: stripped and visibly reported, page functional", async () => {
    const t = await topLevelHeaders("/csp/unsupported.html");
    eq(t.headers["content-security-policy"], undefined, "an unsupported policy must stay stripped");
    eq(t.headers["x-zl-csp"], "unsupported unsupported-directive; engine script-src,img-src",
      "the marker must compose the typed reason with the engine-enforced directives");
    const probe = await openProxied(ORIGIN + "/csp/unsupported.html", "#zl-csp-unsupported");
    const st = JSON.parse(await collectState(probe.frame, "proxied unsupported"));
    eq(st.live, true, "the proxied page inline script did not run (the engine cannot honor script-src self, the page must not break)");
    eq(st.img, true, "the proxied page image did not load");
    await probe.page.close();
    return "stripped, marked unsupported-directive, page functional";
  });

  await check("unsupported policy divergence is honest: the direct oracle blocks the inline script", async () => {
    const pg = await directPage("/csp/unsupported.html");
    await sleep(1500);
    const live = await pg.evaluate("(() => (window.__zlCspLive && window.__zlCspLive.live) === true)()");
    eq(live, false, "the direct oracle should honor script-src self and block the inline script");
    await pg.close();
    return "documented divergence pinned: proxied runs, direct blocks";
  });

  /* ---- report-only: never enforced, never marked ---- */

  await check("report-only policy: unenforced and unmarked in both modes", async () => {
    const t = await topLevelHeaders("/csp/report-only.html");
    eq(t.headers["content-security-policy"], undefined, "report-only must never be enforced");
    eq(t.headers["content-security-policy-report-only"], undefined, "report-only must stay stripped");
    eq(t.headers["x-zl-csp"], undefined, "no enforcing policy means no decision marker");
    const probe = await openProxied(ORIGIN + "/csp/report-only.html", "#zl-csp-reportonly");
    const st = JSON.parse(await collectState(probe.frame, "proxied report-only"));
    eq(st.live, true, "the proxied report-only page inline script did not run");
    await probe.page.close();
    return "unforced and unmarked, as documented";
  });

  /* ---- meta policy: consistent with the header path ---- */

  await check("meta policy: dropped by the rewriter, consistent with the stripped header path", async () => {
    const t = await topLevelHeaders("/csp/meta.html");
    eq(t.headers["x-zl-csp"], undefined, "no header policy means no decision marker");
    assert(!/http-equiv[^>]*content-security-policy/i.test(t.body), "a CSP meta tag survived the rewriter");
    const probe = await openProxied(ORIGIN + "/csp/meta.html", "#zl-csp-meta");
    const st = JSON.parse(await collectState(probe.frame, "proxied meta"));
    eq(st.live, true, "the proxied page inline script did not run after meta removal");
    await probe.page.close();
    return "meta dropped, page functional, no marker";
  });

  await check("meta policy divergence is honest: the direct oracle honors the meta policy", async () => {
    const pg = await directPage("/csp/meta.html");
    await sleep(1500);
    const live = await pg.evaluate("(() => (window.__zlCspLive && window.__zlCspLive.live) === true)()");
    eq(live, false, "the direct oracle should honor the meta policy and block the inline script");
    await pg.close();
    return "documented divergence pinned: proxied runs, direct blocks";
  });

  /* ---- #527: engine-side source-list enforcement ---- */

  await check("direct oracle: the sources policy blocks script-src, img-src and connect-src cross-origin", async () => {
    const pg = await directPage("/csp/sources.html");
    await sleep(3000);
    const st = JSON.parse(await pg.evaluate("(() => JSON.stringify(window.__zlSrc ?? null))()"));
    assert(st !== null, "the direct sources probe script did not run (script-src self allows it)");
    const v = [...st.violations].sort();
    for (const d of ["connect-src", "img-src", "script-src"]) {
      assert(v.indexOf(d) !== -1 || v.indexOf(d + "-elem") !== -1,
        "the direct oracle did not block " + d + " (violations: " + v.join(",") + ")");
    }
    eq(st.okImg, true, "the direct allow-side image did not load");
    eq(st.okFetch, true, "the direct allow-side fetch did not resolve");
    eq(st.badFetch, "blocked", "the direct oracle did not block the cross-origin fetch");
    const ran = await pg.evaluate("(() => window.__zlEvilRan === true)()");
    eq(ran, false, "the direct oracle must not run the cross-origin script");
    await pg.close();
    return "violations " + v.join(",");
  });

  await check("engine gate: cross-origin script, image and fetch blocked, allow side intact, zero upstream hits", async () => {
    const before =
      (HITS.get("/csp/evil.js") || 0) + (HITS.get("/csp/evil.png") || 0) + (HITS.get("/csp/evil-api") || 0);
    const probe = await openProxied(ORIGIN + "/csp/sources.html", "#zl-csp-src");
    await waitFor("proxied sources settle", 30000, () =>
      probe.frame.evaluate("(() => window.__zlSrc && window.__zlSrc.settled === true)()"));
    const st = JSON.parse(await probe.frame.evaluate("(() => JSON.stringify(window.__zlSrc))()"));
    eq(st.okImg, true, "the proxied allow-side image did not load (false block)");
    eq(st.okFetch, true, "the proxied allow-side fetch did not resolve (false block)");
    eq(st.badFetch, "blocked", "the engine did not block the cross-origin fetch (connect-src)");
    const ran = await probe.frame.evaluate("(() => window.__zlEvilRan === true)()");
    eq(ran, false, "the engine did not block the cross-origin script (script-src)");
    const evilImg = await probe.frame.evaluate(
      "(() => { var i = document.getElementById('zl-evil-img'); return !!(i && i.complete && i.naturalWidth > 0); })()",
    );
    eq(evilImg, false, "the engine did not block the cross-origin image (img-src)");
    const after =
      (HITS.get("/csp/evil.js") || 0) + (HITS.get("/csp/evil.png") || 0) + (HITS.get("/csp/evil-api") || 0);
    eq(after, before, "a blocked load reached the upstream fixture (the gate must decide before transport)");
    await probe.page.close();
    return "script, image and fetch blocked at the seam; zero upstream hits";
  });

  await check("the sources decision is visible: x-zl-csp names the engine-enforced directives", async () => {
    const t = await topLevelHeaders("/csp/sources.html");
    eq(t.headers["content-security-policy"], undefined, "a source-list policy must never reach the browser");
    eq(t.headers["x-zl-csp"], "unsupported unsupported-directive; engine script-src,img-src,connect-src",
      "the composed marker diverged");
    return "marker exact";
  });

  await check("default-src fallback: cross-origin classes blocked via the fallback, marker names it", async () => {
    const t = await topLevelHeaders("/csp/default.html");
    eq(t.headers["x-zl-csp"], "unsupported unsupported-directive; engine default-src",
      "the default-src marker diverged");
    const probe = await openProxied(ORIGIN + "/csp/default.html", "#zl-csp-def");
    await waitFor("proxied default settle", 30000, () =>
      probe.frame.evaluate("(() => window.__zlSrc && window.__zlSrc.settled === true)()"));
    const st = JSON.parse(await probe.frame.evaluate("(() => JSON.stringify(window.__zlSrc))()"));
    eq(st.okImg, true, "the allow-side image did not load under default-src self");
    eq(st.okFetch, true, "the allow-side fetch did not resolve under default-src self");
    eq(st.badFetch, "blocked", "the engine did not enforce the connect-src fallback");
    const evilImg = await probe.frame.evaluate(
      "(() => { var i = document.getElementById('zl-evil-img'); return !!(i && i.complete && i.naturalWidth > 0); })()",
    );
    eq(evilImg, false, "the engine did not enforce the img-src fallback");
    const ran = await probe.frame.evaluate("(() => window.__zlEvilRan === true)()");
    eq(ran, false, "the engine did not enforce the script-src fallback");
    await probe.page.close();
    return "fallback blocks all three classes; allow side intact";
  });

  await check("direct oracle: default-src self blocks the same cross-origin classes", async () => {
    const pg = await directPage("/csp/default.html");
    await sleep(3000);
    const st = JSON.parse(await pg.evaluate("(() => JSON.stringify(window.__zlSrc ?? null))()"));
    assert(st !== null, "the direct default probe script did not run (default-src self allows it)");
    const v = st.violations;
    for (const d of ["connect-src", "img-src", "script-src"]) {
      assert(v.indexOf(d) !== -1 || v.indexOf(d + "-elem") !== -1,
        "the direct default oracle did not block " + d + " (violations: " + v.join(",") + ")");
    }
    eq(st.okImg, true, "the direct default allow-side image did not load");
    eq(st.okFetch, true, "the direct default allow-side fetch did not resolve");
    const ran = await pg.evaluate("(() => window.__zlEvilRan === true)()");
    eq(ran, false, "the direct default oracle must not run the cross-origin script");
    await pg.close();
    return "violations " + v.join(",");
  });

  await check("nonce/strict-dynamic: script-src degrades to a visible false allow, img-src stays enforced", async () => {
    const t = await topLevelHeaders("/csp/nonce.html");
    eq(t.headers["x-zl-csp"],
      "unsupported unsupported-directive; engine img-src; engine-unsupported script-src",
      "the nonce marker diverged");
    const before = HITS.get("/csp/evil.js") || 0;
    const probe = await openProxied(ORIGIN + "/csp/nonce.html", "#zl-csp-nonce");
    await waitFor("proxied nonce settle", 30000, () =>
      probe.frame.evaluate("(() => window.__zlSrc && window.__zlSrc.settled === true)()"));
    const ran = await probe.frame.evaluate("(() => window.__zlEvilRan === true)()");
    eq(ran, true, "the unverifiable script-src must degrade to a false allow (pinned divergence)");
    eq((HITS.get("/csp/evil.js") || 0), before + 1, "the false-allow script must have hit upstream");
    const evilImg = await probe.frame.evaluate(
      "(() => { var i = document.getElementById('zl-evil-img'); return !!(i && i.complete && i.naturalWidth > 0); })()",
    );
    eq(evilImg, false, "img-src self must stay enforced beside the degraded script-src");
    await probe.page.close();
    return "script-src false-allow pinned; img-src enforcement intact";
  });

  await check("direct oracle: the nonce policy blocks the nonceless probe and remote scripts", async () => {
    const pg = await directPage("/csp/nonce.html");
    await sleep(3000);
    const state = await pg.evaluate("(() => JSON.stringify(window.__zlSrc ?? null))()");
    eq(state, "null", "the direct nonce oracle must block the nonceless probe script");
    const ran = await pg.evaluate("(() => window.__zlEvilRan === true)()");
    eq(ran, false, "the direct nonce oracle must block the nonceless remote script");
    await pg.close();
    return "documented divergence pinned: proxied runs, direct blocks";
  });

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("== csp-enforce summary: " + (results.length - failed.length) + " passed, " + failed.length + " failed ==");
  console.log("== E2E-JSON == " + JSON.stringify({ suite: "csp-enforce", passed: results.length - failed.length, failed: failed.length, failures: failed.map((r) => r.name) }));
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
      if (fixture) fixture.close();
    } catch {}
    try {
      if (fixture2) fixture2.close();
    } catch {}
    try {
      if (engineProc) engineProc.kill();
    } catch {}
  });
