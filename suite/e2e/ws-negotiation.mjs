/* Differential WebSocket acceptance (#546). Compares the bridged shim
   against direct Chromium on the same page and inside a worker:
   - constructor URL serialization for relative, scheme-less, ws/wss,
     explicit http(s) (WHATWG upgrade), non-web scheme inputs and
     fragment refusal;
   - subprotocol negotiation (selected protocol) and constructor token
     validation throws;
   - failed-handshake error/close ordering and a server-initiated clean
     close;
   - slow-consumer bufferedAmount over time: native network backlog vs
     the shim's drain-acknowledged decay (page and worker), including
     the no-underflow clamp. Not claimed anywhere: the shim's counter is
     native network backpressure; it is bridge/transport acceptance
     accounting (docs/websocket.md). */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chromium } from "playwright";
const require = createRequire(new URL("../../app/package.json", import.meta.url));
const { build } = require("esbuild");
const FIXTURE_PLUGIN = {
  name: "controlled-controller",
  setup(b) {
    b.onResolve({ filter: /^\.\/siteid$/ }, () => ({ path: "siteid", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const swc = () => globalThis.__testController" }));
  },
};
const shimBundle = await build({ entryPoints: ["app/src/bootstrap/ws.ts"], bundle: true, write: false, format: "esm", plugins: [FIXTURE_PLUGIN] });
const WORKER_PROBE = `
globalThis.__testController = { postMessage(_m, ports) { globalThis.__port = ports[0]; } };
const { applyWs } = await import("./shim-entry");
applyWs(globalThis);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket("ws://127.0.0.1:9/worker-sock");
globalThis.__port.postMessage({ ev: "open", protocol: "proto-a" });
await sleep(20);
const decay = [];
ws.send("x".repeat(70000)); decay.push(ws.bufferedAmount);
ws.send("y".repeat(3)); decay.push(ws.bufferedAmount);
ws.send(new Uint8Array(11)); decay.push(ws.bufferedAmount);
for (const bytes of [40000, 20000, 50000, -5, "bogus"]) {
  await sleep(20);
  globalThis.__port.postMessage({ ev: "drain", bytes });
  await sleep(20);
  decay.push(ws.bufferedAmount);
}
globalThis.__port.close();
postMessage(decay);
`;
const workerBundle = await build({
  stdin: { contents: WORKER_PROBE, resolveDir: process.cwd(), loader: "js" },
  bundle: true, write: false, format: "esm",
  plugins: [{
    name: "worker-shim",
    setup(b) {
      FIXTURE_PLUGIN.setup(b);
      b.onResolve({ filter: /^\.\/shim-entry$/ }, () => ({ path: require("node:path").resolve("app/src/bootstrap/ws.ts") }));
    },
  }],
});
const server = createServer((req, res) => {
  const type = req.url === "/shim.js" || req.url === "/worker.js" ? "text/javascript" : "text/html";
  res.setHeader("content-type", type);
  if (req.url === "/shim.js") return res.end(shimBundle.outputFiles[0].text);
  if (req.url === "/worker.js") return res.end(workerBundle.outputFiles[0].text);
  res.end("<!doctype html><title>ws differential fixture</title>");
});
const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sockets = new Set();
server.on("upgrade", (req, socket) => {
  sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + MAGIC).digest("base64");
  const path = req.url;
  const head = (proto) =>
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + (proto ? "\r\nSec-WebSocket-Protocol: " + proto : "") + "\r\n\r\n";
  if (path === "/ws/reject") {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  if (path === "/ws/proto-a") {
    socket.write(head("proto-a"));
    return;
  }
  if (path === "/ws/close1000") {
    /* end(), not write(): the close frame must be followed by a TCP
       FIN or Chromium never completes the closing handshake and the
       close event never fires. */
    socket.write(head());
    socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    return;
  }
  if (path === "/ws/slow") {
    socket.write(head());
    /* No data listener: the socket stays paused so the client's native
       send queue builds real backlog. Resume after 1.2 s. */
    setTimeout(() => { socket.on("data", () => {}); }, 1200);
    return;
  }
  socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const origin = location.origin;
    const wsBase = origin.replace("http", "ws");
    const port = location.port;
    const probe = async (WS, shim = false) => {
      const out = {};
      /* --- URL serialization parity (#546) --- */
      const inputs = ["/sock", "sock", "//127.0.0.1:" + port + "/sock", "ws://example.com/x", "wss://example.com/x", "http://example.com/x", "https://example.com/x", "ftp://example.com/x", "ws://example.com/x#f"];
      out.url = inputs.map((u) => {
        try {
          const s = new WS(u);
          const url = s.url;
          try { s.close(); } catch {}
          return { url };
        } catch (err) {
          return { throw: err.name };
        }
      });
      /* --- subprotocol negotiation + token validation --- */
      const protoThrows = [["a", "a"], ["a b"], [""]].map((p) => {
        try { new WS(wsBase + "/ws/proto-a", p); return { unexpected: "open" }; } catch (err) { return { throw: err.name }; }
      });
      const negotiated = new WS(wsBase + "/ws/proto-a", ["proto-a", "proto-b"]);
      if (shim) {
        globalThis.__port.postMessage({ ev: "open", protocol: "proto-a" });
        await new Promise((r) => { negotiated.onopen = r; setTimeout(r, 1000); });
      } else await new Promise((r) => { negotiated.onopen = r; setTimeout(r, 3000); });
      out.negotiation = { throws: protoThrows, protocol: negotiated.protocol, ready: negotiated.readyState };
      try { negotiated.close(); } catch {}
      /* --- failed handshake: error then close order --- */
      const rejected = new WS(wsBase + "/ws/reject");
      const seq = [];
      const record = (e) => seq.push({ ev: e.type, state: rejected.readyState });
      rejected.onerror = record;
      rejected.onclose = (e) => { seq.push({ ev: "close", state: rejected.readyState, code: e.code, clean: e.wasClean }); };
      if (shim) { globalThis.__port.postMessage({ ev: "error" }); globalThis.__port.postMessage({ ev: "close", code: 1006, clean: false }); }
      await new Promise((r) => { setTimeout(r, 300); });
      out.reject = seq;
      /* --- server-initiated clean close --- */
      const served = new WS(wsBase + "/ws/close1000");
      const closeSeq = [];
      served.onopen = () => closeSeq.push({ ev: "open", state: served.readyState, protocol: served.protocol });
      served.onclose = (e) => closeSeq.push({ ev: "close", state: served.readyState, code: e.code, clean: e.wasClean });
      if (shim) { globalThis.__port.postMessage({ ev: "open", protocol: "" }); globalThis.__port.postMessage({ ev: "close", code: 1000, clean: true }); }
      await new Promise((r) => { setTimeout(r, 300); });
      out.servedClose = closeSeq;
      /* --- slow consumer: native backlog vs ack-driven decay --- */
      if (shim) {
        const ws = new WS(wsBase + "/ws/slow");
        globalThis.__port.postMessage({ ev: "open", protocol: "p" });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        await sleep(20);
        const decay = [];
        ws.send("x".repeat(70000)); decay.push(ws.bufferedAmount);
        ws.send("y".repeat(3)); decay.push(ws.bufferedAmount);
        ws.send(new Uint8Array(11)); decay.push(ws.bufferedAmount);
        for (const bytes of [40000, 20000, 50000, -5, "bogus"]) {
          await sleep(20);
          globalThis.__port.postMessage({ ev: "drain", bytes });
          await sleep(20);
          decay.push(ws.bufferedAmount);
        }
        out.slowShim = decay;
        globalThis.__port.close();
      } else {
        const ws = new WS(wsBase + "/ws/slow");
        await new Promise((r) => { ws.onopen = r; setTimeout(r, 3000); });
        const t0 = Date.now();
        let queued = 0;
        while (Date.now() - t0 < 4000) {
          ws.send(new Uint8Array(65536));
          queued = ws.bufferedAmount;
          if (queued > 0) break;
        }
        const hadBacklog = queued > 0;
        const drainedToZero = await new Promise((res) => {
          const t1 = Date.now();
          const iv = setInterval(() => {
            if (ws.bufferedAmount === 0 || Date.now() - t1 > 8000) { clearInterval(iv); res(ws.bufferedAmount === 0); }
          }, 50);
        });
        try { ws.close(); } catch {}
        out.slowNative = { hadBacklog, drainedToZero };
      }
      return out;
    };
    const direct = await probe(WebSocket);
    globalThis.__testController = { postMessage(_m, ports) { globalThis.__port = ports[0]; } };
    const { applyWs } = await import("/shim.js");
    const scope = { WebSocket, location, document };
    applyWs(scope);
    const shim = await probe(scope.WebSocket, true);
    /* --- worker: the same shim, drain-acknowledged decay over time --- */
    const worker = new Worker("/worker.js", { type: "module" });
    const workerDecay = await new Promise((res) => { worker.onmessage = (ev) => res(ev.data); setTimeout(() => res(null), 8000); });
    worker.terminate();
    return { direct, shim, workerDecay };
  });
  /* URL serialization: identical to native for every input class. */
  assert.deepEqual(result.shim.url, result.direct.url);
  assert.ok(result.direct.url.every((r) => !r.url || r.url.startsWith("ws")));
  /* Negotiation: the same selected protocol, the same validation throws. */
  assert.deepEqual(result.shim.negotiation, result.direct.negotiation);
  assert.equal(result.direct.negotiation.protocol, "proto-a");
  assert.deepEqual(result.direct.negotiation.throws, [{ throw: "SyntaxError" }, { throw: "SyntaxError" }, { throw: "SyntaxError" }]);
  /* Failed handshake: the WHATWG fail-the-connection steps move
     readyState to CLOSED before error and close fire (Chromium
     records state 3 at error, not CONNECTING), then close(1006). */
  assert.deepEqual(result.direct.reject, [{ ev: "error", state: 3 }, { ev: "close", state: 3, code: 1006, clean: false }]);
  assert.deepEqual(result.shim.reject, result.direct.reject);
  /* Server-initiated close: open then close(1000, clean). */
  assert.deepEqual(result.direct.servedClose, [{ ev: "open", state: 1, protocol: "" }, { ev: "close", state: 3, code: 1000, clean: true }]);
  assert.deepEqual(result.shim.servedClose, result.direct.servedClose);
  /* Slow consumer: native builds real backlog and drains; the shim decays
     only on acknowledged bytes, never below zero, ignoring bogus acks. */
  assert.equal(result.direct.slowNative.hadBacklog, true);
  assert.equal(result.direct.slowNative.drainedToZero, true);
  assert.deepEqual(result.shim.slowShim, [70000, 70003, 70014, 30014, 10014, 0, 0, 0]);
  assert.deepEqual(result.workerDecay, result.shim.slowShim);
  console.log("PASS WebSocket URL/negotiation/close-order differential and slow-consumer decay match direct Chromium (page + worker)");
} finally {
  await browser?.close();
  for (const sk of sockets) sk.destroy();
  await new Promise((resolve) => server.close(resolve));
}
