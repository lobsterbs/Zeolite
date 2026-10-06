/* Torture battery (issue #92): web-semantics probes that aggressively
   exercise the browser/network behaviors most likely to break in the
   engine, comparing DIRECT browser behavior against engine-proxied
   behavior on the same deterministic fixtures.

   This is the #35 harness's sibling, not its replacement: e2e.mjs
   owns the routing/API/privacy checks; this battery owns the
   compatibility matrix (methods, bodies, compression, redirects,
   cookies, CORS/preflight, forms, edge-case HTML/CSS/JS constructs).
   The helper set below deliberately mirrors e2e.mjs (engine boot,
   openProxied, evalIn): the two suites run as separate CI steps with
   their own engine processes, and sharing a module would put a
   refactor risk on the green #35 suite for no runtime win.

   Every check declares a failure CAUSE CLASS so a regression names
   the affected compatibility category (#92 acceptance):
   - interception  the SW never saw / mangled the request seam
   - routing       the engine route lost or corrupted the destination
   - transport     the wisp/libcurl layer changed wire semantics
   - rewriting     the streaming rewriter broke a construct
   - isolation     virtual-origin/isolation behavior diverged
   - browser-limitation  a documented gap that is PINNED here so a
     silent "fix" that changes page-visible behavior is caught

   NativeTransit vs RewriteFallback coverage (#92 acceptance): the
   fetch/XHR-shaped probes below exercise the NativeTransit pass-
   through path (whose contract e2e.mjs's #96 check enforces); the
   torture-page probes exercise RewriteFallback (the streaming
   rewriter). A check that pins a KNOWN deviation says so in its
   comment and asserts the deviation itself, never a fake pass.

   Machine-readable output: the == E2E-JSON == line at the end carries
   per-category pass/fail counts and failure names; CI greps [FAIL]
   lines for annotations. Adding a regression test = one more check()
   call; no infrastructure redesign.

   Honest gaps (documented, not faked): WebSocket targets need a TLS
   fixture (the engine upgrades ws to wss by design; loopback is plain
   HTTP), IDN hostnames need a real domain (the fixtures are loopback
   IPs), and downloads need a UI-observable harness (the #90 registry
   is unit-tested; a fetch-shaped attachment is just another body
   probe). None are covered here; all are listed in README.md.

   Run: node suite/e2e/torture.mjs   (same prerequisites as e2e.mjs) */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { startFixture, ORIGIN_A, ORIGIN_B } from "./fixtures.mjs";

const ENGINE = "http://127.0.0.1:6002";
const results = [];
const CATEGORIES = ["interception", "routing", "transport", "rewriting", "isolation", "browser-limitation"];
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

/* Every check carries its cause class; a failure prints and records
   it (the report groups failures per category). */
