/* Capability scoreboard (2.5 Iodide), rebuilt on the real engine
   surface. The 1.9 version probed capabilities over HTTP fetches to
   ${BASE}/j/<b64url>, a route zeolite-server has never had (it is a
   wisp relay: /wisp/ plus a static fallback); every row failed with
   404 on the first run that ever executed (36472949276).

   What a wisp relay can actually guarantee is now what is gated,
   deterministically, against the local fixture origin:
   - the v2.1 handshake,
   - TCP CONNECT through the relay,
   - byte-exact relay of requests and responses (both directions),
   - upstream status preservation (301/302/307, 404, 500, cookies),
   - the SSRF policy: a second server started WITHOUT the
     ZL_TEST_ALLOW_PRIVATE_DESTS escape hatch must refuse a loopback
     CONNECT with close reason 0x48,
   - auth enforcement: a third server with ZL_WISP_USER /
     ZL_WISP_PASSWORD set must refuse a keyless client with 0xc2.
   Rewriting capabilities (html/css/js/url rewriting, opaque URLs,
   iframes, fetch rerouting) live client-side in the SW's wasm
   rewriters; they are covered by the app unit suite and the wasm job
   and are honestly listed as client-runtime, never probed from node.

   Gated rows (gate: true) fail the run; the rest are report-only so
   the scoreboard surfaces reality without pretending. Verdicts are
   facts, never invented percentages.

   Usage: node suite/capabilities.mjs --base http://localhost:6002
   (the base server must run with ZL_TEST_ALLOW_PRIVATE_DESTS=1 so it
   may reach the loopback fixture; the two extra servers it spawns
   verify the opposite, production-default behaviors).
   Writes suite/capabilities.json and suite/capabilities.md. */

import { writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect as tcpConnect } from "node:net";
import { MEDIA, startFixtureServer } from "./fixtures.mjs";
import { wispSession, streamRequest, statusLine, bodyOf, reasonName, CLOSE } from "./wisp.mjs";

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:6002";

/* Repo-root server binary, independent of the process CWD. */
const SERVER = fileURLToPath(new URL("../target/release/zeolite-server", import.meta.url));

/* ponytail: fixed ports instead of port 0 + stdout parsing; a real
   collision still fails the row loudly, which is the honest outcome.
   They must sit below the Linux ephemeral range (32768+): inside it
   the runner's own outbound connections squat the ports and both
   servers die on bind with AddrInUse before any row can run (proven
   by run 36479436783). */
const SSRF_PORT = 16102;
const AUTH_PORT = 16103;

const bareEnv = () => {
  const env = { ...process.env };
  delete env.ZL_TEST_ALLOW_PRIVATE_DESTS;
  return env;
};

const startServer = (port, env) =>
  new Promise((resolve, reject) => {
    const proc = spawn(SERVER, ["--port", String(port)], {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    proc.once("error", reject);
    // Resolve after the current turn so a spawn error (bad binary path)
    // rejects the promise instead of being swallowed by an early resolve.
    setImmediate(() => resolve(proc));
  });

/* Wait for a spawned server to accept wisp sessions. The last error
   is preserved in the thrown message: the auth row asserts on it. */
async function awaitServer(port, tries = 20) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await wispSession(`http://127.0.0.1:${port}`);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`server on port ${port} never accepted a wisp session: ${last ? last.message : "unknown"}`);
}

/* The same raw request over a direct socket to the fixture: the
   reference for byte-exact relay comparison. */
function directRaw(port, request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = tcpConnect(port, "127.0.0.1");
    sock.setTimeout(15000, () => {
      sock.destroy();
      reject(new Error("direct fixture request timed out"));
    });
    sock.on("error", reject);
    sock.on("connect", () => sock.write(request));
    sock.on("data", (c) => chunks.push(c));
    sock.on("close", () => resolve({ bytes: Buffer.concat(chunks) }));
  });
}

const rawGet = (host, port, path) =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: zeolite-compat/2.5\r\nAccept: */*\r\nConnection: close\r\n\r\n`;

const { server, port: fxPort } = await startFixtureServer();
const fxHost = "127.0.0.1";

const caps = [];
const check = async (name, gate, fn) => {
  let status = "fail";
  let note = "";
  try {
    const r = await fn();
    status = r.ok ? "pass" : "fail";
    note = r.note ?? "";
  } catch (e) {
    note = e.message;
  }
  caps.push({ name, gate, status, note });
  process.stdout.write(`${name}: ${status}${note ? " (" + note + ")" : ""}\n`);
};

/* Every fixture row shares one wisp session: multiplexing streams over
   one connection is the point of the protocol. */
