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
 * The loader keeps stripEsmExports/inlineDataImports in sync with
 * app/src/libcurl-transport-vendored.ts. Any failure exits nonzero
 * and fails the workflow. */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

if (typeof globalThis.WebSocket === "undefined") {
  const ws = await import("ws");
  globalThis.WebSocket = ws.WebSocket ?? ws.default;
}

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
    /import\s*\{[^}]*\}\s*from\s*(["'])data:text\/javascript;base64,([A-Za-z0-9+/=]*)\1\s*;?/g,
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
const options = new mod.EpoxyClientOptions();
options.wisp_v2 = true;
const client = new mod.EpoxyClient(WISP, options);

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
