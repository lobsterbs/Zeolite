/* #477 isolation gate: can a service worker host an isolated, terminable
   guest realm in real Chromium? Settles the phase-2 sandbox question with
   observed facts instead of assumptions. Also records the native
   ServiceWorkerRegistration / container shape the phase-1 shim is
   compared against (#477 P1). Nothing here registers a guest or
   executes untrusted code. Run: node suite/e2e/sw-capability.mjs */
import { createServer } from "node:http";
import { chromium } from "playwright";

const NL = String.fromCharCode(10);
const SW = [
  "self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));",
  "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
  "self.addEventListener('message', async (ev) => {",
  "  if (ev.data !== 'zl-cap') return;",
  "  const facts = {",
  "    workerCtor: typeof self.Worker,",
  "    sharedWorkerCtor: typeof self.SharedWorker,",
  "    importScripts: typeof self.importScripts,",
  "    evalFn: typeof eval,",
  "    newFunction: typeof Function,",
  "    webAssembly: typeof WebAssembly,",
  "    offscreenCanvas: typeof OffscreenCanvas,",
  "    setTimeout: typeof setTimeout,",
  "    caches: typeof caches,",
  "    indexedDB: typeof indexedDB,",
  "    websocket: typeof WebSocket,",
  "    crossOriginIsolated: !!self.crossOriginIsolated,",
  "  };",
  "  let nested = null;",
  "  if (typeof self.Worker === 'function') {",
  "    try {",
  "      const src = 'onmessage = () => { while (true) {} }; postMessage(1);';",
  "      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));",
  "      const w = new Worker(url);",
  "      const ready = await new Promise((res) => { const t = setTimeout(() => res(false), 3000); w.onmessage = (ev) => { clearTimeout(t); res(ev.data === 1); }; });",
  "      w.postMessage('loop');",
  "      await new Promise((res) => setTimeout(res, 200));",
  "      w.terminate();",
  "      let alive = false;",
  "      try { const w2 = new Worker(url); alive = true; w2.terminate(); } catch (e) { alive = String(e); }",
  "      nested = { created: true, workerReplied: ready, swSurvivedLoop: true, swCanCreateAfterTerminate: alive };",
  "    } catch (e) { nested = { created: false, error: String(e) }; }",
  "  }",
  "  ev.source.postMessage({ facts, nested });",
  "});",
].join(NL);

const server = createServer((req, res) => {
  if (req.url === "/cap-sw.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(SW);
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><title>sw capability fixture</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(origin + "/");
  const result = await page.evaluate(async () => {
    await navigator.serviceWorker.register("cap-sw.js");
    await navigator.serviceWorker.ready;
    let controllerchange = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { controllerchange = true; });
    await new Promise((res) => {
      if (navigator.serviceWorker.controller) return res();
      navigator.serviceWorker.addEventListener("controllerchange", () => res(), { once: true });
    });
    const reply = new Promise((res) => navigator.serviceWorker.addEventListener("message", (ev) => res(ev.data), { once: true }));
    navigator.serviceWorker.controller.postMessage("zl-cap");
    const capability = await reply;
    /* #477 P1: native shape, captured from the SAME live registration. */
    const reg = await navigator.serviceWorker.getRegistration();
    const regs = await navigator.serviceWorker.getRegistrations();
    const own = (o) => Object.getOwnPropertyNames(Object.getPrototypeOf(o)).sort();
    const native = {
      regsCount: regs.length,
      regFields: own(reg),
      workerFields: reg.active ? own(reg.active) : [],
      containerFields: own(navigator.serviceWorker),
      scope: reg.scope,
      updateViaCache: reg.updateViaCache,
      installing: !!reg.installing,
      waiting: !!reg.waiting,
      activeState: reg.active ? reg.active.state : null,
      hasUpdate: typeof reg.update,
      hasOnupdatefound: "onupdatefound" in reg,
      hasNavigationPreload: "navigationPreload" in reg,
      controllerMatchesActive: navigator.serviceWorker.controller === reg.active,
      controllerScriptURL: navigator.serviceWorker.controller.scriptURL,
      controllerchangeFired: controllerchange,
    };
    return { capability, native };
  });
  console.log(JSON.stringify(result, null, 2));
  const f = result.capability.facts;
  const verdict = f.workerCtor === "function"
    ? (result.capability.nested && result.capability.nested.created && result.capability.nested.swSurvivedLoop
        ? "SW CAN host a terminable nested Worker realm"
        : "SW exposes Worker but nested creation failed: " + JSON.stringify(result.capability.nested))
    : "SW CANNOT create Workers: no isolated realm is available inside the service worker";
  console.log("VERDICT " + verdict);
  const n = result.native;
  console.log("NATIVE reg.waiting=" + n.waiting + " installing=" + n.installing + " state=" + n.activeState
    + " update=" + n.hasUpdate + " onupdatefound=" + n.hasOnupdateFound,
    " regs=" + n.regsCount + " controller===active:" + n.controllerMatchesActive);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}