const session = await wispSession(BASE);

await check("wisp-handshake", true, async () => ({ ok: true, note: "v2.1 INFO exchange + CONTINUE(0)" }));

await check("tcp-connect", true, async () => {
  const resp = await streamRequest(session, fxHost, fxPort, rawGet(fxHost, fxPort, "/page.html"));
  return resp.bytes.length
    ? { ok: true, note: `${resp.bytes.length} bytes relayed` }
    : { ok: false, note: "no data, close " + reasonName(resp.closeReason) };
});

await check("relay-response-bytes", true, async () => {
  const viaEngine = await streamRequest(session, fxHost, fxPort, rawGet(fxHost, fxPort, "/page.html"));
  const direct = await directRaw(fxPort, rawGet(fxHost, fxPort, "/page.html"));
  // Bodies only: the Date header differs between the two requests.
  const a = bodyOf(viaEngine);
  const b = bodyOf(direct);
  return a.equals(b)
    ? { ok: true, note: `body ${a.length}B byte-identical to direct` }
    : { ok: false, note: `body differs: engine ${a.length}B vs direct ${b.length}B` };
});

await check("relay-request-echo", true, async () => {
  const req = `POST /echo HTTP/1.1\r\nHost: ${fxHost}:${fxPort}\r\nContent-Length: 4\r\nConnection: close\r\n\r\nping`;
  const resp = await streamRequest(session, fxHost, fxPort, req);
  const body = bodyOf(resp).toString("utf8");
  return body === "echo:ping"
    ? { ok: true, note: "request bytes relayed upstream and echoed" }
    : { ok: false, note: "echo mismatch: " + body.slice(0, 40) };
});

await check("relay-media-bytes", true, async () => {
  const resp = await streamRequest(session, fxHost, fxPort, rawGet(fxHost, fxPort, "/media.bin"));
  return bodyOf(resp).equals(MEDIA)
    ? { ok: true, note: `${MEDIA.length}B binary body intact` }
    : { ok: false, note: "media bytes differ" };
});

await check("relay-download-bytes", true, async () => {
  const resp = await streamRequest(session, fxHost, fxPort, rawGet(fxHost, fxPort, "/download"));
  return bodyOf(resp).equals(MEDIA)
    ? { ok: true, note: "attachment body intact" }
    : { ok: false, note: "download bytes differ" };
});

for (const [name, path, want] of [
  ["relay-status-404", "/missing", 404],
  ["relay-status-500", "/boom", 500],
]) {
  await check(name, true, async () => {
    const resp = await streamRequest(session, fxHost, fxPort, rawGet(fxHost, fxPort, path));
    const st = statusLine(resp);
    return st === want ? { ok: true, note: `status ${st}` } : { ok: false, note: `status ${st}, wanted ${want}` };
  });
}

for (const [name, path, want] of [
  ["relay-redirect-301", "/redirect301", 301],
  ["relay-redirect-302", "/redirect302", 302],
  ["relay-redirect-307", "/redirect307", 307],
]) {
  await check(name, true, async () => {
    // Raw TCP means no redirect following: the relay must preserve the
    // upstream status and Location, and following is the client's job
    // (recorded as 200-class in sessions because the SW follows).
    const resp = await streamRequest(session, fxHost, fxPort, rawGet(fxHost, fxPort, path));
    const st = statusLine(resp);
    const head = resp.bytes.subarray(0, resp.bytes.indexOf(Buffer.from("\r\n\r\n", "latin1"))).toString("latin1");
    return st === want && /location:/i.test(head)
      ? { ok: true, note: `status ${st} + Location preserved` }
      : { ok: false, note: `status ${st}, wanted ${want} with Location` };
  });
}

