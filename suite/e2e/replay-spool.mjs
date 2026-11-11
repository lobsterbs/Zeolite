/* #556 acceptance suite: redirect replay of large streamed request
   bodies through the OPFS spool (on by default since the #556
   follow-up; the no-spool pins below opt out explicitly via
   zl:config spoolUploads:false).

   Measured engine reality this suite pins (2026-10-31 session):

   1. Chromium never exposes Content-Length on a Service Worker
      intercepted request, so page uploads always take the
      unannounced branch and discover the replay cap mid-read.
   2. The vendored libcurl artifact full-buffers every request body
      into one ArrayBuffer inside the wasm heap before the upload;
      measured through the engine, an upload of 16 MiB kills the
      renderer process while 8 MiB rides fine. The spool removes the
      engine-side memory copies, but the artifact copy remains, so
      production-size (32 MiB) uploads cannot ride the wisp transport
      today with the stock artifact. The #556 fork
      (vendor/libcurljs, FORK-NOTES.md) adds the streaming read
      callback; the adapter feature-detects it in the served bundle
      and streams Blob/File bodies through it once it is vendored,
      with the bounded copy as the fallback.

   What this suite proves, at transport-safe sizes:

   - the below-cap matrix (1 MiB): 301/302/303 convert to GET with
     the body dropped, 307/308 replay method and body, against the
     direct browser oracle.
   - the spool matrix at a tightened cap (zl:config replayCapMb=3,
     4 MiB uploads): the SAME five codes plus a body-preserving 301
     PUT, a cross-origin hop and an Authorization header, all
     followed through the spooled File with byte-identical SHA-256
     against the direct oracle.
   - the honest failure pin: over the tightened cap with the spool
     opted out (zl:config spoolUploads false) the request fails with
     the documented 502 diagnostic, never a truncated body and never a
     crash.
   - the production ceiling pin: a 32 MiB + 1 upload without the
     spool fails with the same honest 502 (the read loop discards
     and throws before any transport copy), pinning the documented
     limitation until the artifact streams uploads.
   - the multi-chunk streamed body: an 8 KiB x 512 ReadableStream
     upload over the tightened cap replays byte-identical against the
     buffered direct oracle, exercising the spool write path in many
     chunks (and, once the forked artifact is vendored, the wasm read
     callback's pause/continue path).
   - the relay arm (#556 follow-up): on a second engine instance
     with a default-relay policy.kdl and a harness crediting relay
     port, a spooled over-cap File body crosses to the embedder by
     structured clone and rides the embedder native stack upstream,
     byte-identical against the direct oracle.

   Run: node suite/e2e/replay-spool.mjs (engines on 6025 and 6027,
   fixtures on 7125/7126 - never colliding with the other suites). */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { startFixture } from "./fixtures.mjs";

const ENGINE_PORT = 6025;
const FX_A = 7125;
const FX_B = 7126;
const RELAY_HOP_PORT = 7127;
const RELAY_HOP = "http://127.0.0.1:" + RELAY_HOP_PORT;
const ENGINE = "http://127.0.0.1:" + ENGINE_PORT;
const ORIGIN_A = "http://127.0.0.1:" + FX_A;
const ORIGIN_B = "http://127.0.0.1:" + FX_B;
/* #556 relay follow-up: a second engine instance on a port no other
   suite uses; its static tree carries a default-relay policy.kdl. */
const RELAY_ENGINE_PORT = 6027;
const RELAY_ENGINE = "http://127.0.0.1:" + RELAY_ENGINE_PORT;
const MI = 1024 * 1024;
/* one byte over the default 32 MiB replay cap */
const OVER_DEFAULT_CAP = 32 * MI + 1;
/* the tightened cap for the spool matrix and its over-cap size */
const TIGHT_CAP_MB = 3;
const OVER_TIGHT_CAP = (TIGHT_CAP_MB + 1) * MI;

