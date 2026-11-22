/* #709 acceptance gate: an interrupted origin-root passthrough (a
   deploy swap resetting the connection before the first response
   byte) must surface the browser's own network error, never the
   standalone engine error page - which would replace the embedder's
   app shell at its own origin for real users (live: the pin-192
   swap, the lobsterbrowse root).

   Real stack: zeolite-server on 6002, a TCP murder proxy on 7114
   relaying everything to it, real Chromium registering the real SW
   at the proxy origin. The host page boots at the healthy proxy
   root and gains SW control; the proxy then ARMS - existing
   connections are reset (the socket pool must not smuggle a
   pre-armed relay) and every further bare-root / request is
   destroyed before any response byte (the pin-swap shape). A second
   tab navigates the proxy root: the SW answers through the #101
   same-origin passthrough, whose fetch rides the murdered wire.

   Oracle: the navigation fails with a net::ERR_* network error
   (the passthrough contract answers Response.error()). RED before
   the fix: the goto resolves with the engine's standalone error
   document (zl-error meta, Could not load this page). Ports
   6002/7114 never collide with the other suites.
   Run: node suite/e2e/passthrough-neterr.mjs */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import { chromium } from "playwright";

const PROXY_PORT = 7114;
const PROXY = "http://127.0.0.1:" + PROXY_PORT;
const STATIC = process.env.ZL_STATIC ?? resolve("app/dist");

let armed = false;
const live = new Set();

/* The murder proxy: sniff the first request head off the TCP
   stream; an armed bare-root GET is destroyed before any response
   byte, everything else relays to the engine. Arming also resets
   every established connection so a keep-alive socket pooled
   before arming cannot smuggle a root request around the sniff. */
const murder = net.createServer((sock) => {
  live.add(sock);
  let head = Buffer.alloc(0);
  let relay = null;
  const onData = (c) => {
    if (relay) return void relay.write(c);
    head = Buffer.concat([head, c]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0 && head.length > 65536) return void sock.destroy();
    if (end < 0) return;
    const text = head.slice(0, end).toString("latin1");
    const line = text.split("\r\n")[0];
    const mm = /^(\S+)\s+(\S+)\s/.exec(line);
    sock.removeListener("data", onData);
    if (armed && mm && mm[1] === "GET" && mm[2].split("?")[0] === "/") {
      sock.destroy();
      return;
    }
    relay = net.connect(6002, "127.0.0.1", () => {});
    sock.on("error", () => {});
    relay.on("error", () => sock.destroy());
    relay.on("data", (r) => sock.write(r));
    sock.on("data", (r2) => relay.write(r2));
    relay.on("close", () => sock.end());
    sock.on("close", () => relay && relay.end());
    relay.write(head);
  };
  sock.on("data", onData);
  sock.on("error", () => {});
  sock.on("close", () => live.delete(sock));
});
await new Promise((r) => murder.listen(PROXY_PORT, "127.0.0.1", r));

let engineProc = null;
const engineErr = [];
async function waitFor(msg, ms, fn) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error("timeout: " + msg + " ; engine log tail: " + engineErr.join("").slice(-400));
}

async function startEngine() {
  const bin = resolve("target/release/zeolite-server");
  if (!existsSync(bin)) throw new Error("zeolite-server not built: " + bin);
  engineProc = spawn(bin, ["--port", "6002", "--static", STATIC], {
    env: { ...process.env, ZL_TEST_ALLOW_PRIVATE_DESTS: "1", ZL_TEST_EGRESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engineProc.stdout.on("data", (c) => engineErr.push(String(c)));
  engineProc.stderr.on("data", (c) => engineErr.push(String(c)));
  await waitFor("engine on 6002", 60000, async () => {
    try { const r = await fetch(PROXY + "/sw.js"); return r.status === 200; } catch { return false; }
  });
}

let browser = null;
try {
  await startEngine();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  await host.goto(PROXY + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await host.evaluate(() =>
    navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module" }).catch(() => null),
  );
  let controlled = false;
  for (let i = 0; i < 80; i++) {
    if (await host.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false)) {
      controlled = true;
      break;
    }
    await sleep(500);
  }
  if (!controlled) throw new Error("HARNESS-ERROR: the service worker never controlled the host page");

  /* The deploy swap: from here every bare-root arrival dies on the
     wire, including pre-pooled keep-alive connections. */
  armed = true;
  for (const s of [...live]) s.destroy();

  const page = await ctx.newPage();
  let navOk = false;
  let navErr = null;
  try {
    await page.goto(PROXY + "/?zlswap=1", { waitUntil: "commit", timeout: 30000 });
    navOk = true;
  } catch (e) {
    navErr = String(e);
  }
  const failures = [];
  if (navOk) {
    const body = await page.content().catch(() => "");
    if (/name="zl-error"/.test(body))
      failures.push("the interrupted origin-root passthrough rendered the standalone engine error page (the #709 surface defect: the engine replaced the embedder app shell)");
    else
      failures.push("root navigation answered with a document despite the armed mid-wire reset: " + body.slice(0, 120));
  } else if (!/net::ERR_/.test(navErr ?? "")) {
    failures.push("root navigation failed without an honest net::ERR network error: " + navErr);
  }
  if (failures.length) {
    console.log("FAIL passthrough network-error gate (#709)");
    for (const f of failures) console.log("  - " + f);
    process.exitCode = 1;
  } else {
    const code = (navErr ?? "").match(/net::ERR_\w+/);
    console.log("PASS #709: interrupted origin-root passthrough answered " + (code ? code[0] : "a network error") + " (the browser own network error); no engine error page was authored");
  }
} finally {
  await browser?.close();
  engineProc?.kill();
  await new Promise((r) => murder.close(r));
}
