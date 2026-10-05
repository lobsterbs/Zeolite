/* Transport gate for the epoxy engine seam (issue #64). CI runs no
 * browser by design; this is the only end-to-end coverage of the
 * vendored @mercuryworkshop/epoxy-tls 2.1.18-1 FULL build: the real
 * wasm bundle connects to a local zeolite-server wisp endpoint
 * (started with ZL_TEST_ALLOW_PRIVATE_DESTS=1, the same test-only
 * policy escape hatch the nightly compat suite uses, so the relay may
 * reach the loopback fixtures) and runs against deterministic local
 * fixtures instead of a live site:
 *
 *   1. fetch /ok: byte-exact 200 body and the X-Custom header off
 *      epoxy's rawHeaders (the object the adapter's
 *      epoxyRawHeadersToPairs rebuilds into cookie-jar pairs).
 *   2. fetch /cookie: BOTH Set-Cookie pairs survive rawHeaders - the
 *      parity a Response constructor cannot provide (the fetch spec
 *      drops set-cookie off every Response.headers).
 *   3. fetch /redir with redirect "manual": the 302 and its Location
 *      surface unfollowed - epoxy follows redirects by default, and
 *      the engine's SW hop-follower owns redirect mapping.
 *   4. connect_websocket: full-build-only WS round-trip against a
 *      local ws echo server through the wisp relay.
 *
 * Node 22 ships a NATIVE global WebSocket, and epoxy's glue resolves
 * the constructor at call time (object_get(globalThis, "WebSocket")),
 * so the shim override below is installed unconditionally: every open
 * the wasm attempts is logged (URL, subprotocols, errors). The old
 * typeof-undefined guard was dead code on Node 22 and the native
 * client swallowed the diagnostics.
 *
 * Transport selection: the engine's own shape (string URL, what the SW
 * passes in production) is tried first. CI has no browser WebSocket;
 * when the in-wasm open cannot complete against the Node shim, the
 * gate retries through EpoxyClient's documented transport-provider
 * seam (an EpoxyWispTransport function returning {read, write} web
 * streams, built on the same ws package). Either way the wasm's wisp
 * protocol, fetch parity, rawHeaders cookie capture, redirect
 * surfacing and WS bridge are proven against the live server; the
 * string-open path itself only runs for real inside a browser
 * service worker, where WebSocket is the browser's. The failure
 * evidence for whichever path did not run stays in this job's log.
 *
 * The loader keeps stripEsmExports/inlineDataImports in sync with
 * app/src/libcurl-transport-vendored.ts. Any failure exits nonzero
 * and fails the workflow. */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

/* Unconditional: epoxy resolves globalThis.WebSocket at call time. */
const wsPkg = await import("ws");
const RealWebSocket = wsPkg.WebSocket ?? wsPkg.default;
/* Logging subclass: the epoxy gate is young; when the wisp WS fails
   to open, the URL, the requested subprotocol, and the close/error
   all land in the CI log. */
class LoggingWebSocket extends RealWebSocket {
  constructor(address, protocols, options) {
    super(address, protocols, options);
    console.log("epoxy-ws ->", String(address), "protocols:", JSON.stringify(protocols));
    this.on("unexpected-response", (_req, res) =>
      console.log("epoxy-ws unexpected-response", res.statusCode, String(res.statusMessage)));
    this.on("error", (err) => console.log("epoxy-ws error:", String(err?.message ?? err)));
    this.on("close", (code, reason) => console.log("epoxy-ws close:", code, String(reason)));
    this.on("open", () => console.log("epoxy-ws OPEN"));
  }
}
globalThis.WebSocket = LoggingWebSocket;

/* Keep in sync with stripEsmExports in
   app/src/libcurl-transport-vendored.ts. */
function stripEsmExports(src, metaUrl) {
  return src
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+\{/g, "{")
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/g, "")
    .replace(/import\.meta\.url/g, JSON.stringify(metaUrl));
}

/* Keep in sync with inlineDataImports in
   app/src/libcurl-transport-vendored.ts: the full build imports its
   wasm-bindgen JS helpers from a data: URL module; import statements
   are SyntaxErrors inside a Function body, so decode and splice in
   place. */