async function check(category, name, fn) {
  try {
    const detail = await fn();
    results.push({ category, name, ok: true });
    console.log("[PASS][" + category + "] " + name + (detail ? " | " + detail : ""));
  } catch (err) {
    results.push({ category, name, ok: false, error: String(err?.message ?? err) });
    console.log("[FAIL][" + category + "] " + name + " | " + String(err?.message ?? err));
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

/* Like e2e.mjs's openProxied but the marker selector is a parameter:
   the torture page carries its own #zl-marker, and nested-document
   probes (the iframe) use the inner marker. */
async function openProxied(target, sel = "#zl-marker") {
  const pg = await context.newPage();
  await pg.goto(ENGINE + "/?url=" + encodeURIComponent(target));
  let frame = null;
  try {
    frame = await waitFor("proxied frame for " + target, 45000, () => frameWith(pg, sel));
  } catch (e) {
    const status = await pg
      .evaluate(() => document.getElementById("zl-status")?.textContent ?? "(no status node)")
      .catch(() => "(page evaluate failed)");
    throw new Error(e.message + "; embedder status: " + status + "; url: " + pg.url());
  }
  return { page: pg, frame };
}

/* Playwright treats a string argument to evaluate() as an EXPRESSION
   (same lesson as e2e.mjs): wrap so the function is invoked. */
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
  engineProc = spawn(bin, ["--port", "6002", "--static", resolve("app/dist")], {
    env: {
      ...process.env,
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
}

async function fixtureHits(fx, path) {
  const hits = await (await fetch(fx.origin + "/__hits")).json();
  return path ? hits.filter((h) => h.path === path) : hits;
}

/* The #92 comparison model: the SAME probe function runs on a direct
   fixture-origin page (no engine anywhere) and inside the proxied
   page; the caller compares the two records. */
async function dualProbe(probeJs) {
  const directPage = await context.newPage();
  await directPage.goto(ORIGIN_A + "/dir/landing.html");
  const direct = JSON.parse(await directPage.evaluate("(" + probeJs + ")()"));
  await directPage.close();
  const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
  const proxied = JSON.parse(await evalIn(frame, "torture probe", probeJs, 45000));
  return { direct, proxied };
}

/* The rewriter checks share one direct + one proxied torture page:
   they probe the SAME served document from both sides. */
let torturePair = null;
async function torturePages() {
  if (!torturePair) {
    const directPage = await context.newPage();
    await directPage.goto(ORIGIN_A + "/dir/torture.html");
    const prox = await openProxied(ORIGIN_A + "/dir/torture.html");
    torturePair = { directPage, prox };
  }
  return torturePair;
}

/* Collect an image element's settled state (loaded or failed). */
const IMG_STATE_JS = `
  async (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !el.complete) await new Promise((r) => setTimeout(r, 100));
    return { nw: el.naturalWidth, src: String(el.currentSrc || el.src || "").slice(0, 300) };
  }
`;

async function main() {
  console.log("== Zeolite torture battery (issue #92) ==");
  fixtureA = await startFixture(7101);
  fixtureB = await startFixture(7102);
  await startEngine();
  browser = await chromium.launch();
  context = await browser.newContext();

  /* ---- interception --------------------------------------------- */

  await check("interception", "methods: GET/POST/PUT/PATCH/DELETE forward method, content-type and body; HEAD answers empty", async () => {
    const probe = `async () => {
      const out = {};
      const call = async (method, body) => {
        const r = await fetch("/api/methods", { method, headers: body ? { "content-type": "text/zl-t" } : {}, body: body ?? undefined });
        return JSON.parse(await r.text());
      };
      out.get = await call("GET");
      out.post = await call("POST", "m-body");
      out.put = await call("PUT", "m-body");
      out.patch = await call("PATCH", "m-body");
      out.del = await call("DELETE", "m-body");
      const h = await fetch("/api/methods", { method: "HEAD" });
      out.head = { status: h.status, text: await h.text() };
      return JSON.stringify(out);
    }`;
    const { direct, proxied } = await dualProbe(probe);
    for (const m of ["get", "post", "put", "patch", "del"]) {
      eq(proxied[m].method, direct[m].method, m + " method forwarded");
      eq(proxied[m].ct, direct[m].ct, m + " content-type forwarded");
      eq(proxied[m].body, direct[m].body, m + " body forwarded");
    }
    eq(proxied.head.status, direct.head.status, "HEAD status");
    eq(proxied.head.text, "", "HEAD body must stay empty");
    return "5 methods + HEAD matched direct vs proxied";
  });

  await check("interception", "forms: multipart FormData POST with a file lands field and file bytes", async () => {
    /* dualProbe JSON-parses the probe's return value, so the probe
       must return the echo's JSON TEXT - returning the parsed object
       would die as "[object Object]" on the direct side before the
       engine is ever tested. */
    const probe = `async () => {
      const fd = new FormData();
      fd.append("zlfield", "zl-val");
      fd.append("zlfile", new File(["zl-file-bytes"], "zl.txt", { type: "text/plain" }));
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      return await r.text();
    }`;
    const { direct, proxied } = await dualProbe(probe);
    assert(String(direct.ct).startsWith("multipart/form-data"), "direct model lost its multipart content-type (fixture regression)");
    assert(String(proxied.ct).startsWith("multipart/form-data"), "multipart content-type mangled: " + JSON.stringify(proxied.ct));
    for (const rec of [direct, proxied]) {
      assert(rec.body.includes('name="zlfield"') && rec.body.includes("zl-val"), "form field missing: " + rec.body.slice(0, 120));
      assert(rec.body.includes('name="zlfile"') && rec.body.includes("zl-file-bytes"), "file bytes missing: " + rec.body.slice(0, 120));
    }
    return "multipart field + file bytes preserved";
  });

  await check("interception", "auth: an Authorization header reaches the upstream request line", async () => {
    /* Same dualProbe contract: the probe returns a JSON string. */
    const probe = `async () => {
      const r = await fetch("/api/methods", { headers: { authorization: "Bearer zl-tok" } });
      return JSON.stringify(JSON.parse(await r.text()).auth);
    }`;
    const { direct, proxied } = await dualProbe(probe);
    eq(direct, "Bearer zl-tok", "direct model dropped the Authorization header (fixture regression)");
    eq(proxied, direct, "Authorization header not forwarded");
    return "authorization forwarded verbatim";
  });

  await check("interception", "data: and blob: URLs stay page-local and byte-identical", async () => {
    const probe = `async () => {
      const dr = await fetch("data:text/plain,zl-data-url");
      const blob = new Blob(["zl-blob-bytes"]);
      const br = await fetch(URL.createObjectURL(blob));
      return JSON.stringify({ d: await dr.text(), b: await br.text() });
    }`;
    const { direct, proxied } = await dualProbe(probe);
    eq(proxied.d, direct.d, "data: URL body");
    eq(proxied.b, direct.b, "blob: URL body");
    eq(proxied.d, "zl-data-url", "data: URL decoded wrong");
    return "data:/blob: untouched";
  });

  /* ---- transport -------------------------------------------------- */

  await check("transport", "compression: a gzip response decodes to the same text whichever layer decodes it", async () => {
    const probe = `async () => {
      const r = await fetch("/api/gzip");
      return JSON.stringify({ status: r.status, text: await r.text() });
    }`;
    const { direct, proxied } = await dualProbe(probe);
    eq(direct.text, "zl-gzip-body-0123456789", "direct model did not decode gzip (fixture regression)");
    eq(proxied.status, direct.status, "gzip status");
    eq(proxied.text, direct.text, "gzip-decoded text differs proxied vs direct");
    return "gzip body decoded identically";
  });

  await check("transport", "big body: ~1 MiB chunked response is byte-identical end to end", async () => {
    const probe = `async () => {
      const r = await fetch("/api/bigbody");
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      let chunks = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks++;
        text += dec.decode(value, { stream: true });
      }
      let sum = 0;
      for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i) * ((i % 17) + 1)) % 1000003;
      return JSON.stringify({ status: r.status, len: text.length, chunks, sum, first: text.slice(0, 24), last: text.slice(-24) });
    }`;
    const { direct, proxied } = await dualProbe(probe);
    assert(direct.chunks >= 8, "direct stream was not chunked (fixture regression): " + direct.chunks);
    eq(proxied.status, direct.status, "big body status");
    eq(proxied.len, direct.len, "big body length");
    eq(proxied.sum, direct.sum, "big body checksum");
    eq(proxied.first, direct.first, "big body head bytes");
    eq(proxied.last, direct.last, "big body tail bytes");
    assert(proxied.chunks >= 1, "engine delivered no chunks at all");
    return direct.len + " bytes matched (direct " + direct.chunks + " chunks, proxied " + proxied.chunks + ")";
  });

  await check("transport", "slow response: a 700ms TTFB completes with identical bytes", async () => {
    const probe = `async () => {
      const r = await fetch("/api/slow");
      return JSON.stringify({ status: r.status, text: await r.text() });
    }`;
    const { direct, proxied } = await dualProbe(probe);
    eq(proxied.status, direct.status, "slow status");
    eq(proxied.text, direct.text, "slow body");
    return "slow TTFB completed";
  });

  await check("transport", "status preservation: 204 empty, 418 and 500 with bodies surface as-is", async () => {
    const probe = `async () => {
      const a = await fetch("/beacon");
      const b = await fetch("/api/teapot");
      const c = await fetch("/api/fail");
      return JSON.stringify({
        noContent: { s: a.status, t: await a.text() },
        teapot: { s: b.status, t: await b.text() },
        fail: { s: c.status, t: await c.text() },
      });
    }`;
    const { direct, proxied } = await dualProbe(probe);
    eq(proxied.noContent.s, direct.noContent.s, "204 status");
    eq(proxied.noContent.t, direct.noContent.t, "204 body must stay empty");
    eq(proxied.teapot.s, direct.teapot.s, "418 status");
    eq(proxied.teapot.t, direct.teapot.t, "418 body");
    eq(proxied.fail.s, direct.fail.s, "500 status");
    eq(proxied.fail.t, direct.fail.t, "500 body");
    return "204/418/500 preserved";
  });

  await check("transport", "redirect semantics: 301/302/303 rewrite POST to GET, 307/308 preserve method and body", async () => {
    const probe = `async () => {
      const out = {};
      for (const code of [301, 302, 303, 307, 308]) {
        const r = await fetch("/api/redir" + code, { method: "POST", headers: { "content-type": "text/zl-t" }, body: "zl-redir-body" });
        out[code] = JSON.parse(await r.text());
      }
      return JSON.stringify(out);
    }`;
    const { direct, proxied } = await dualProbe(probe);
    /* Direct-model sanity: the browser must implement the spec table,
       or the comparison below compares against a broken oracle. */
    for (const code of [301, 302, 303]) {
      eq(direct[code].method, "GET", "direct " + code + " must land as GET (oracle sanity)");
      eq(direct[code].body, "", "direct " + code + " must drop the body (oracle sanity)");
    }
    for (const code of [307, 308]) {
      eq(direct[code].method, "POST", "direct " + code + " must preserve the method (oracle sanity)");
      eq(direct[code].body, "zl-redir-body", "direct " + code + " must preserve the body (oracle sanity)");
    }
    for (const code of [301, 302, 303, 307, 308]) {
      eq(proxied[code].method, direct[code].method, code + " final method differs");
      eq(proxied[code].body, direct[code].body, code + " final body differs");
      eq(proxied[code].ct, direct[code].ct, code + " final content-type differs");
    }
    return "5 redirect codes matched the direct oracle";
  });

  await check("transport", "redirect chains: 5 hops (inside the engine cap) and 15 hops (across it) both land on the final body", async () => {
    const probe = `async () => {
      const out = {};
      for (const n of [5, 15]) {
        const r = await fetch("/api/chain/" + n);
        out[n] = { status: r.status, echo: JSON.parse(await r.text()) };
      }
      return JSON.stringify(out);
    }`;
    const { direct, proxied } = await dualProbe(probe);
    for (const n of [5, 15]) {
      eq(direct[n].status, 200, "direct " + n + "-hop chain did not land (oracle sanity)");
      eq(proxied[n].status, direct[n].status, n + "-hop chain status");
      eq(proxied[n].echo.method, direct[n].echo.method, n + "-hop chain final method");
      eq(proxied[n].echo.url, direct[n].echo.url, n + "-hop chain final URL");
    }
    return "5- and 15-hop chains landed identically (the 15-hop case re-enters the engine past the hop cap)";
  });

  /* ---- routing ---------------------------------------------------- */

  await check("routing", "unicode and percent-encoded paths route exactly (encoded and literal spellings)", async () => {
    /* The delivered BYTES are the invariant, not the content-length
       header: the engine strips content-length by design (the
       transport delivers decoded bodies, see HOSTILE in
       app/src/headers.ts), so the direct oracle's header can never
       be compared against the proxied response's. */
    const probe = `async () => {
      const out = {};
      const u1 = await fetch("/dir/unicode/%C3%A5.png");
      out.enc = { status: u1.status, len: String((await u1.arrayBuffer()).byteLength) };
      const u2 = await fetch("/dir/unicode/å.png");
      out.raw = { status: u2.status, len: String((await u2.arrayBuffer()).byteLength) };
      return JSON.stringify(out);
    }`;
    const { direct, proxied } = await dualProbe(probe);
    eq(direct.enc.status, 200, "direct encoded-unicode fetch failed (oracle sanity)");
    eq(proxied.enc.status, direct.enc.status, "encoded unicode path status");
    eq(proxied.enc.len, direct.enc.len, "encoded unicode path length");
    eq(proxied.raw.status, direct.raw.status, "literal unicode path status");
    eq(proxied.raw.len, direct.raw.len, "literal unicode path length");
    return "unicode paths routed both spellings";
  });

  await check("routing", "query and path edges: a double-encoded query survives exactly once; a 2KB path routes", async () => {
    const probe = `async () => {
      const out = {};
      const q = await fetch("/api/echo?x=%2520y");
      out.dbl = JSON.parse(await q.text()).url;
      const lp = "/api/echo/" + "a".repeat(1800);
      const lr = await fetch(lp);
      out.long = { status: lr.status, url: JSON.parse(await lr.text()).url.slice(0, 40) };
      return JSON.stringify(out);
    }`;
    const { direct, proxied } = await dualProbe(probe);
    eq(direct.dbl, "/api/echo?x=%2520y", "direct double-encoded query (oracle sanity)");
    eq(proxied.dbl, direct.dbl, "double-encoded query forwarded wrong (re-decoded or dropped)");
    eq(proxied.long.status, direct.long.status, "2KB path status");
    eq(proxied.long.url, direct.long.url, "2KB path truncated");
    return "double-encoded query + 2KB path exact";
  });

  /* ---- rewriting -------------------------------------------------- */

  await check("rewriting", "torture page: CRLF-in-tag, unquoted/padded attributes, unicode src, srcset and iframe all resolve through engine routes", async () => {
    const { directPage, prox } = await torturePages();
    const collect = `
      async () => {
        const out = {};
        const imgState = async (id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline && !el.complete) await new Promise((r) => setTimeout(r, 100));
          return { nw: el.naturalWidth, src: String(el.currentSrc || el.src || "").slice(0, 300) };
        };
        out.crlf = await imgState("crlf");
        out.unq = await imgState("unq");
        out.spaced = await imgState("spaced");
        out.uni = await imgState("uni");
        /* #ss is srcset-only: decode-based probing of it is not a
           deterministic rewriter fact - the renderer can leave a
           srcset image undecoded via its in-process image cache (the
           e2e assets check documents the same flake, and CI hit it
           on the direct oracle twice, with both the element's own
           decode and a fresh-copy decode). The deterministic
           contract: the served srcset attribute carries the
           candidates and its first candidate SERVES through the
           page's own origin (a plain fetch is not subject to decode
           skipping). The record is printed on failure. */
        const ssEl = document.getElementById("ss");
        out.ss = await (async () => {
          const set = ssEl?.getAttribute("srcset") ?? "";
          const first = (set.split(",")[0] ?? "").trim().split(/\s+/)[0] ?? "";
          if (!first) return { set, url: "", status: 0, bytes: 0 };
          const url = new URL(first, document.baseURI).href;
          const r = await fetch(url);
          const bytes = (await r.arrayBuffer()).byteLength;
          return { set, url, status: r.status, bytes };
        })();
        const a = document.getElementById("relimg");
        out.relimg = a ? a.getAttribute("href") : null;
        /* The proxied frame is live as soon as the marker paints, which
           can be before the stylesheets apply: poll until all three
           background rules exist (or the deadline gives up honestly). */
        const bgOf = (id) => getComputedStyle(document.getElementById(id)).backgroundImage;
        const cssDeadline = Date.now() + 10000;
        while (Date.now() < cssDeadline && (!bgOf("tl-inl") || !bgOf("tl-ext") || !bgOf("tl-imp")))
          await new Promise((r) => setTimeout(r, 100));
        out.inl = bgOf("tl-inl");
        out.ext = bgOf("tl-ext");
        out.imp = bgOf("tl-imp");
        /* Absolute path, the same rerouted-engine-path shape the #35
           suite proved: a RELATIVE runtime fetch resolves against the
           opaque route, which is the documented pathname limitation. */
        out.css = await (await fetch("/dir/torture.css")).text();
        return JSON.stringify(out);
      }
    `;
    const direct = JSON.parse(await directPage.evaluate("(" + collect + ")()"));
    const proxied = JSON.parse(await evalIn(prox.frame, "torture page probes", collect, 45000));
    /* The iframe: the nested document must render through the engine. */
    const nested = await waitFor("proxied torture iframe", 20000, () => frameWith(prox.page, "#zl-inner-marker"));
    assert(nested, "torture page iframe did not render the proxied inner document");
    /* Direct sanity: every construct must serve without the engine
       (#ss is checked by fetch, not decode - see the probe above). */
    for (const id of ["crlf", "unq", "spaced", "uni"]) {
      assert(direct[id] && direct[id].nw > 0, "direct model failed to load img#" + id + " (fixture regression)");
    }
    assert(direct.ss && direct.ss.set, "direct model lost the srcset attribute (fixture regression): " + JSON.stringify(direct.ss));
    assert(direct.ss.status === 200 && direct.ss.bytes > 0, "direct srcset candidate does not serve (fixture regression): " + JSON.stringify(direct.ss));
    for (const id of ["crlf", "unq", "spaced", "uni"]) {
      assert(proxied[id] && proxied[id].nw > 0, "img#" + id + " did not load through the engine");
      assert(!proxied[id].src.includes(ORIGIN_A), "img#" + id + " resolved browser-direct to the fixture: " + proxied[id].src);
    }
    assert(proxied.ss && proxied.ss.set, "served page lost the srcset attribute: " + JSON.stringify(proxied.ss));
    assert(!proxied.ss.set.includes(ORIGIN_A), "served srcset kept a plaintext fixture URL: " + proxied.ss.set);
    assert(proxied.ss.status === 200 && proxied.ss.bytes > 0, "the served srcset candidate does not load through the engine: " + JSON.stringify(proxied.ss));
    assert(!proxied.ss.url.includes(ORIGIN_A), "srcset candidate resolved browser-direct: " + proxied.ss.url);
    for (const sel of ["inl", "ext", "imp"]) {
      assert(proxied[sel].includes("url("), "computed background for " + sel + " lost its url(): " + proxied[sel]);
      assert(!proxied[sel].includes(ORIGIN_A), "computed background for " + sel + " kept the plaintext fixture URL: " + proxied[sel]);
    }
    assert(proxied.css.includes("url("), "served torture.css lost its url() rules");
    assert(!proxied.css.includes('url("img.png")'), "served torture.css still carries a plaintext relative img.png url()");
    return "6 edge constructs + 3 css surfaces + iframe all routed";
  });

  await check("rewriting", "JS pass: a string-literal URL in an inline script is rewritten to an engine route and loads", async () => {
    const { prox } = await torturePages();
    /* IMG_STATE_JS takes the element id as its parameter; the old
       .replace() stripped the parameter but kept the body, so the
       probe died with ReferenceError: id. Keep the arrow intact and
       stringify its object result (evalIn results are JSON-parsed). */
    const probe = `async () => JSON.stringify(await (${IMG_STATE_JS})("tlit"))`;
    const state = JSON.parse(await evalIn(prox.frame, "literal img state", probe, 20000));
    assert(state && state.nw > 0, "the string-literal image did not load (rewriter URL-literal pass broken?): " + JSON.stringify(state));
    assert(!state.src.includes(ORIGIN_A), "string-literal image went browser-direct: " + state.src);
    return "literal URL rewritten and loaded via " + state.src.slice(0, 40) + "...";
  });

  /* ---- isolation -------------------------------------------------- */

  await check("isolation", "cookie lifecycle: a Set-Cookie lands and a Max-Age=0 deletion removes it", async () => {
    const probe = `async () => {
      const out = {};
      await fetch("/api/cookiestart");
      await new Promise((r) => setTimeout(r, 400));
      out.afterSet = JSON.parse(await (await fetch("/api/methods")).text()).cookie;
      await fetch("/api/cookiedel");
      await new Promise((r) => setTimeout(r, 400));
      out.afterDel = JSON.parse(await (await fetch("/api/methods")).text()).cookie;
      return JSON.stringify(out);
    }`;
    const { direct, proxied } = await dualProbe(probe);
    assert(String(direct.afterSet).includes("zlt=1"), "direct cookie did not land (oracle sanity)");
    assert(String(proxied.afterSet).includes("zlt=1"), "engine jar did not admit the cookie: " + JSON.stringify(proxied.afterSet));
    assert(!String(direct.afterDel).includes("zlt="), "direct deletion failed (oracle sanity)");
    assert(!String(proxied.afterDel).includes("zlt="), "engine jar did not honor the deletion: " + JSON.stringify(proxied.afterDel));
    return "set + delete honored";
  });

  await check("isolation", "Secure cookie divergence: loopback-direct sends it, the jar honors Secure against the real http target (pinned deviation)", async () => {
    const probe = `async () => {
      await fetch("/api/cookiesecure");
      await new Promise((r) => setTimeout(r, 400));
      return JSON.stringify({ cookie: JSON.parse(await (await fetch("/api/methods")).text()).cookie });
    }`;
    const { direct, proxied } = await dualProbe(probe);
    /* The DIRECT model: 127.0.0.1 is a trustworthy origin, so Chromium
       stores and sends Secure cookies over plain http. The ENGINE jar
       implements the attribute against the REAL target scheme: an
       http destination never carries a Secure cookie. Both behaviors
       are correct per their own rules; the divergence is the pinned,
       documented one. If this assert ever flips, the jar changed. */
    assert(String(direct.cookie).includes("zls=1"), "direct model lost the Secure cookie (oracle sanity): " + JSON.stringify(direct.cookie));
    assert(!String(proxied.cookie).includes("zls=1"), "engine attached a Secure cookie to an http target (jar behavior changed): " + JSON.stringify(proxied.cookie));
    return "documented divergence held (direct sends, jar does not)";
  });

  await check("isolation", "cross-origin PATCH with a custom header: direct preflights (OPTIONS on the wire), proxied succeeds same-virtual-origin", async () => {
    const before = (await fixtureHits(fixtureB, "/api/methods")).length;
    const probe = `async () => {
      const r = await fetch("${ORIGIN_B}/api/methods", { method: "PATCH", headers: { "content-type": "text/zl-t", "x-zl-probe": "cross" }, body: "zl-x-body" });
      return JSON.stringify({ status: r.status, echo: JSON.parse(await r.text()) });
    }`;
    const directPage = await context.newPage();
    await directPage.goto(ORIGIN_A + "/dir/landing.html");
    const direct = JSON.parse(await directPage.evaluate("(" + probe + ")()"));
    const optsAfterDirect = (await fixtureHits(fixtureB, "/api/methods")).filter((h) => h.method === "OPTIONS").length;
    await directPage.close();
    const { frame } = await openProxied(ORIGIN_A + "/dir/page.html");
    const proxied = JSON.parse(await evalIn(frame, "cross-origin PATCH probe", probe, 45000));
    assert(direct.status === 200, "direct cross-origin PATCH failed (oracle sanity): " + JSON.stringify(direct));
    assert(optsAfterDirect > 0, "direct model fired no preflight OPTIONS (oracle sanity)");
    eq(proxied.status, direct.status, "proxied cross-origin PATCH status");
    eq(proxied.echo.method, direct.echo.method, "proxied PATCH method");
    eq(proxied.echo.xzl, direct.echo.xzl, "custom header value differs");
    eq(proxied.echo.body, direct.echo.body, "PATCH body differs");
    return "preflight direct (" + optsAfterDirect + " OPTIONS hits) vs same-virtual-origin proxied; semantics equal";
  });

  /* ---- browser-limitation (pinned gaps) ---------------------------- */

  await check("rewriting", "runtime-concatenated URL loads through the engine (literal-prefix pass + bare-path resolution, former pinned gap)", async () => {
    const { directPage, prox } = await torturePages();
    const probe = `async () => JSON.stringify(await (${IMG_STATE_JS})("concat"))`;
    const d = JSON.parse(await directPage.evaluate("(" + probe + ")()"));
    const px = JSON.parse(await evalIn(prox.frame, "concat img", probe, 20000));
    assert(d.nw > 0, "direct model failed the runtime-concat image (oracle sanity)");
    /* The former pinned gap (the assembled URL is invisible to every
       static pass, so it must fail closed) closed from two directions:
       the JS literal pass rewrites the "/dir/" prefix to an absolute
       engine URL (the #tlit probe pins the same pass), and an
       assembled ABSOLUTE bare path is served to the bound client
       anyway - the page's own runtime fetch("/dir/torture.css")
       rides the same resolution. The pinned contract now: the
       assembled image LOADS through the engine and never escapes
       browser-direct. If nw drops back to 0, the literal pass or
       the bare-path resolution regressed. */
    assert(px.nw > 0, "runtime-concat image no longer loads through the engine (literal pass or bare-path resolution regressed)");
    assert(!px.src.includes(ORIGIN_A), "runtime-concat image escaped browser-direct: " + px.src);
    return "assembled URL loads via " + px.src.slice(0, 50);
  });

  await check("browser-limitation", "location.pathname stays the opaque engine route (LegacyUnforgeable, pinned)", async () => {
    const { prox } = await torturePages();
    const px = await evalIn(prox.frame, "pathname", `async () => location.pathname`, 10000);
    const { directPage } = await torturePages();
    const d = await directPage.evaluate("(() => location.pathname)()");
    /* window.location is LegacyUnforgeable: the engine cannot present
       the virtual destination's path on it. The page sees the opaque
       engine route. PINNED so a future virtualization change (which
       must not leak destinations per #32) is caught by CI. */
    assert(String(px).startsWith("/"), "pathname lost its shape: " + px);
    assert(!String(px).includes("torture"), "pathname suddenly exposes the destination path: " + px);
    assert(String(d) === "/dir/torture.html", "direct pathname (oracle sanity): " + d);
    return "opaque route on location.pathname held (direct: " + d + ")";
  });

  /* ---- report ------------------------------------------------------ */

  const failed = results.filter((r) => !r.ok);
  const cats = {};
  for (const c of CATEGORIES) {
    const rs = results.filter((r) => r.category === c);
    if (rs.length) {
      cats[c] = {
        passed: rs.filter((r) => r.ok).length,
        failed: rs.filter((r) => !r.ok).length,
        failures: rs.filter((r) => !r.ok).map((r) => r.name),
      };
    }
  }
  console.log("");
  console.log("== torture summary: " + (results.length - failed.length) + " passed, " + failed.length + " failed ==");
  console.log("== E2E-JSON == " + JSON.stringify({ suite: "torture", passed: results.length - failed.length, failed: failed.length, categories: cats }));
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