const results = [];
let engineProc = null;
let engineErr = [];
let browser = null;
let context = null;
let fixtureA = null;
let fixtureB = null;
let engine2Proc = null;
let engine2Err = [];
let relayStaticDir = null;

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
async function frameWith(pg, sel, engineOrigin = ENGINE) {
  for (const f of pg.frames()) {
    try {
      if (!f.url().startsWith(engineOrigin + "/j/")) continue;
      if ((await f.locator(sel).count()) > 0) return f;
    } catch {}
  }
  return null;
}
async function openProxied(target, sel = "#zl-marker") {
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
/* #556 relay follow-up: the suite runs a second engine instance for
   the relay arm; both instances share the spawn recipe. */
async function startEngineOn(port, staticDir, errs, setProc) {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) {
    throw new Error("zeolite-server not built: " + bin + " (cargo build -p zeolite-server --release)");
  }
  const origin = "http://127.0.0.1:" + port;
  const proc = spawn(bin, ["--port", String(port), "--static", staticDir], {
    env: {
      ...process.env,
      ZL_TEST_ALLOW_PRIVATE_DESTS: "1",
      ZL_TEST_EGRESS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  setProc(proc);
  proc.stdout.on("data", (c) => errs.push(String(c)));
  proc.stderr.on("data", (c) => errs.push(String(c)));
  await waitFor("engine on " + origin, 60000, async () => {
    try {
      const r = await fetch(origin + "/");
      return r.status === 200;
    } catch {
      return false;
    }
  });
}

async function startEngine() {
  await startEngineOn(ENGINE_PORT, resolve("app/dist"), engineErr, (p) => (engineProc = p));
}

/* zl:config push with an ack echo assertion: the spool authorization
   and the replay cap knob ride the same message. */
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

/* Page-side probe: a deterministic byte pattern of n bytes, POSTed
   (or PUT) to the redirect endpoint, resolving the followed echo
   record. The same function string runs in the direct oracle page
   and in the proxied frame. */
/* #556: the multi-chunk probe: the body rides a ReadableStream that
   yields n bytes in chunk-size pieces, so the engine's spool (and,
   with the forked artifact, the wasm read callback) sees many small
   chunks instead of one buffer. The byte pattern matches probeJs
   exactly ((i * 7 + 13) & 255 over the whole body), so a buffered
   direct oracle is a valid SHA-256 comparison target. */
function probeJsStream(path, method, n, chunk, headers) {
  return `async () => {
    const chunkSize = ${chunk};
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= ${n}) { controller.close(); return; }
        const take = Math.min(chunkSize, ${n} - sent);
        const piece = new Uint8Array(take);
        for (let i = 0; i < take; i++) piece[i] = ((sent + i) * 7 + 13) & 255;
        sent += take;
        controller.enqueue(piece);
      },
    });
    const r = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers ?? {})},
      body,
      duplex: "half",
    });
    return JSON.stringify({ status: r.status, loc: r.headers.get("location") ?? "", body: await r.text() });
  }`;
}

function probeJs(path, method, n, headers) {
  return `async () => {
    const u8 = new Uint8Array(${n});
    for (let i = 0; i < u8.length; i++) u8[i] = (i * 7 + 13) & 255;
    const r = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers ?? {})},
      body: ${JSON.stringify(method)} === "GET" ? undefined : u8,
    });
    return JSON.stringify({ status: r.status, loc: r.headers.get("location") ?? "", body: await r.text() });
  }`;
}

async function probeDirect(code, method, n, opts = {}) {
  const pg = await context.newPage();
  await pg.goto(ORIGIN_A + "/dir/landing.html");
  const path = "/api/redirbody/" + code + (opts.cross ? "?to=" + encodeURIComponent(ORIGIN_B) : "");
  const out = JSON.parse(await pg.evaluate("(" + probeJs(path, method, n, opts.headers) + ")()"));
  await pg.close();
  return out;
}

async function probeProxied(frame, code, method, n, opts = {}) {
  const path = "/api/redirbody/" + code + (opts.cross ? "?to=" + encodeURIComponent(ORIGIN_B) : "");
  return JSON.parse(await evalIn(frame, "redirbody probe " + code, probeJs(path, method, n, opts.headers), 90000));
}

function compareEcho(direct, proxied, label, expectMethod, expectBytes) {
  eq(proxied.status, 200, label + ": the redirect did not follow to the echo");
  const d = JSON.parse(direct.body);
  const p = JSON.parse(proxied.body);
  eq(p.method, d.method, label + ": echo method diverged from the direct oracle");
  eq(p.method, expectMethod, label + ": echo method is not the fetch-spec expectation");
  eq(p.bytes, d.bytes, label + ": echoed byte count diverged from the direct oracle");
  eq(p.bytes, expectBytes, label + ": echoed byte count is not the expected upload size");
  eq(p.sha256, d.sha256, label + ": SHA-256 of the replayed body diverged from the direct oracle");
  eq(p.authorization, d.authorization, label + ": Authorization diverged from the direct oracle");
  eq(p.contentType, d.contentType, label + ": content type diverged from the direct oracle");
}

async function main() {
  console.log("== Zeolite large streamed-body redirect replay suite (issue #556) ==");
  fixtureA = await startFixture(FX_A);
  fixtureB = await startFixture(FX_B);
  await startEngine();
  browser = await chromium.launch();
  context = await browser.newContext();

  const prox = await openProxied(ORIGIN_A + "/dir/page.html");

  /* ---- the honest failure pin at the tightened cap ---- */

  await check("over the tightened cap with the spool opted out: the documented honest 502, never a crash", async () => {
    /* #556 follow-up: the spool is on by default, so this pin opts out
       explicitly - upload bytes must stay out of storage when the
       deployment refuses the spool. */
    const ack = await pushConfig(prox.page, { replayCapMb: TIGHT_CAP_MB, spoolUploads: false });
    eq(ack.replayCapMb, TIGHT_CAP_MB, "the ack did not echo the tightened replay cap");
    eq(ack.spoolUploads, false, "the ack did not echo the spool opt-out");
    const out = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP);
    eq(out.status, 502, "an over-cap upload without the spool authorization did not fail honestly");
    assert(
      out.body.includes("exceeds the replay buffer cap"),
      "the honest 502 does not name the replay cap: " + out.body.slice(0, 120),
    );
    return "502 naming the cap, as documented";
  });

  /* ---- the spool matrix at the tightened cap ---- */

  await pushConfig(prox.page, { spoolUploads: true });

  await check("spool: the same over-cap 307 now follows with byte-identical replay", async () => {
    const direct = await probeDirect(307, "POST", OVER_TIGHT_CAP);
    const proxied = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP);
    compareEcho(direct, proxied, "307 over-cap POST", "POST", OVER_TIGHT_CAP);
    return "followed; SHA-256 equal to the direct oracle at " + OVER_TIGHT_CAP + " bytes";
  });

  for (const [code, expectMethod] of [[301, "GET"], [302, "GET"], [303, "GET"], [307, "POST"], [308, "POST"]]) {
    await check("spool matrix over-cap " + code + " POST: spec method and body handling match the direct oracle", async () => {
      const direct = await probeDirect(code, "POST", OVER_TIGHT_CAP);
      const proxied = await probeProxied(prox.frame, code, "POST", OVER_TIGHT_CAP);
      compareEcho(direct, proxied, code + " over-cap POST", expectMethod, expectMethod === "POST" ? OVER_TIGHT_CAP : 0);
      return "echo method " + expectMethod + ", " + (expectMethod === "POST" ? OVER_TIGHT_CAP + " bytes replayed" : "body dropped per spec");
    });
  }

  await check("spool matrix over-cap 301 PUT: a body-preserving non-POST method follows through the spool", async () => {
    const direct = await probeDirect(301, "PUT", OVER_TIGHT_CAP);
    const proxied = await probeProxied(prox.frame, 301, "PUT", OVER_TIGHT_CAP);
    compareEcho(direct, proxied, "301 over-cap PUT", "PUT", OVER_TIGHT_CAP);
    return "PUT and body preserved, SHA-256 equal";
  });

  await check("spool matrix over-cap 307 cross-origin hop: lands on the second fixture origin like the direct oracle", async () => {
    const direct = await probeDirect(307, "POST", OVER_TIGHT_CAP, { cross: true });
    const proxied = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP, { cross: true });
    compareEcho(direct, proxied, "307 over-cap cross-origin POST", "POST", OVER_TIGHT_CAP);
    return "cross-origin replay, SHA-256 equal";
  });

  await check("spool matrix over-cap 307 with Authorization: survives a same-origin replay like the direct oracle", async () => {
    const direct = await probeDirect(307, "POST", OVER_TIGHT_CAP, { headers: { authorization: "Bearer zl-tok" } });
    const proxied = await probeProxied(prox.frame, 307, "POST", OVER_TIGHT_CAP, { headers: { authorization: "Bearer zl-tok" } });
    compareEcho(direct, proxied, "307 over-cap POST with Authorization", "POST", OVER_TIGHT_CAP);
    assert(JSON.parse(proxied.body).authorization === "Bearer zl-tok", "Authorization was lost on the replay");
    return "Authorization preserved, SHA-256 equal";
  });

  /* ---- the multi-chunk streamed body (pause/continue class) ---- */

  await check("spool multi-chunk stream: an 8 KiB x 512 streamed body over the tightened cap replays byte-identical", async () => {
    /* The direct oracle sends the same bytes buffered; the SHA-256
       comparison proves the chunked stream survived the spool and the
       replay exactly. 512 chunks also exceeds the wasm read-callback
       scratch buffer (64 KiB) many times over, so the forked
       artifact's pause/continue path is exercised once it is
       vendored; with the stock artifact the bounded copy path pins
       the same bytes. */
    const n = 512 * 8 * 1024;
    const direct = await probeDirect(307, "POST", n);
    const proxied = JSON.parse(await evalIn(prox.frame, "multi-chunk stream probe 307", probeJsStream("/api/redirbody/307", "POST", n, 8 * 1024), 90000));
    compareEcho(direct, proxied, "307 multi-chunk streamed POST", "POST", n);
    return "streamed in 512 chunks; SHA-256 equal to the buffered direct oracle";
  });

  /* ---- the below-cap matrix at the default cap ---- */

  await check("below-cap matrix restored cap: the knob returns the default 32", async () => {
    const ack = await pushConfig(prox.page, { replayCapMb: 32 });
    eq(ack.replayCapMb, 32, "the ack did not echo the restored replay cap");
    return "replayCapMb restored to 32";
  });

  for (const [code, expectMethod] of [[301, "GET"], [302, "GET"], [303, "GET"], [307, "POST"], [308, "POST"]]) {
    await check("below-cap " + code + " POST: method conversion and body handling match the direct oracle", async () => {
      const n = 1 * MI;
      const direct = await probeDirect(code, "POST", n);
      const proxied = await probeProxied(prox.frame, code, "POST", n);
      compareEcho(direct, proxied, code + " below-cap POST", expectMethod, expectMethod === "POST" ? n : 0);
      return "echo method " + expectMethod + ", " + (expectMethod === "POST" ? n + " bytes replayed" : "body dropped per spec");
    });
  }

  /* ---- the production ceiling pin ---- */

  await check("production pin: a 32 MiB + 1 upload without the spool fails with the honest 502, never a crash", async () => {
    await pushConfig(prox.page, { spoolUploads: false });
    const path = "/api/echo";
    const out = JSON.parse(
      await evalIn(
        prox.frame,
        "over-default-cap echo probe",
        `async () => {
          const u8 = new Uint8Array(${OVER_DEFAULT_CAP});
          for (let i = 0; i < u8.length; i++) u8[i] = (i * 7 + 13) & 255;
          const r = await fetch("/api/echo", { method: "POST", body: u8 });
          return JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 400) });
        }`,
        120000,
      ),
    );
    eq(out.status, 502, "the production-size upload did not fail honestly");
    assert(
      out.body.includes("exceeds the replay buffer cap"),
      "the honest 502 does not name the replay cap: " + out.body.slice(0, 120),
    );
    return "pinned: the wisp transport ceiling is documented, the failure is honest";
  });

  /* ---- #556 relay follow-up: the spooled File rides the embedder relay ---- */

  await check("relay: a spooled over-cap File body crosses to the embedder relay and rides upstream byte-identical", async () => {
    /* A second engine instance serves a default-relay policy.kdl from
       its own static tree, so once the harness host page registers a
       crediting relay port every upstream fetch of that engine asks
       the embedder native stack. The handler below is the honest
       crediting relay: zl:fetchRelay out, a native fetch with the
       structured-clone body, head/chunk/end back, zl:relayCredit
       honored, and the non-relay frames on the port (the
       registration ack) tolerated. The probe stays CORS-simple (a
       text/plain POST, no preflight) so the fixture ACAO * echo is
       readable from the engine origin. */
    relayStaticDir = mkdtempSync(join(tmpdir(), "zl-relay-static-"));
    const distDir = resolve("app/dist");
    for (const ent of readdirSync(distDir)) symlinkSync(join(distDir, ent), join(relayStaticDir, ent));
    writeFileSync(
      join(relayStaticDir, "policy.kdl"),
      'rule "relay-all" { route "relay" reason "#556 e2e: default relay for the relay arm" }' + String.fromCharCode(10),
    );
    await startEngineOn(RELAY_ENGINE_PORT, relayStaticDir, engine2Err, (p) => (engine2Proc = p));

    /* The embedder relay in production fetches upstream SERVER-side
       (the LB /zlrelay endpoint); a page-realm fetch() is CORS-bound and
       cannot emulate it against upstreams that answer no ACAO. The hop
       answers ACAO * and forwards method/headers/body upstream from the
       harness process, which is the faithful shape of the production
       embedder relay. */
    const relayHop = createServer((hreq, hres) => {
      const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
      if (hreq.method === "OPTIONS") { hres.writeHead(204, headers); hres.end(); return; }
      const up = new URL(hreq.url, "http://127.0.0.1").searchParams.get("u");
      if (!up) { hres.writeHead(400, headers); hres.end("missing u"); return; }
      const chunks = [];
      hreq.on("data", (c) => chunks.push(c));
      hreq.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const fwd = { ...hreq.headers };
        delete fwd.host; delete fwd.connection; delete fwd["content-length"]; delete fwd.origin; delete fwd.referer;
        fetch(up, { method: hreq.method, headers: fwd, body, redirect: "follow" })
          .then(async (r) => {
            const buf = Buffer.from(await r.arrayBuffer());
            const rh = { ...headers };
            for (const [k, v] of r.headers) if (!(k in rh)) rh[k] = v;
            hres.writeHead(r.status, rh);
            hres.end(buf);
          })
          .catch((err) => { hres.writeHead(502, headers); hres.end(String(err)); });
      });
    });
    relayHop.listen(RELAY_HOP_PORT, "127.0.0.1");

    const host = await context.newPage();
    /* The app shell registers the SW only with a ?url= target (main.ts); a bare-root boot never produces a controller. */
    await host.goto(RELAY_ENGINE + "/?url=" + encodeURIComponent(ORIGIN_A + "/dir/landing.html"));
    try {
      await waitFor("engine2 SW controller", 15000, () =>
        host.evaluate(() => navigator.serviceWorker.controller !== null).catch(() => false),
      );
    } catch {
      /* First-ever load on a fresh origin: the SW claims on the next
         navigation, so reload once like the engine boot does. */
      await host.reload();
      await waitFor("engine2 SW controller after reload", 30000, () =>
        host.evaluate(() => navigator.serviceWorker.controller !== null).catch(() => false),
      );
    }
    const ack = await host.evaluate(
      () =>
        new Promise((res, rej) => {
          const ctl = navigator.serviceWorker.controller;
          if (!ctl) return rej(new Error("no controller"));
          const ch = new MessageChannel();
          const send = (msg) => {
            try {
              ch.port1.postMessage(msg);
            } catch {}
          };
          /* #470 crediting: chunks only while granted bytes remain. */
          const credit = new Map();
          const pending = new Map();
          window.__zlRelayStats = { fetches: 0, files: 0, fileBytes: 0 };
          const pump = (rid) => {
            const q = pending.get(rid);
            if (!q) return;
            while (q.length) {
              const chunk = q[0];
              const have = credit.get(rid) ?? 0;
              if (have < chunk.byteLength) return;
              credit.set(rid, have - chunk.byteLength);
              q.shift();
              send({ type: "zl:relayChunk", rid, bytes: chunk });
            }
            pending.delete(rid);
            credit.delete(rid);
            send({ type: "zl:relayEnd", rid });
          };
          ch.port1.onmessage = (e) => {
            const m = e.data;
            if (m?.ok === true && !m.type) {
              res(m); /* the registration ack rides the same port */
              return;
            }
            if (m?.type === "zl:relayCredit") {
              credit.set(m.rid, (credit.get(m.rid) ?? 0) + m.bytes);
              pump(m.rid);
              return;
            }
            if (m?.type !== "zl:fetchRelay") return;
            window.__zlRelayStats.fetches++;
            if (m.body instanceof File) {
              window.__zlRelayStats.files++;
              window.__zlRelayStats.fileBytes += m.body.size;
            }
            (async () => {
              try {
                const r = await fetch(RELAY_HOP + "?u=" + encodeURIComponent(m.dest), { method: m.method, headers: m.headers, body: m.body ?? undefined, redirect: "follow" });
                send({ type: "zl:relayHead", rid: m.rid, status: r.status, statusText: r.statusText, headers: Array.from(r.headers.entries()) });
                const buf = new Uint8Array(await r.arrayBuffer());
                const chunks = [];
                for (let i = 0; i < buf.length; i += 65536) chunks.push(buf.subarray(i, Math.min(i + 65536, buf.length)));
                if (chunks.length === 0) {
                  send({ type: "zl:relayEnd", rid: m.rid });
                  return;
                }
                pending.set(m.rid, chunks);
                pump(m.rid);
              } catch (err) {
                send({ type: "zl:relayError", rid: m.rid, error: String(err?.message ?? err), delivery: "definitely-not-delivered" });
              }
            })();
          };
          ctl.postMessage({ type: "zl:relayRegister", credits: 1 }, [ch.port2]);
          setTimeout(() => rej(new Error("relay registration ack timeout")), 8000);
        }),
    );
    assert(ack?.ok === true, "zl:relayRegister was refused: " + JSON.stringify(ack));
    const cfg = await pushConfig(host, { replayCapMb: TIGHT_CAP_MB, spoolUploads: true });
    eq(cfg.replayCapMb, TIGHT_CAP_MB, "engine2 did not echo the tightened replay cap");

    const relPage = await context.newPage();
    await relPage.goto(RELAY_ENGINE + "/?url=" + encodeURIComponent(ORIGIN_A + "/dir/page.html"));
    const relFrame = await waitFor("engine2 proxied frame", 45000, () => frameWith(relPage, "#zl-marker", RELAY_ENGINE));

    /* The direct oracle and the proxied probe: the same deterministic
       bytes as a CORS-simple text/plain POST straight to the echo. */
    const echoJs = (n) =>
      "async () => { const u8 = new Uint8Array(" + n + "); for (let i = 0; i < u8.length; i++) u8[i] = (i * 7 + 13) & 255; " +
      'const r = await fetch("/api/echohash", { method: "POST", body: new Blob([u8], { type: "text/plain" }) }); ' +
      "return JSON.stringify({ status: r.status, body: await r.text() }); }";
    const directPg = await context.newPage();
    await directPg.goto(ORIGIN_A + "/dir/landing.html");
    const direct = JSON.parse(await directPg.evaluate("(" + echoJs(OVER_TIGHT_CAP) + ")()"));
    await directPg.close();
    const proxied = JSON.parse(await evalIn(relFrame, "relay spool probe", echoJs(OVER_TIGHT_CAP), 120000));

    eq(proxied.status, 200, "the relayed spooled upload did not reach the echo");
    const d = JSON.parse(direct.body);
    const p = JSON.parse(proxied.body);
    eq(p.sha256, d.sha256, "relay spool: SHA-256 of the File body diverged from the direct oracle");
    eq(p.bytes, OVER_TIGHT_CAP, "relay spool: the echoed byte count is not the upload size");
    eq(p.bytes, d.bytes, "relay spool: the echoed byte count diverged from the direct oracle");
    eq(p.method, "POST", "relay spool: the echo method is not POST");
    eq(p.contentType, d.contentType, "relay spool: the content type diverged from the direct oracle");
    const stats = await waitFor(
      "the relay handler to observe the File body",
      10000,
      () => host.evaluate(() => (window.__zlRelayStats && window.__zlRelayStats.files >= 1 ? window.__zlRelayStats : null)),
    );
    assert(stats.files >= 1, "the upload never crossed to the relay handler as a File");
    eq(stats.fileBytes, OVER_TIGHT_CAP, "the File that crossed to the relay was not the full spooled body");
    return "spooled File crossed by structured clone, " + stats.fileBytes + " bytes, SHA-256 equal to the direct oracle";
  });

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("== replay-spool summary: " + (results.length - failed.length) + " passed, " + failed.length + " failed ==");
  console.log("== E2E-JSON == " + JSON.stringify({ suite: "replay-spool", passed: results.length - failed.length, failed: failed.length, failures: failed.map((r) => r.name) }));
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
    /* browser.close() can hang past the summary when a service
       worker holds an open relay MessageChannel; bound the teardown
       and exit with the recorded status. */
    const hardExit = setTimeout(() => process.exit(process.exitCode ?? 0), 15000);
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      if (fixtureA) fixtureA.close();
    } catch {}
    try {
      if (fixtureB) fixtureB.close();
    } catch {}
    try {
      relayHop.close();
    } catch {}
    try {
      if (engineProc) engineProc.kill();
    } catch {}
    try {
      if (engine2Proc) engine2Proc.kill();
    } catch {}
    try {
      if (relayStaticDir) rmSync(relayStaticDir, { recursive: true, force: true });
    } catch {}
    clearTimeout(hardExit);
  });
