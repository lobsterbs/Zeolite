/* Real Chromium regression for #416/#428. Local HTTPS fixtures only.
   Run: node suite/e2e/embedded-popups.mjs
   Optional: ZL_CHROMIUM=/path/to/chromium, ZL_PLAYWRIGHT_MODULE=/path/to/index.mjs */
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { build } = await import(join(root, "app/node_modules/esbuild/lib/main.js"));
const { chromium } = await import(process.env.ZL_PLAYWRIGHT_MODULE || "playwright");
const tmp = mkdtempSync(join(tmpdir(), "zeolite-popup-"));
let app, content, browser;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem")], { stdio: "ignore" });
  const tls = { key: readFileSync(join(tmp, "key.pem")), cert: readFileSync(join(tmp, "cert.pem")) };
  let appOrigin = "", contentOrigin = "";
  const bundle = await build({ stdin: { contents: `
    import {applyNavGuard,navEncode} from './app/src/bootstrap/navguard';
    import {applyEmbedSync} from './app/src/bootstrap/embedsync';
    import {decodeClientUrl} from './app/src/codec';
    window.install = (appOrigin) => {
      Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{controller:{
        postMessage(m,ports){
          const d=m.type==='zl:getEmbedder'?{ok:true,origin:appOrigin,url:'https://site.example/dir/page',clientId:'frame-one'}:
            {ok:true,dests:m.routes.map(r=>decodeClientUrl(new URL(r,location.origin)))};
          setTimeout(()=>ports[0].postMessage(d),m.type==='zl:getEmbedder'?150:0);
        }
      }}});
      applyNavGuard(window,location.href,location.origin); applyEmbedSync(window);
      if(parent!==window) window.earlyResult=window.open('https://accounts.example/early','_blank','noopener');
      document.querySelector('#mapped').href = location.origin+navEncode('https://accounts.example/signin?continue=mail')+'#step';
    };`, resolveDir: root, sourcefile: "popup-fixture.ts", loader: "ts" }, bundle: true, format: "iife", write: false });
  content = createServer(tls, (req, res) => {
    res.setHeader("content-type", req.url === "/bridge.js" ? "text/javascript" : "text/html");
    if (req.url === "/bridge.js") return res.end(bundle.outputFiles[0].text);
    res.end(`<!doctype html><title>Popup fixture</title><a id="mapped" target="_blank">Mapped sign-in</a><a id="plain" href="../relative" target="_blank">Relative</a><a id="middle" href="https://accounts.example/middle">Middle</a><script src="/bridge.js"></script><script>install(${JSON.stringify(appOrigin)})</script>`);
  });
  await new Promise(r => content.listen(0, "127.0.0.1", r));
  contentOrigin = `https://127.0.0.1:${content.address().port}`;
  app = createServer(tls, (_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Host fixture</title><iframe src="${contentOrigin}/j/fixture"></iframe><script>window.received=[];addEventListener('message',e=>{if(e.origin===${JSON.stringify(contentOrigin)}&&e.source===document.querySelector('iframe').contentWindow)received.push(e.data)});</script>`);
  });
  await new Promise(r => app.listen(0, "127.0.0.1", r));
  appOrigin = `https://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.ZL_CHROMIUM, args: ["--no-sandbox"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(); await page.goto(appOrigin);
  const frame = page.frames().find(f => f.url().startsWith(contentOrigin));
  assert(frame, "content frame mounted");
  assert.equal(await frame.evaluate(() => window.earlyResult), null);
  await page.waitForFunction(() => received.some(e => e.lb === "navigate"));
  await frame.evaluate(() => { window.open("../js-relative"); window.open(); });
  await frame.click("#mapped"); await frame.click("#plain", { modifiers: ["Control"] }); await frame.click("#middle", { button: "middle" });
  await page.waitForFunction(() => received.filter(e => e.lb === "navigate").length === 6);
  const nav = await page.evaluate(() => received.filter(e => e.lb === "navigate").map(e => e.data));
  assert.deepEqual(nav.map(n => n.href), ["https://accounts.example/early", "https://site.example/js-relative", "", "https://accounts.example/signin?continue=mail#step", "https://site.example/relative", "https://accounts.example/middle"]);
  assert(nav.every(n => n.newTab === true && n.clientId === "frame-one")); assert.equal(nav[2].blank, true);
  assert.equal(context.pages().length, 1, "embedded actions create zero native tabs");
  const native = await page.evaluate(() => { try { new WebSocket("wss://invalid.example/", {headers:{}}); return "accepted"; } catch(e) { return e.name; } });
  assert.equal(native, "SyntaxError", "Chromium rejects the Colyseus options probe synchronously");
  const standalone = await context.newPage(); await standalone.goto(contentOrigin + "/j/fixture");
  const popupPromise = standalone.waitForEvent("popup"); await standalone.evaluate(() => window.open("/native-fallback", "_blank"));
  const popup = await popupPromise; await popup.waitForLoadState("domcontentloaded"); assert(popup.url().startsWith(contentOrigin + "/native-fallback"));
  console.log(JSON.stringify({ checks: 9, passed: 9, embeddedNativeTabs: 0, standaloneFallback: "native", chromium: browser.version() }));
} finally {
  await browser?.close(); await Promise.all([app, content].filter(Boolean).map(s => new Promise(r => s.close(r)))); rmSync(tmp, { recursive: true, force: true });
}