function inlineDataImports(src) {
  return src.replace(
    /import\s*\{[^}]*\}\s*from\s*(["'])data:text\/javascript;base64,([A-Za-z0-9+\/=]*)\1\s*;?/g,
    (_m, _q, b64) => atob(b64),
  );
}

const PKG = "node_modules/@mercuryworkshop/epoxy-tls/full";
const WISP = "ws://127.0.0.1:6002/wisp/";
const FIXTURE_PORT = 6013;
const FIXTURE = "http://127.0.0.1:" + FIXTURE_PORT;
const ECHO_PORT = 6014;

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log((cond ? "PASS: " : "FAIL: ") + name + (cond ? "" : " :: " + detail));
  if (!cond) failures++;
};

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_res, rej) => setTimeout(() => rej(new Error(what + " timeout")), ms))]);

/* --- deterministic fixtures (no live-site flake) --- */
const fixture = createServer((req, res) => {
  if (req.url === "/ok") {
    res.writeHead(200, { "content-type": "text/plain", "x-custom": "zeolite-epoxy-gate" });
    res.end("epoxy-gate-ok\n");
  } else if (req.url === "/cookie") {
    res.writeHead(200, { "set-cookie": ["a=1; Path=/", "b=2; Path=/"] });
    res.end("cookies\n");
  } else if (req.url === "/redir") {
    res.writeHead(302, { location: FIXTURE + "/ok" });
    res.end();
  } else {
    res.writeHead(404);
    res.end("no\n");
  }
});
const { WebSocketServer } = await import("ws");
const echo = new WebSocketServer({ port: ECHO_PORT });
echo.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
});
await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));

/* --- wisp WS sanity probe: separates shim/server failures from
   epoxy-specific ones before the epoxy client is built. --- */
const probeResult = await new Promise((resolve) => {
  let settled = false;
  const probe = new globalThis.WebSocket(WISP);
  const finish = (what) => {
    if (settled) return;
    settled = true;
    try { probe.close(); } catch {}
    resolve(what);
  };
  probe.onopen = () => finish("open");
  probe.onclose = () => finish("closed");
  probe.onerror = () => finish("error");
  setTimeout(() => finish("timeout"), 5000);
});
console.log("wisp probe:", probeResult);
if (probeResult !== "open") {
  console.log("FAIL: the WebSocket shim itself cannot open the wisp endpoint; not an epoxy problem");
  process.exit(1);
}

/* --- load the full epoxy bundle the way the engine does --- */
const glue = readFileSync(PKG + "/epoxy.js", "utf8");
const wasmModule = new WebAssembly.Module(readFileSync(PKG + "/epoxy.wasm"));
const factory = new Function(
  stripEsmExports(inlineDataImports(glue), PKG + "/epoxy.wasm") +
    '\nreturn { init: typeof __wbg_init === "function" ? __wbg_init : undefined, EpoxyClient, EpoxyClientOptions, EpoxyHandlers };',
);
const mod = factory();
if (!mod.init || !mod.EpoxyClient || !mod.EpoxyClientOptions || !mod.EpoxyHandlers) {
  console.log("FAIL: epoxy full bundle exports incomplete (init/EpoxyClient/EpoxyClientOptions/EpoxyHandlers)");
  process.exit(1);
}
await mod.init({ module_or_path: wasmModule });

/* --- transport selection (see header): engine shape first,
   documented provider seam as the Node fallback. --- */
const wispProvider = () =>
  new Promise((resolve, reject) => {
    const sock = new RealWebSocket(WISP);
    sock.binaryType = "arraybuffer";
    const read = new ReadableStream({
      start(ctrl) {
        sock.on("message", (data, isBinary) => {
          try { ctrl.enqueue(isBinary === false ? new Uint8Array(Buffer.from(String(data))) : new Uint8Array(data)); } catch {}
        });
        sock.on("error", (e) => { try { ctrl.error(e); } catch {} });
        sock.on("close", () => { try { ctrl.close(); } catch {} });
      },
    });
    const write = new WritableStream({
      write(chunk) {
        return new Promise((res) => {
          try { sock.send(chunk, { binary: true }, () => res()); } catch { res(); }
        });
      },
      close() { try { sock.close(); } catch {} },
    });
    sock.on("open", () => resolve({ read, write }));
    sock.on("error", reject);
  });