await check("relay-set-cookie", true, async () => {
  const resp = await streamRequest(session, fxHost, fxPort, rawGet(fxHost, fxPort, "/setcookie"));
  const head = resp.bytes.subarray(0, resp.bytes.indexOf(Buffer.from("\r\n\r\n", "latin1"))).toString("latin1");
  return /set-cookie:/i.test(head)
    ? { ok: true, note: "upstream Set-Cookie bytes preserved (jar application is client-side)" }
    : { ok: false, note: "set-cookie missing from relayed head" };
});

session.close();

/* SSRF: the spawned server has NO escape hatch; loopback CONNECT must
   be refused with close reason 0x48 (policy.rs resolve-then-validate,
   checked before any connect). */
const ssrfServer = await startServer(SSRF_PORT, bareEnv());
await check("ssrf-private-blocked", true, async () => {
  const s = await awaitServer(SSRF_PORT);
  try {
    const resp = await streamRequest(s, fxHost, fxPort, rawGet(fxHost, fxPort, "/page.html"), { timeoutMs: 8000 });
    return resp.bytes.length === 0 && resp.closeReason === CLOSE.BLOCKED
      ? { ok: true, note: "loopback CONNECT refused with reason 0x48" }
      : { ok: false, note: `unexpected relay: ${resp.bytes.length}B, close ${reasonName(resp.closeReason)}` };
  } finally {
    s.close();
  }
});
ssrfServer.kill();

/* Auth: a server with password auth configured must refuse a keyless
   v2 client during the handshake (close 0xc2). */
const authEnv = bareEnv();
authEnv.ZL_WISP_USER = "probe";
authEnv.ZL_WISP_PASSWORD = "probe-pass";
const authServer = await startServer(AUTH_PORT, authEnv);
await check("auth-required-refusal", true, async () => {
  try {
    await awaitServer(AUTH_PORT, 3);
    return { ok: false, note: "keyless session accepted; auth not enforced" };
  } catch (e) {
    return /AUTH_REQUIRED/.test(e.message)
      ? { ok: true, note: "keyless v2 handshake refused with reason 0xc2" }
      : { ok: false, note: "wrong refusal: " + e.message };
  }
});
authServer.kill();

/* Client-runtime capabilities: honestly not observable from a node
   probe (the wasm rewriters and the interception paths live in the
   service worker). Listed so the scoreboard states coverage instead
   of inventing a result; gated by the app unit suite + wasm job. */
for (const name of [
  "html-links",
  "opaque-urls",
  "css-urls",
  "iframe-src",
  "js-serve",
  "fetch-reroute",
  "websocket-bridge",
  "worker-virtualization",
  "storage-virtualization",
  "cache-api",
  "client-cookie-jars",
  "spa-routing",
]) {
  caps.push({
    name,
    gate: false,
    status: "client-runtime",
    note: "lives in the SW/wasm client runtime; covered by the app unit suite + wasm job, not probed over wisp",
  });
}

server.close();

const gatedFails = caps.filter((c) => c.gate && c.status !== "pass");
const scoreboard = {
  base: BASE,
  transport: "wisp v2.1 over /wisp/",
  fixture: `127.0.0.1:${fxPort}`,
  generated: new Date().toISOString(),
  summary: {
    pass: caps.filter((c) => c.status === "pass").length,
    fail: caps.filter((c) => c.status === "fail").length,
    clientRuntime: caps.filter((c) => c.status === "client-runtime").length,
    total: caps.length,
  },
  capabilities: caps,
};
writeFileSync("suite/capabilities.json", JSON.stringify(scoreboard, null, 2));

const md = [
  "# Zeolite capability scoreboard",
  "",
  `Generated: ${scoreboard.generated}`,
  `Engine: ${BASE} - wisp v2.1 transport - fixture: ${scoreboard.fixture}`,
  "",
  "| capability | gate | status | notes |",
  "| --- | --- | --- | --- |",
  ...caps.map((c) => `| ${c.name} | ${c.gate ? "yes" : "report"} | ${c.status.toUpperCase()} | ${(c.note ?? "").replace(/\|/g, "/")} |`),
  "",
  "Gated capabilities fail the run; report-only ones surface reality without gating.",
  "Client-runtime rows live in the SW/wasm client runtime (no browser in CI):",
  "they are covered by the app unit suite and the wasm job, not probed here.",
  "",
].join("\n");
writeFileSync("suite/capabilities.md", md);

process.exit(gatedFails.length ? 1 : 0);
