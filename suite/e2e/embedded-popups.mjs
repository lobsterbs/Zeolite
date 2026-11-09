/* Real Chromium regression for #416/#428/#553. Local HTTPS fixtures only.
   Run: node suite/e2e/embedded-popups.mjs
   Optional: ZL_CHROMIUM=/path/to/chromium, ZL_PLAYWRIGHT_MODULE=/path/to/index.mjs

   #553 slice 2 coverage: the synchronous facade return, name reuse,
   pid correlation, host popupState reports flipping closed, the
   close/focus/postMessage relay ops, invalid-targetOrigin rejection,
   and fail-closed blocked-popup semantics. Opens driven from
   evaluate carry no user gesture and still route: the embedder host
   owns popup policy, a documented divergence from the native popup
   blocker. Delivery of relayed messages into the popup tab ships
   with the host integration. */
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
  const fixtureSrc = [
    "import {applyNavGuard,navEncode} from './app/src/bootstrap/navguard';",
    "import {applyEmbedSync} from './app/src/bootstrap/embedsync';",
    "import {decodeClientUrl} from './app/src/codec';",
    "window.install = (appOrigin, fail) => {",
    "  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{controller:{",
    "    postMessage(m,ports){",
    "      const d=m.type==='zl:getEmbedder'?(fail?{ok:false}:{ok:true,origin:appOrigin,url:'https://site.example/dir/page',clientId:'frame-one'}):",
    "        {ok:true,dests:m.routes.map(r=>decodeClientUrl(new URL(r,location.origin)))};",
    "      setTimeout(()=>ports[0].postMessage(d),m.type==='zl:getEmbedder'?150:0);",
    "    }",
    "  }}});",
    "  applyNavGuard(window,location.href,location.origin); applyEmbedSync(window);",
    "  if(parent!==window) window.early = window.open('https://accounts.example/early','_blank','noopener');",
    "  document.querySelector('#mapped').href = location.origin+navEncode('https://accounts.example/signin?continue=mail')+'#step';",
    "};",
  ].join("\n");
  const bundle = await build({ stdin: { contents: fixtureSrc, resolveDir: root, sourcefile: "popup-fixture.ts", loader: "ts" }, bundle: true, format: "iife", write: false });
  content = createServer(tls, (req, res) => {
    res.setHeader("content-type", req.url === "/bridge.js" ? "text/javascript" : "text/html");
    if (req.url === "/bridge.js") return res.end(bundle.outputFiles[0].text);
    res.end([
      "<!doctype html><title>Popup fixture</title>",
      "<a id=\"mapped\" target=\"_blank\">Mapped sign-in</a>",
      "<a id=\"plain\" href=\"../relative\" target=\"_blank\">Relative</a>",
      "<a id=\"middle\" href=\"https://accounts.example/middle\">Middle</a>",
      "<script src=\"/bridge.js\"></script>",
      "<script>install(" + JSON.stringify(appOrigin) + ", location.search.indexOf('fail=1') >= 0)</script>",
    ].join(""));
  });
  await new Promise(r => content.listen(0, "127.0.0.1", r));
  contentOrigin = "https://127.0.0.1:" + content.address().port;
  app = createServer(tls, (req, res) => {
    res.setHeader("content-type", "text/html");
    const fail = req.url.indexOf("fail=1") >= 0;
    res.end([
      "<!doctype html><title>Host fixture</title>",
      "<iframe src=\"" + contentOrigin + "/j/fixture" + (fail ? "?fail=1" : "") + "\"></iframe>",
      "<script>window.received=[];",
      "addEventListener('message',function(e){if(e.origin===" + JSON.stringify(contentOrigin) + "&&e.source===document.querySelector('iframe').contentWindow)received.push(e.data)});",
      "window.replyState=function(pid,closed){document.querySelector('iframe').contentWindow.postMessage({lb:'popupState',data:{pid:pid,closed:closed}}," + JSON.stringify(contentOrigin) + ")};</script>",
    ].join(""));
  });
  await new Promise(r => app.listen(0, "127.0.0.1", r));
  appOrigin = "https://127.0.0.1:" + app.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.ZL_CHROMIUM, args: ["--no-sandbox"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(appOrigin);
  const frame = page.frames().find(f => f.url().startsWith(contentOrigin));
  assert(frame, "content frame mounted");
  const early = await frame.evaluate(() => (window.early ? { t: typeof window.early, name: window.early.name, closed: window.early.closed, json: JSON.stringify(window.early) } : null));
  assert(early && early.t === "object", "pre-settle window.open returns the facade synchronously");
  assert.equal(early.name, "", "native _blank popup name is the empty string");
  assert.equal(early.closed, false, "closed is honestly false before any host report");
  assert(!early.json.includes("accounts.example"), "the facade carries no plaintext destination");
  await page.waitForFunction(() => window.received.some(e => e.lb === "navigate"));
  await frame.evaluate(() => {
    window.a = window.open("https://chat.example/1", "chat");
    window.b = window.open("https://chat.example/2", "chat");
    window.c = window.open("https://plain.example/1");
  });
  await frame.click("#mapped");
  await frame.click("#plain", { modifiers: ["Control"] });
  await frame.click("#middle", { button: "middle" });
  await frame.evaluate(() => { window.open("../js-relative"); window.open(); });
  await page.waitForFunction(() => window.received.filter(e => e.lb === "navigate").length === 9);
  const reuse = await frame.evaluate(() => [window.a === window.b, window.a !== window.c, window.c.name]);
  assert(reuse[0], "same-name reuse returns the identical facade object");
  assert(reuse[1], "unnamed opens mint a distinct facade");
  assert.equal(reuse[2], "", "an unnamed facade carries the empty name");
  const nav = await page.evaluate(() => window.received.filter(e => e.lb === "navigate").map(e => e.data));
  assert.deepEqual(nav.map(n => n.href), [
    "https://accounts.example/early",
    "https://chat.example/1",
    "https://chat.example/2",
    "https://plain.example/1",
    "https://accounts.example/signin?continue=mail#step",
    "https://site.example/relative",
    "https://accounts.example/middle",
    "https://site.example/js-relative",
    "",
  ]);
  assert(nav.every(n => n.newTab === true && n.clientId === "frame-one" && typeof n.pid === "string" && n.pid.indexOf("zlp") === 0), "every routed open correlates by an opaque pid");
  assert.equal(nav[1].name, "chat", "the navigate op carries the target name");
  assert.equal(nav[8].blank, true, "a no-URL open routes as a blank tab op");
  await page.evaluate(pid => window.replyState(pid, true), nav[3].pid);
  await frame.waitForFunction(() => window.c.closed === true);
  const closedPair = await frame.evaluate(() => [window.c.closed, window.a.closed]);
  assert.equal(closedPair[0], true, "the host popupState report flips closed for the addressed pid");
  assert.equal(closedPair[1], false, "an unaddressed facade stays open");
  const errName = await frame.evaluate(() => {
    window.a.close(); window.a.focus(); window.a.postMessage({ hi: 1 }, "*");
    try { window.a.postMessage(1, "bad origin"); return "no-throw"; } catch (e) { return e.name; }
  });
  assert.equal(errName, "SyntaxError", "an invalid targetOrigin throws SyntaxError, native parity");
  await frame.waitForFunction(() => window.a.closed === true);
  const ops = await page.evaluate(() => window.received.filter(e => e.lb !== "navigate" && e.lb !== "nav").map(e => e.data));
  assert.deepEqual(ops.map(o => o.name), ["chat", "chat", "chat"], "close/focus/postMessage ops carry the target name");
  assert(ops.every(o => o.pid === nav[2].pid), "ops correlate with the newest pid of the reused name");
  const pm = ops.find(o => o.targetOrigin !== undefined);
  assert(pm && JSON.stringify(pm.msg) === JSON.stringify({ hi: 1 }), "the relayed message rides the op byte-faithfully");
  assert.equal(pm.targetOrigin, "*", "the targetOrigin rides the op");
  assert.equal(await frame.evaluate(() => window.a.closed), true, "close() flips closed locally");
  const failPage = await context.newPage();
  await failPage.goto(appOrigin + "/?fail=1");
  const failFrame = failPage.frames().find(f => f.url().startsWith(contentOrigin));
  assert(failFrame, "fail-closed frame mounted");
  await failPage.waitForTimeout(600);
  const failState = await failFrame.evaluate(() => ({ open: window.open("https://blocked.example/x", "blocked"), earlyClosed: window.early.closed }));
  assert.equal(failState.open, null, "a fail-closed embedder swallows the popup: native blocked-popup semantics");
  assert.equal(failState.earlyClosed, true, "a facade minted before the fail-closed verdict flips closed");
  assert.equal(context.pages().length, 2, "embedded actions create zero native tabs");
  const native = await page.evaluate(() => { try { new WebSocket("wss://invalid.example/", { headers: {} }); return "accepted"; } catch (e) { return e.name; } });
  assert.equal(native, "SyntaxError", "Chromium rejects the Colyseus options probe synchronously");
  const standalone = await context.newPage();
  await standalone.goto(contentOrigin + "/j/fixture");
  const popupPromise = standalone.waitForEvent("popup");
  await standalone.evaluate(() => window.open("/native-fallback", "_blank"));
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert(popup.url().startsWith(contentOrigin + "/native-fallback"), "standalone documents keep native windows");
  console.log(JSON.stringify({ checks: 26, passed: 26, embeddedNativeTabs: 0, standaloneFallback: "native", chromium: browser.version() }));
} finally {
  await browser?.close();
  await Promise.all([app, content].filter(Boolean).map(s => new Promise(r => s.close(r))));
  rmSync(tmp, { recursive: true, force: true });
}
