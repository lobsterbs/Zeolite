/* Issue #538 (#549 child): real-Chromium acceptance for the guest
   Service Worker lifecycle. The unit suites cover the kernel in
   isolation; this suite proves the full loop through a genuine
   browser: a proxied page registers its guest, the engine fetches
   and runs the script in the guest-host realm, install/activate
   settle under waitUntil, the guest's CacheStorage serves page
   fetches with no further upstream hits once warmed,
   clients.matchAll()/claim() resolve, registration.update() swaps
   the realm on changed bytes while the caches survive, and
   unregister() tears everything down so the plain engine path
   serves again.

   Everything is loopback fixtures only (same rule as e2e.mjs): the
   guest script, its upstream API, and the assertions never leave
   127.0.0.1. Ports are deliberately NOT the e2e.mjs ones so this
   suite can run beside a parallel e2e run. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ENGINE_PORT = 6009;
const FX_PORT = 7109;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const FX = "http://127.0.0.1:" + FX_PORT;

const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let context = null;
let fxServer = null;

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

/* ---- fixture origin (mutable on purpose: the update check flips
   the guest script between v1 and v2) ------------------------------- */

/* The guest script runs inside the guest harness (strict mode), not
   a real ServiceWorkerGlobalScope. It uses exactly the documented
   harness surface: addEventListener for install/activate/fetch,
   event.waitUntil, event.respondWith, self.fetch through the engine
   bridge, self.caches, self.clients, self.registration.update. */
const GUEST_V1 = [
  'var M = "guest-v1";',
  "self.__zlAct = \"no-activate\";",
  "self.__zlClients = \"no-clients\";",
  "self.addEventListener(\"install\", function (e) {",
  "  e.waitUntil(self.clients.matchAll().then(function (list) {",
  "    self.__zlClients = \"ok:\" + list.length;",
  "    return self.clients.claim();",
  "  }).then(function () {",
  "    return self.caches.open(\"v1\");",
  "  }).then(function (c) {",
  "    return self.fetch(\"/dir/api/data\").then(function (r) { return c.put(\"/dir/api/data\", r); });",
  "  }));",
  "});",
  "self.addEventListener(\"activate\", function (e) {",
  "  e.waitUntil(new Promise(function (res) { self.__zlAct = \"activated-\" + M; res(); }));",
  "});",
  "self.addEventListener(\"fetch\", function (e) {",
  "  var p = new URL(e.request.url).pathname;",
  "  if (p === \"/dir/api/data\") {",
  "    e.respondWith(self.caches.match(\"/dir/api/data\").then(function (hit) {",
  "      if (hit) { return hit.text().then(function (t) {",
  "        return { status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M + \"-cache\" }, body: M + \"-cache:\" + t };",
  "      }); }",
  "      return { status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M }, body: M + \":no-cache\" };",
  "    }));",
  "  } else if (p === \"/dir/state\") {",
  "    e.respondWith(Promise.resolve({ status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M }, body: M + \"|\" + self.__zlAct + \"|\" + self.__zlClients }));",
  "  } else if (p === \"/dir/app/state\") {",
  "    e.respondWith(Promise.resolve({ status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M + \"-parent\" }, body: M + \"-parent-fallback\" }));",
  "  } else if (p === \"/dir/update-me\") {",
  "    e.respondWith(Promise.resolve({ status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M }, body: \"updating\" }));",
  "    self.registration.update();",
  "  }",
  "});",
  "",
].join("\n");

/* A more-specific same-origin scope must win over GUEST_V1's
   /dir/ scope. Unregistering it must reveal the parent guest again. */
const GUEST_NESTED = [
  'var M = "guest-nested";',
  "self.addEventListener(\"fetch\", function (e) {",
  "  if (new URL(e.request.url).pathname === \"/dir/app/state\") {",
  "    e.respondWith(Promise.resolve({ status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M }, body: M }));",
  "  }",
  "});",
  "",
].join("\n");

/* v2 proves the update swap AND that the v1 cache survived it: its
   install warms nothing, so the /dir/api/data answer can only come
   from the preserved cache entry. */
