/* Deterministic dual fixture origins for the browser E2E suite
   (issue #35). Two node:http servers on fixed loopback ports so page
   content can embed both origins byte-stably:

   - A = http://127.0.0.1:7101  (the proxied site under test)
   - B = http://127.0.0.1:7102  (a second origin: cross-origin
     requests, beacons, EventSource, virtual-context isolation)

   /api/data deliberately sends NO Access-Control-Allow-Origin: a
   browser-direct cross-origin fetch/XHR/EventSource from the engine
   page fails CORS and the page cannot read it. Only an engine-served
   response (applyEngineCors stamps the engine's own CORS facts) is
   readable - that asymmetry is the #34 canary.

   Every hit is recorded with its Referer. The engine rebuilds the
   Referer from the real destination (forwardedHeaders drops the
   page's engine-origin referer and re-stamps it), so a hit whose
   Referer mentions the engine origin or a /j/ route is a
   browser-direct escape: the wire log is the second, wire-level
   escape gate, independent of CDP semantics.

   The engine's SSRF policy blocks loopback by default; the harness
   starts zeolite-server with ZL_TEST_ALLOW_PRIVATE_DESTS=1 (the same
   test-only hatch the compat job uses). */

import { createServer } from "node:http";

export const PORT_A = 7101;
export const PORT_B = 7102;
export const ORIGIN_A = `http://127.0.0.1:${PORT_A}`;
export const ORIGIN_B = `http://127.0.0.1:${PORT_B}`;

/* 1x1 transparent PNG (naturalWidth > 0 asserts the image decoded). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function pageHtml(origin) {
  const other = origin === ORIGIN_A ? ORIGIN_B : ORIGIN_A;
  return `<!doctype html><html><head><title>zl fixture</title>
<link rel="stylesheet" href="style.css">
<style>.inl{background:url("img.png")}</style>
<script type="module" src="mod.js"></script>
</head><body>
<p id="zl-marker">zl-fixture-page</p>
<div class="zl-bg" id="cssbg">bg</div>
<div class="inl" id="inlbg">inl</div>
<a id="abs" href="${other}/dir/landing.html">abs</a>
<a id="rel" href="landing.html">rel</a>
<a id="redir" href="/redir">redir</a>
<img id="img1" src="img.png" alt="i">
<img id="ss" srcset="img.png 1x, img.png 2x" alt="s">
<iframe id="inner" src="inner.html"></iframe>
<img id="ssd" srcset="data:image/png;base64,${PNG.toString("base64")} 1x, img.png 2x" alt="d">
<iframe id="doc" srcdoc="<p id='zl-srcdoc'>sd</p><img id='sdi' src='img.png'>"></iframe>
</body></html>`;
}

function send(res, type, body, extra) {
  const headers = { "content-type": type, "content-length": Buffer.byteLength(body), ...(extra ?? {}) };
  res.writeHead(200, headers);
  res.end(body);
}

export function startFixture(port) {
  const origin = `http://127.0.0.1:${port}`;
  const hits = [];
  const sseStreams = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (path !== "/__hits") {
        hits.push({ path, method: req.method, referer: req.headers.referer ?? null, body });
      }
      if (path === "/dir/page.html") {
        send(res, "text/html; charset=utf-8", pageHtml(origin));
      } else if (path === "/dir/landing.html") {
        send(res, "text/html; charset=utf-8", `<!doctype html><p id="zl-landing">zl-landing</p>`);
      } else if (path === "/dir/refresh.html") {
        /* #36: the meta refresh target must be rewritten to an engine
           route, otherwise the refresh navigates the proxied frame
           browser-direct and escapes the engine entirely. */
        send(res, "text/html; charset=utf-8", `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=landing.html"></head><body>refreshing</body></html>`);
      } else if (path === "/dir/based.html") {
        /* #36: <base href> must fold later relative URLs. The SVG has
           an intrinsic width of 7 and only exists under /sub/, so only
           a base-folded load can ever produce naturalWidth 7. */
        send(res, "text/html; charset=utf-8", `<!doctype html><html><head><base href="/sub/"></head><body><p id="zl-based">based</p><img id="bi" src="logo.svg" alt="b"></body></html>`);
      } else if (path === "/sub/logo.svg") {
        send(res, "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" width="7" height="7"><rect width="7" height="7" fill="#333"/></svg>`);
      } else if (path === "/dir/inner.html") {
        send(res, "text/html; charset=utf-8", `<!doctype html><p id="zl-inner-marker">zl-inner</p>`);
      } else if (path === "/dir/style.css") {
        send(res, "text/css", `.zl-bg{background:url("img.png")}`);
      } else if (path === "/dir/img.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
        res.end(PNG);
      } else if (path === "/dir/mod.js") {
        send(res, "text/javascript", `import { mapi } from "./mapi.js";\ndocument.documentElement.dataset.zlMod = mapi();\n`);
      } else if (path === "/dir/mapi.js") {
        send(res, "text/javascript", `export function mapi() { return "mod-ok"; }\n`);
      } else if (path === "/dir/worker.js") {
        send(res, "text/javascript", [
          `importScripts("wlib.js");`,
          `self.postMessage({ type: "wlib", value: WLIB_MARKER });`,
          `fetch("/api/data").then(r => r.json()).then(j => self.postMessage({ type: "api", value: j.zl }))`,
          `  .catch(e => self.postMessage({ type: "api", value: "err:" + e }));`,
          ``,
        ].join("\n"));
      } else if (path === "/dir/wlib.js") {
        send(res, "text/javascript", `var WLIB_MARKER = "wlib-ok";\n`);
      } else if (path === "/dir/shared.js") {
        send(res, "text/javascript", `self.onconnect = (e) => { const p = e.ports[0]; p.onmessage = () => {}; p.postMessage("shared-ok"); };\n`);
      } else if (path === "/api/data") {
        /* No CORS headers: the #34 canary. Browser-direct = unreadable. */
        send(res, "application/json", `{"zl":"api"}`);
      } else if (path === "/api/echo") {
        /* #38: echoes the request line the engine actually forwarded - a
           doubled or dropped query is visible in req.url. */
        send(res, "application/json", JSON.stringify({ zl: "echo", url: req.url }));
      } else if (path === "/data.json") {
        send(res, "application/json", `{"zl":"root"}`);
      } else if (path === "/sse") {
        /* Streamed, kept open (EventSource reconnects when it ends). */
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: zl-sse-1\n\n");
        res.write("data: zl-sse-2\n\n");
        sseStreams.push(res);
      } else if (path === "/beacon") {
        res.writeHead(204);
        res.end();
      } else if (path === "/redir") {
        res.writeHead(302, { location: `${origin}/dir/landing.html` });
        res.end();
      } else if (path === "/setcookie") {
        send(res, "text/plain", "cookie-set", { "set-cookie": "fx=1; Path=/" });
      } else if (path === "/sw-probe.js") {
        send(res, "text/javascript", "self.addEventListener('install', () => {});\n");
      } else if (path === "/__hits") {
        send(res, "application/json", JSON.stringify(hits));
      } else {
        res.writeHead(404, { "content-type": "text/plain", "content-length": 4 });
        res.end("nope");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        origin,
        stop: () => {
          for (const r of sseStreams) r.destroy();
          server.close();
        },
      });
    });
  });
}
