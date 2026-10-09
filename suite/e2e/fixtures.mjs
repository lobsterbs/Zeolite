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
import { gzipSync } from "node:zlib";

export const PORT_A = 7101;
export const PORT_B = 7102;
export const ORIGIN_A = `http://127.0.0.1:${PORT_A}`;
export const ORIGIN_B = `http://127.0.0.1:${PORT_B}`;

/* 1x1 transparent PNG (naturalWidth > 0 asserts the image decoded). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/* #96: fixed probe body + etag for the pass-through invariant
   (single-range slicing + conditional GETs behave like a spec origin). */
const PT_BODY = Buffer.from(
  "zl-pt-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGHIJKLMNOPQRSTUV",
  "utf8",
);
const PT_ETAG = '"zl-pt-1"';

/* #99: large-document fixture. ~2.2 MB of tag-dense HTML built once
   per fixture process and sliced at fixed byte offsets so multi-byte
   UTF-8 sequences land split across chunk boundaries (the
   incremental rewriter decoder has to flush them). Served with no
   content-length (chunked framing) and cache-control: no-store so
   the engine page cache never answers it: the load always rides
   the wisp transport and the streaming rewriter. */
const BIGDOC_ITEMS = 20000;
let bigdocChunks = null;
function buildBigdoc() {
  const parts = [];
  parts.push("<!doctype html><html><head><title>zl bigdoc</title>");
  parts.push("<style>.bd{color:#123}</style>");
  parts.push("<script>var bdLit=\"/dir/img.png\";var bdN=1;</script>");
  parts.push("</head><body>");
  parts.push("<p id=\"bigdoc-first\">bigdoc-first</p>");
  for (let i = 0; i < BIGDOC_ITEMS; i++) {
    parts.push("<div class=\"bd\" id=\"item-" + i + "\"><a href=\"landing.html\">l</a><span>unicode \u2713 " + i + " \u00fcn\u00efc\u00f6d\u00e9</span></div>");
  }
  parts.push("<img src=\"img.png\" alt=\"b\">");
  parts.push("<img srcset=\"img.png 1x, img.png 2x\" alt=\"s\">");
  parts.push("<p id=\"bigdoc-end\" data-count=\"" + BIGDOC_ITEMS + "\">bigdoc-end</p></body></html>");
  const whole = Buffer.from(parts.join("\n"), "utf8");
  const target = Math.ceil(whole.length / 16);
  const chunks = [];
  for (let off = 0; off < whole.length; off += target) {
    chunks.push(whole.subarray(off, Math.min(whole.length, off + target)));
  }
  bigdocChunks = chunks;
  return chunks;
}

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
      } else if (path.startsWith("/api/echo")) {
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
      } else if (path === "/api/passthrough") {
        /* #96: pass-through invariant probe. Echoes the request facts the
           NativeTransit contract must preserve (method, content-type,
           origin, cookie) and owns range + conditional semantics like a
           spec origin. The E2E harness fetches the exact same probes
           browser-direct and engine-proxied and compares the two. */
        const range = req.headers.range;
        const inm = req.headers["if-none-match"];
        if (range) {
          const m = /^bytes=(\d+)-(\d+)$/.exec(range);
          const total = PT_BODY.length;
          if (m && Number(m[1]) <= Number(m[2]) && Number(m[1]) < total) {
            const end = Math.min(Number(m[2]), total - 1);
            const slice = PT_BODY.subarray(Number(m[1]), end + 1);
            res.writeHead(206, {
              "content-type": "text/plain",
              "content-range": `bytes ${m[1]}-${end}/${total}`,
              "content-length": slice.length,
              "x-zl-fx": "passthrough",
            });
            res.end(slice);
          } else {
            res.writeHead(416, { "content-range": `bytes */${total}` });
            res.end();
          }
        } else if (inm === PT_ETAG) {
          res.writeHead(304, { etag: PT_ETAG });
          res.end();
        } else {
          send(
            res,
            "application/json",
            JSON.stringify({
              zl: "pt",
              url: req.url,
              method: req.method,
              ct: req.headers["content-type"] ?? null,
              origin: req.headers.origin ?? null,
              cookie: req.headers.cookie ?? null,
              body,
            }),
            { "x-zl-fx": "passthrough", etag: PT_ETAG },
          );
        }
      } else if (path === "/api/stream") {
        /* #96: three time-separated chunks - the pass-through invariant
           is that streaming stays streaming, not buffered whole. */
        res.writeHead(200, { "content-type": "text/plain", "x-zl-fx": "passthrough" });
        let i = 0;
        const tick = () => {
          i++;
          if (i > 3) {
            res.end();
            return;
          }
          res.write(`zl-stream-${i}`);
          setTimeout(tick, 60);
        };
        tick();
      } else if (path === "/beacon") {
        res.writeHead(204);
        res.end();
      } else if (path === "/redir") {
        res.writeHead(302, { location: `${origin}/dir/landing.html` });
        res.end();
      } else if (path === "/setcookie") {
        send(res, "text/plain", "cookie-set", { "set-cookie": "fx=1; Path=/" });
      } else if (path === "/setcookie2") {
        /* #96: a distinct cookie so the pass-through probe never rides
           another check's cached /setcookie response (the engine page
           cache would serve it without an upstream hit, so the jar
           admission the probe needs would never run). */
        send(res, "text/plain", "cookie-set", { "set-cookie": "fx2=1; Path=/" });
      } else if (path === "/sw-probe.js") {
        send(res, "text/javascript", "self.addEventListener('install', () => {});\n");
      } else if (path === "/api/methods") {
        /* #92 torture battery: full-fidelity echo (method, selected
           request headers, body) with REAL CORS answers so the direct
           model can preflight. OPTIONS answers the preflight; the
           actual response echoes the request Origin when present. */
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-origin": req.headers.origin ?? "*",
            "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, x-zl-probe, authorization",
            "access-control-max-age": "600",
          });
          res.end();
        } else {
          /* no-store: the engine page cache is cache-first with a
             10-minute fallback TTL when no Cache-Control is present,
             so a cached echo would answer the cookie-lifecycle reads
             without an upstream hit and the jar admission under test
             would never run. The echo must always hit the fixture. */
          const extra = { "cache-control": "no-store" };
          if (req.headers.origin) {
            extra["access-control-allow-origin"] = req.headers.origin;
            extra.vary = "Origin";
          }
          send(res, "application/json", JSON.stringify({
            zl: "methods",
            method: req.method,
            url: req.url,
            ct: req.headers["content-type"] ?? null,
            xzl: req.headers["x-zl-probe"] ?? null,
            auth: req.headers.authorization ?? null,
            cookie: req.headers.cookie ?? null,
            body,
          }), extra);
        }
      } else if (path === "/api/upload") {
        /* #92: multipart echo. The boundary differs per request, so the
           battery compares the semantic fields, not the raw bytes.
           no-store for the same page-cache reason as /api/methods. */
        send(res, "application/json", JSON.stringify({ zl: "upload", ct: req.headers["content-type"] ?? null, body }), { "cache-control": "no-store" });
      } else if (path === "/api/gzip") {
        /* #92: content-encoding body. The invariant is the DECODED text
           the page reads, whichever layer ends up decoding. */
        const gz = gzipSync(Buffer.from("zl-gzip-body-0123456789", "utf8"));
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": gz.length });
        res.end(gz);
      } else if (path === "/api/bigbody") {
        /* #92: ~1 MiB deterministic body in 12 time-separated writes
           with no content-length (chunked framing, EOF-delimited). */
        const line = "zl-big-0123456789abcdef\r\n";
        const block = Buffer.from(line.repeat(4096)); /* 96 KiB */
        res.writeHead(200, { "content-type": "text/plain", "x-zl-fx": "big" });
        let i = 0;
        const tick = () => {
          i++;
          if (i > 11) {
            res.end();
            return;
          }
          res.write(block);
          setTimeout(tick, 40);
        };
        tick();
      } else if (path === "/dir/bigdoc.html") {
        /* #99: first chunk goes out immediately (TTFB), then 150 ms
           gaps make the progressive parse observable; chunked
           framing, no-store. */
        const chunks = bigdocChunks ?? buildBigdoc();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        let i = 0;
        const tick = () => {
          res.write(chunks[i]);
          i++;
          if (i >= chunks.length) {
            res.end();
            return;
          }
          setTimeout(tick, 150);
        };
        tick();
      } else if (path === "/api/slow") {
        /* #92: 700ms TTFB - slow responses must complete, not time out. */
        setTimeout(() => send(res, "text/plain", "zl-slow-ok"), 700);
      } else if (path === "/api/teapot") {
        res.writeHead(418, { "content-type": "text/plain", "content-length": 6 });
        res.end("teapot");
      } else if (path === "/api/fail") {
        res.writeHead(500, { "content-type": "text/plain", "content-length": 11 });
        res.end("server-boom");
      } else if (path.startsWith("/api/redir")) {
        /* #92: one endpoint per redirect code, all landing on the echo.
           The battery POSTs to each and compares the method/body the
           spec says the redirect must produce. */
        const code = Number(path.slice("/api/redir".length));
        if ([301, 302, 303, 307, 308].includes(code)) {
          res.writeHead(code, { location: `${origin}/api/methods` });
          res.end();
        } else {
          res.writeHead(404, { "content-type": "text/plain", "content-length": 4 });
          res.end("nope");
        }
      } else if (path.startsWith("/api/chain/")) {
        /* #92: N-hop 302 chain. 5 stays inside the engine's hop cap, 15
           crosses it: the engine surfaces the 11th hop with a mapped
           Location and the browser re-enters the engine for the rest. */
        const n = Number(path.slice("/api/chain/".length));
        if (Number.isInteger(n) && n >= 0) {
          res.writeHead(302, { location: n === 0 ? `${origin}/api/methods` : `${origin}/api/chain/${n - 1}` });
          res.end();
        } else {
          res.writeHead(404, { "content-type": "text/plain", "content-length": 4 });
          res.end("nope");
        }
      } else if (path === "/api/cookiestart") {
        /* no-store: a page-cached Set-Cookie response would be served
           without an upstream hit, so the jar admission under test
           would never run. */
        send(res, "text/plain", "cookie-set", { "cache-control": "no-store", "set-cookie": "zlt=1; Path=/" });
      } else if (path === "/api/cookiedel") {
        send(res, "text/plain", "cookie-del", { "cache-control": "no-store", "set-cookie": "zlt=; Path=/; Max-Age=0" });
      } else if (path === "/api/cookiesecure") {
        /* #92: Secure+SameSite=Strict cookie. Loopback is a trustworthy
           origin so the DIRECT browser stores and sends it over plain
           http; the engine jar honors the Secure attribute against the
           real target scheme and does not attach it - the battery pins
           that divergence as documented behavior. */
        send(res, "text/plain", "cookie-secure", { "cache-control": "no-store", "set-cookie": "zls=1; Path=/; Secure; SameSite=Strict" });
      } else if (path === "/dir/unicode/%C3%A5.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
        res.end(PNG);
      } else if (path === "/dir/torture.html") {
        /* #92: the rewriter torture page. Edge constructs on purpose:
           a CRLF inside a tag, an unquoted attribute value, padded
           attribute spacing, a unicode path, srcset, an iframe, a
           relative anchor, a JS string-literal URL (rewriter pass)
           and a runtime-concatenated URL (the honest gap: no static
           pass can see it). */
        send(res, "text/html; charset=utf-8", `<!doctype html><html><head><title>zl torture</title>
<link rel="stylesheet" href="torture.css">
<style>.tl-inl{background:url("img.png")}</style>
</head><body>
<p id="zl-marker">zl-torture-page</p>
<div id="tl-inl" class="tl-inl">inl</div>
<div id="tl-ext" class="tl-ext">ext</div>
<div id="tl-imp" class="tl-imp">imp</div>
<img id="crlf"${"\r\n"} src="img.png" alt="c">
<img id="unq" src=img.png alt="u">
<img id="spaced"    src   =   "img.png" alt="s">
<img id="uni" src="unicode/å.png" alt="n">
<img id="ss" srcset="img.png 1x, img.png 2x" alt="x">
<iframe id="fru" src="inner.html"></iframe>
<a id="relimg" href="./img.png">m</a>
<script>
var im2 = new Image(); im2.id = "tlit"; im2.src = "/dir/img.png"; document.body.appendChild(im2);
var pre = "/dir/"; var im3 = new Image(); im3.id = "concat"; im3.src = pre + "img.png"; document.body.appendChild(im3);
</script>
</body></html>`);
      } else if (path === "/dir/torture.css") {
        send(res, "text/css", `@import url("timport.css");
@font-face { font-family: zlt; src: url("zlfont.woff2") format("woff2"); }
.tl-ext {
  background: url(
    "img.png"
  );
}
`);
      } else if (path === "/dir/timport.css") {
        send(res, "text/css", `.tl-imp{background:url("img.png")}`);
      } else if (path === "/dir/zlfont.woff2") {
        const woff = Buffer.from("wOFFzl-torture-font-bytes", "utf8");
        res.writeHead(200, { "content-type": "font/woff2", "content-length": woff.length });
        res.end(woff);
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