const GUEST_V2 = [
  'var M = "guest-v2";',
  "self.__zlAct = \"no-activate\";",
  "self.__zlClients = \"no-clients\";",
  "self.addEventListener(\"install\", function (e) {",
  "  e.waitUntil(self.clients.matchAll().then(function (list) {",
  "    self.__zlClients = \"ok:\" + list.length;",
  "    return self.clients.claim();",
  "  }));",
  "});",
  "self.addEventListener(\"activate\", function (e) {",
  "  e.waitUntil(new Promise(function (res) { self.__zlAct = \"activated-\" + M; res(); }));",
  "});",
  "self.addEventListener(\"fetch\", function (e) {",
  "  var p = new URL(e.request.url).pathname;",
  "  if (p === \"/dir/api/data\") {",
  "    e.respondWith(self.caches.match(\"/dir/api/data\").then(function (hit) {",
  "      if (hit) { return hit.text().then(function (t) {",
  "        return { status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M + \"-cache\" }, body: M + \"-cache:\" + t };",
  "      }); }",
  "      return { status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M }, body: M + \":no-cache\" };",
  "    }));",
  "  } else if (p === \"/dir/state\") {",
  "    e.respondWith(Promise.resolve({ status: 200, headers: { \"content-type\": \"text/plain\", \"x-zl-guest\": M }, body: M + \"|\" + self.__zlAct + \"|\" + self.__zlClients }));",
  "  }",
  "});",
  "",
].join("\n");

const fx = { script: GUEST_V1, hits: new Map() };

function fxCount(path) {
  return fx.hits.get(path) ?? 0;
}

