/* Deterministic local fixture origin for the compat suite (Phase 9,
   1.9 Fullerene). A tiny node:http server on 127.0.0.1 serving fixed
   bytes: an HTML document exercising links/scripts/iframes/opaque
   hrefs, a CSS file with url() references, a JS file, redirect
   chains, an attachment download, media bytes, error statuses and a
   Set-Cookie endpoint. Everything is static and byte-stable, so
   probe results against it are deterministic.

   The engine's SSRF policy blocks loopback destinations by default;
   the nightly compat job starts zeolite-server with
   ZL_TEST_ALLOW_PRIVATE_DESTS=1 (a test-only escape hatch in
   crates/zeolite-server/src/policy.rs) so these fixtures can be
   proxied. Production default stays strict. */

import { createServer } from "node:http";

export function fixtureContent(origin) {
  const HTML = `<!doctype html>
<html><head><title>fixture</title>
<link rel="stylesheet" href="${origin}/style.css">
<script src="${origin}/app.js"></script></head>
<body>
<a href="${origin}/page2">page two</a>
<img src="${origin}/logo.png">
<iframe src="${origin}/frame.html"></iframe>
<a href="blob:${origin}/uuid">opaque blob</a>
<a href="data:text/plain,hello">opaque data</a>
</body></html>`;
  const CSS = `body{background:url(${origin}/bg.png)}.c{background:url("${origin}/x.png")}`;
  const JS = `window.__FIXTURE__="stable-marker-7f3a";/* ${origin}/page2 */`;
  return { HTML, CSS, JS };
}

export const MEDIA = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);

export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const { HTML, CSS, JS } = fixtureContent(origin);
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/page.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML);
      } else if (path === "/page2") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>page two</title><p>page-two-marker</p>");
      } else if (path === "/frame.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><p>frame-marker</p>");
      } else if (path === "/style.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(CSS);
      } else if (path === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(JS);
      } else if (path === "/logo.png" || path === "/bg.png" || path === "/x.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(MEDIA);
      } else if (path === "/media.bin") {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(MEDIA);
      } else if (path === "/redirect301") {
        res.writeHead(301, { location: `${origin}/page2` });
        res.end();
      } else if (path === "/redirect302") {
        res.writeHead(302, { location: `${origin}/style.css` });
        res.end();
      } else if (path === "/redirect307") {
        res.writeHead(307, { location: `${origin}/app.js` });
        res.end();
      } else if (path === "/download") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="fixture.bin"' });
        res.end(MEDIA);
      } else if (path === "/echo") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("echo:" + body);
        });
      } else if (path === "/setcookie") {
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": "fx=1; Path=/" });
        res.end("cookie-set");
      } else if (path === "/missing") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not-found-marker");
      } else if (path === "/boom") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("server-error-marker");
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