let client;
let transportMode = "string";
try {
  const options = new mod.EpoxyClientOptions();
  options.wisp_v2 = true;
  client = new mod.EpoxyClient(WISP, options);
  await withTimeout(client.fetch(FIXTURE + "/ok", { method: "GET", redirect: "manual" }), 15000, "epoxy string-transport first fetch");
  console.log("epoxy transport: string (the engine's own shape)");
} catch (err) {
  console.log("epoxy string transport failed in the Node shim environment:", String(err?.message ?? err));
  transportMode = "provider";
  const options = new mod.EpoxyClientOptions();
  options.wisp_v2 = true;
  client = new mod.EpoxyClient(wispProvider, options);
  await withTimeout(client.fetch(FIXTURE + "/ok", { method: "GET", redirect: "manual" }), 15000, "epoxy provider-transport first fetch");
  console.log("epoxy transport: provider seam (documented EpoxyWispTransport fallback)");
}
console.log("epoxy gate running legs on transport:", transportMode);

/* epoxy rawHeaders is an object mapping name -> value | values. */
const rawHeader = (raw, name) => {
  if (!raw || typeof raw !== "object") return undefined;
  for (const [k, v] of Object.entries(raw)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
};

/* --- 1./2./3. fetch parity through the wisp relay --- */
const ok = await client.fetch(FIXTURE + "/ok", { method: "GET", redirect: "manual" });
const okBody = await ok.text();
check("200 byte-exact body", ok.status === 200 && okBody === "epoxy-gate-ok\n", "status " + ok.status + " body " + JSON.stringify(okBody));
check("x-custom survives rawHeaders", rawHeader(ok.rawHeaders, "x-custom") === "zeolite-epoxy-gate", JSON.stringify(ok.rawHeaders));

const cookie = await client.fetch(FIXTURE + "/cookie", { method: "GET", redirect: "manual" });
const sc = rawHeader(cookie.rawHeaders, "set-cookie");
check(
  "both set-cookie pairs survive rawHeaders",
  Array.isArray(sc) && sc.length === 2 && sc.includes("a=1; Path=/") && sc.includes("b=2; Path=/"),
  JSON.stringify(sc),
);

const redir = await client.fetch(FIXTURE + "/redir", { method: "GET", redirect: "manual" });
check("302 surfaces unfollowed", redir.status === 302, "status " + redir.status);
check("location surfaces", String(rawHeader(redir.rawHeaders, "location")) === FIXTURE + "/ok", JSON.stringify(redir.rawHeaders));

/* --- 4. full-build-only websocket round-trip --- */
const wsResult = await new Promise((resolve) => {
  const state = { opened: false, echoed: null };
  let sock = null;
  const handlers = new mod.EpoxyHandlers(
    () => { state.opened = true; },
    () => {},
    (err) => resolve({ ...state, sock, error: String(err) }),
    (data) => { state.echoed = data; resolve({ ...state, sock }); },
  );
  client
    .connect_websocket(handlers, "ws://127.0.0.1:" + ECHO_PORT + "/", [], {})
    .then((s) => { sock = s; s.send("epoxy-ws-ping"); })
    .catch((err) => resolve({ ...state, sock, error: String(err) }));
  setTimeout(() => resolve({ ...state, sock, timeout: true }), 20000);
});
check("connect_websocket opens (full build only)", wsResult.opened === true && !wsResult.error && !wsResult.timeout, JSON.stringify({ ...wsResult, sock: undefined }));
check("ws echo round-trip", String(wsResult.echoed) === "epoxy-ws-ping", JSON.stringify(String(wsResult.echoed)));
try { await wsResult.sock?.close(1000, ""); } catch {}

fixture.close();
echo.close();
console.log(failures ? "epoxy gate: FAIL" : "epoxy gate: PASS");
process.exit(failures ? 1 : 0);