function startFixture(port) {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/__hits") fx.hits.set(path, fxCount(path) + 1);
    if (path === "/dir/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><p id="zl-guest">guest-page</p>');
    } else if (path === "/dir/early.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      /* #576: the EARLIEST registration, from an inline head script,
         with an ABSOLUTE URL literal the JS rewriter mints into an
         engine token route: proves the decode path end to end in a
         real browser. */
      res.end(
        '<!doctype html><head><script>' +
        'window.__zlEarly = { state: "pending" };' +
        'navigator.serviceWorker.register("' + FX + '/dir/sw.js")' +
        '.then(function (r) { window.__zlEarly = { state: "ok", scope: r.scope }; })' +
        '.catch(function (e) { window.__zlEarly = { state: "error", error: String(e && e.message || e) }; });' +
        '</script></head><body><p id="zl-early">early-page</p></body>'
      );
    } else if (path === "/dir/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(fx.script);
    } else if (path === "/dir/app/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(GUEST_NESTED);
    } else if (path === "/dir/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"zl":"api"}');
    } else if (path === "/dir/state") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fixture-state");
    } else if (path === "/dir/update-me") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fixture-update");
    } else if (path === "/__hits") {
      const out = {};
      for (const [k, v] of fx.hits) out[k] = v;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/* ---- engine + browser harness (same shape as e2e.mjs) -------------- */

function engineTail() {
  return engineErr.slice(-30).join("");
}

async function startEngine() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  engineProc = spawn(bin, ["--port", String(ENGINE_PORT), "--static", resolve("app/dist")], {
    env: {
      ...process.env,
      /* Test-only SSRF hatch: the engine may reach the loopback
         fixture origin. Same two-key escape the compat job uses. */
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

async function frameWith(pg, sel) {
  for (const f of pg.frames()) {
    try {
      if (!f.url().startsWith(ENGINE + "/j/")) continue;
      if ((await f.locator(sel).count()) > 0) return f;
    } catch {}
  }
  return null;
}

async function openProxied(target, marker) {
  const pg = await context.newPage();
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  let frame = null;
  try {
    frame = await waitFor("proxied frame for " + target, 90000, () => frameWith(pg, marker));
  } catch (e) {
    /* Loud failure evidence: embedder status, every frame URL, and
       each frame's body snippet. Without this a wedged embed is a
       bare timeout line. */
    const status = await pg
      .evaluate(() => document.getElementById("zl-status")?.textContent ?? "(no status node)")
      .catch(() => "(page evaluate failed)");
    const frames = [];
    for (const f of pg.frames()) {
      let snippet = "(no body)";
      try {
        snippet = (await f.evaluate(() => document.body ? document.body.innerHTML.slice(0, 200) : "(no body)")) ?? snippet;
      } catch {}
      frames.push(f.url() + " :: " + snippet);
    }
    throw new Error(e.message + "; embedder status: " + status + "; frames: " + JSON.stringify(frames));
  }
  return { page: pg, frame };
}

/* Playwright treats a string argument to evaluate() as an EXPRESSION,
   never a function: wrap like e2e.mjs does or every probe silently
   evaluates to undefined. */
async function evalIn(frame, label, js, timeoutMs = 15000) {
  return await Promise.race([
    frame.evaluate("(" + js + ")()"),
    sleep(timeoutMs).then(() => {
      throw new Error(label + ": page evaluate timed out");
    }),
  ]);
}

/* One proxied fetch, reduced to the facts under test. */
async function guestFetch(frame, path) {
  return await evalIn(
    frame,
    "fetch " + path,
    'function(){return fetch("' + path + '").then(function(r){return r.text().then(function(t){' +
      'return {status:r.status, body:t, guest:r.headers.get("x-zl-guest")};});});}',
  );
}

async function main() {
  fxServer = await startFixture(FX_PORT);
  await startEngine();
  browser = await chromium.launch();
  context = await browser.newContext();

  let page = null;
  let frame = null;
  let reg = null;

  /* #576: honest registration end to end. The early page registers
     from an inline head script with an ABSOLUTE URL literal (minted
     into an engine token by the JS rewriter) while NO guest host
     page exists: the promise must reject with the kernel's real
     reason, leave no registration behind, and a re-register after
     the host lands must succeed. */
  let early = null;
  await check("early absolute-URL registration with no guest host rejects honestly", async () => {
    const opened = await openProxied(FX + "/dir/early.html", "#zl-early");
    early = opened.frame;
    const st = await waitFor("honest early rejection", 20000, () =>
      evalIn(
        early,
        "early register state",
        'function(){var s = window.__zlEarly && window.__zlEarly.state; return (s === "error" || s === "ok") ? window.__zlEarly : null;}',
      ),
    );
    if (st.state !== "error" || String(st.error).indexOf("no guest host page connected") === -1) {
      throw new Error("unexpected early result: " + JSON.stringify(st));
    }
    const gone = await evalIn(
      early,
      "getRegistration after rejection",
      'function(){return navigator.serviceWorker.getRegistration().then(function(r){return r ? {present:true, scope:r.scope} : {present:false};});}',
    );
    if (gone.present) {
      throw new Error("rejected registration left a record: " + JSON.stringify(gone));
    }
    return "rejected with: " + st.error;
  });

  await check("re-register succeeds once the guest host page lands", async () => {
    const host = await context.newPage();
    await host.goto(ENGINE + "/guest-host.html");
    const status = await waitFor("guest host ready", 20000, () =>
      host.evaluate(() => document.getElementById("status")?.textContent ?? ""),
    );
    if (status !== "guest host ready") throw new Error("guest host status: " + status);
    const reg2 = await evalIn(
      early,
      "re-register guest",
      'function(){return navigator.serviceWorker.register("' + FX + '/dir/sw.js").then(function(r){return {scope:r.scope, state:r.active ? r.active.state : (r.installing ? r.installing.state : "none")};});}',
    );
    if (!reg2 || typeof reg2.scope !== "string" || reg2.scope.indexOf("/dir/") === -1) {
      throw new Error("unexpected re-registration: " + JSON.stringify(reg2));
    }
    const st = await waitFor("early page guest answers", 30000, () =>
      evalIn(
        early,
        "early page state fetch",
        'function(){return fetch("/dir/state").then(function(r){return r.text().then(function(t){return {body:t, guest:r.headers.get("x-zl-guest")};});});}',
      ).then((s) => (s && s.guest === "guest-v1" ? s : null)),
    );
    if (String(st.body).indexOf("activated-guest-v1") === -1) {
      throw new Error("guest state unexpected: " + JSON.stringify(st));
    }
    return "scope " + reg2.scope;
  });

  await check("proxied page + guest host page come up", async () => {
    const opened = await openProxied(FX + "/dir/page.html", "#zl-guest");
    page = opened.page;
    frame = opened.frame;
    /* The guest host page must be open and its zl:guestHost bridge
       registered BEFORE any guest can spawn. */
    const host = await context.newPage();
    await host.goto(ENGINE + "/guest-host.html");
    const status = await waitFor(
      "guest host ready",
      20000,
      () => host.evaluate(() => document.getElementById("status")?.textContent ?? ""),
    );
    if (status !== "guest host ready") throw new Error("guest host status: " + status);
    return "host ready";
  });

  await check("register() spawns the realm; install caches; fetch answered by the guest", async () => {
    reg = await evalIn(
      frame,
      "register guest",
      'function(){return navigator.serviceWorker.register("sw.js").then(function(r){' +
        'return {scope:r.scope,state:r.active?r.active.state:r.installing?r.installing.state:"none"};});}',
    );
    if (!reg || typeof reg.scope !== "string" || !reg.scope.includes("/dir/")) {
      throw new Error("unexpected registration: " + JSON.stringify(reg));
    }
    /* Spawn is async (script fetch + install); poll until the guest
       answers from its warmed cache. */
    const first = await waitFor("guest /dir/api/data answer", 30000, async () => {
      const r = await guestFetch(frame, "/dir/api/data");
      return r.guest === "guest-v1-cache" ? r : null;
    });
    if (first.body !== 'guest-v1-cache:{"zl":"api"}') {
      throw new Error("unexpected cached body: " + JSON.stringify(first.body));
    }
    return "scope " + reg.scope;
  });

  await check("guest CacheStorage serves repeat fetches; no further upstream hits", async () => {
    /* The spawn-window polls of the previous check may legitimately
       have gone through the engine path (a page fetch before the
       realm serves is plain network, exactly like a real browser
       during install), so this check starts from a clean counter. */
    fx.hits.delete("/dir/api/data");
    const again = await guestFetch(frame, "/dir/api/data");
    if (again.guest !== "guest-v1-cache" || again.body !== 'guest-v1-cache:{"zl":"api"}') {
      throw new Error("repeat fetch left the guest path: " + JSON.stringify(again));
    }
    const hits = await (await fetch(FX + "/__hits")).json();
    /* Zero further upstream GETs: the install-time bridge fetch
       already warmed the guest cache, and page fetches never reach
       the fixture while the guest owns the scope. */
    if ((hits["/dir/api/data"] ?? 0) !== 0) {
      throw new Error("expected 0 further upstream hits, got " + JSON.stringify(hits));
    }
    return "no further upstream hits";
  });

  await check("clients.matchAll()/claim() resolve; activate waitUntil is observable", async () => {
    const r = await waitFor("guest /dir/state", 15000, async () => {
      const s = await guestFetch(frame, "/dir/state");
      return s.guest === "guest-v1" ? s : null;
    });
    if (r.body !== "guest-v1|activated-guest-v1|ok:0") {
      throw new Error("unexpected guest state: " + JSON.stringify(r.body));
    }
    return r.body;
  });

  await check("multiple same-origin scopes route to the longest scope and unregister independently", async () => {
    const nested = await evalIn(
      frame,
      "register nested guest",
      'function(){return navigator.serviceWorker.register("/dir/app/sw.js", {scope:"/dir/app/"}).then(function(r){return {scope:r.scope};});}',
    );
    if (!nested.scope.endsWith("/dir/app/")) {
      throw new Error("nested registration scope mismatch: " + JSON.stringify(nested));
    }
    const registrations = await evalIn(
      frame,
      "list guest registrations",
      'function(){return navigator.serviceWorker.getRegistrations().then(function(rs){return rs.map(function(r){return r.scope;}).sort();});}',
    );
    if (registrations.length !== 2 || !registrations.some((s) => s.endsWith("/dir/")) ||
        !registrations.some((s) => s.endsWith("/dir/app/"))) {
      throw new Error("expected both scopes, got " + JSON.stringify(registrations));
    }
    const selected = await evalIn(
      frame,
      "select matching nested registration",
      'function(){return navigator.serviceWorker.getRegistration("/dir/app/page.html").then(function(r){return r && r.scope;});}',
    );
    if (!String(selected).endsWith("/dir/app/")) {
      throw new Error("getRegistration did not choose the longest scope: " + selected);
    }
    const before = await waitFor("nested guest fetch", 20000, async () => {
      const r = await guestFetch(frame, "/dir/app/state");
      return r.guest === "guest-nested" ? r : null;
    });
    if (before.body !== "guest-nested") throw new Error("nested guest did not intercept: " + JSON.stringify(before));

    const unregistered = await evalIn(
      frame,
      "unregister nested registration",
      'function(){return navigator.serviceWorker.getRegistration("/dir/app/page.html").then(function(r){return r.unregister();});}',
    );
    if (unregistered !== true) throw new Error("nested unregister failed: " + unregistered);
    const remaining = await evalIn(
      frame,
      "list remaining registration",
      'function(){return navigator.serviceWorker.getRegistrations().then(function(rs){return rs.map(function(r){return r.scope;});});}',
    );
    if (remaining.length !== 1 || !remaining[0].endsWith("/dir/")) {
      throw new Error("unregister removed the wrong scope: " + JSON.stringify(remaining));
    }
    const parentFallback = await waitFor("parent guest fallback", 20000, async () => {
      const r = await guestFetch(frame, "/dir/app/state");
      return r.guest === "guest-v1-parent" ? r : null;
    });
    if (parentFallback.body !== "guest-v1-parent-fallback") {
      throw new Error("parent guest did not resume: " + JSON.stringify(parentFallback));
    }
    return "nested scope won, then parent guest resumed after exact unregister";
  });

  await check("registration.update() swaps the realm on changed bytes; caches survive", async () => {
    fx.script = GUEST_V2;
    const upd = await guestFetch(frame, "/dir/update-me");
    if (upd.body !== "updating" || upd.guest !== "guest-v1") {
      throw new Error("update trigger fetch failed: " + JSON.stringify(upd));
    }
    const st = await waitFor("v2 realm active", 30000, async () => {
      const s = await guestFetch(frame, "/dir/state");
      return s.guest === "guest-v2" ? s : null;
    });
    if (st.body !== "guest-v2|activated-guest-v2|ok:0") {
      throw new Error("unexpected v2 state: " + JSON.stringify(st.body));
    }
    /* The v2 install warms nothing: this answer can only come from the
       cache entry v1 stored before the swap. */
    const cached = await guestFetch(frame, "/dir/api/data");
    if (cached.guest !== "guest-v2-cache" || cached.body !== 'guest-v2-cache:{"zl":"api"}') {
      throw new Error("cache did not survive the update swap: " + JSON.stringify(cached));
    }
    return "v2 serving preserved cache";
  });

  await check("unregister() terminates the realm; the engine path serves again", async () => {
    const out = await evalIn(
      frame,
      "unregister guest",
      'function(){return navigator.serviceWorker.getRegistration().then(function(r){' +
        "if(!r) return {ok:false, error:'no registration'}; return r.unregister().then(function(v){return {ok:v};});});}",
    );
    if (!out || out.ok !== true) {
      throw new Error("unregister failed: " + JSON.stringify(out));
    }
    const st = await waitFor("engine path after unregister", 30000, async () => {
      const s = await guestFetch(frame, "/dir/state");
      return s.guest === null ? s : null;
    });
    if (st.body !== "fixture-state") {
      throw new Error("engine path body unexpected: " + JSON.stringify(st));
    }
    const api = await guestFetch(frame, "/dir/api/data");
    if (api.guest !== null || api.body !== '{"zl":"api"}') {
      throw new Error("api fetch after unregister unexpected: " + JSON.stringify(api));
    }
    return "guest gone";
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? "  ok  " : "  FAIL") + " " + r.name);
  }
  console.log(results.length - failed.length + "/" + results.length + " guest-sw checks passed");
  if (failed.length > 0 || results.length === 0) {
    console.log("HARNESS-ERROR guest-sw suite failed; engine tail:\n" + engineTail());
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
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (engineProc) engineProc.kill("SIGKILL");
    } catch {}
    try {
      if (fxServer) fxServer.close();
    } catch {}
  });
