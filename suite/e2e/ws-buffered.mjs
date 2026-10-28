/* Compare closed/closing send accounting with actual Chromium. The shim uses
   a controlled bridge; lower-transport/network drain remains unobservable. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chromium } from "playwright";
const require = createRequire(new URL("../../app/package.json", import.meta.url));
const { build } = require("esbuild");
const bundle = await build({ entryPoints: ["app/src/bootstrap/ws.ts"], bundle: true, write: false, format: "esm",
  plugins: [{ name: "controlled-controller", setup(b) {
    b.onResolve({ filter: /^\.\/siteid$/ }, () => ({ path: "siteid", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const swc = () => globalThis.__testController" }));
  } }],
});
const server = createServer((req, res) => {
  res.setHeader("content-type", req.url === "/shim.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/shim.js" ? bundle.outputFiles[0].text : "<!doctype html><title>ws fixture</title>");
});
server.on("upgrade", (_req, socket) => { socket.on("error", () => {}); socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const probe = async (WS, shim = false) => {
      const socket = new WS(location.origin.replace("http", "ws") + "/socket");
      const closed = new Promise(resolve => socket.onclose = resolve);
      socket.close();
      const closing = socket.readyState;
      socket.send("é"); const text = socket.bufferedAmount;
      if (shim) globalThis.__port.postMessage({ ev: "close", code: 1000, clean: true });
      await closed;
      socket.send(new Uint8Array([1, 2, 3]));
      return { closing, closed: socket.readyState, text, binary: socket.bufferedAmount };
    };
    const direct = await probe(WebSocket);
    globalThis.__testController = { postMessage(_message, ports) { globalThis.__port = ports[0]; } };
    const { applyWs } = await import("/shim.js");
    const scope = { WebSocket, location }; applyWs(scope);
    const shim = await probe(scope.WebSocket, true);
    globalThis.__port.close();
    return { direct, shim };
  });
  assert.deepEqual(result.direct, { closing: 2, closed: 3, text: 2, binary: 5 });
  assert.deepEqual(result.shim, result.direct);
  console.log("PASS WebSocket closing/closed buffered bytes match direct Chromium");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
