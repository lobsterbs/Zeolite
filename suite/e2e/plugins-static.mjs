/* Plugin registry e2e (#256): prove a shipped sample plugin loads
   and RUNS in a real Chromium service worker. Serves the built dist
   with a siteconfig that lists "sample-observer" for example.com,
   drives proxied navigations through the real engine SW, and asserts
   the plugin's bounded diagnostic appears EXACTLY once (the second
   navigation must not re-emit: register() runs once per worker
   lifetime). Env mirrors extension-runtime.mjs: ZL_ENGINE (default
   http://127.0.0.1:6010), ZL_BIN, ZL_OUT, ZL_SRVLOG. Run from a
   directory with playwright in node_modules. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ENGINE = process.env.ZL_ENGINE ?? 'http://127.0.0.1:6010';
const BIN = process.env.ZL_BIN ?? HERE + '../../target/release/zeolite-server';
const OUT = process.env.ZL_OUT ?? 'plugins-static-results.json';
const SRVLOG = process.env.ZL_SRVLOG ?? '/tmp/plugins-static-server.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Fresh static dir: the built dist plus a siteconfig that wires the
   shipped sample plugin to example.com. */
const STATIC = '/tmp/zl-plugins-static';
rmSync(STATIC, { recursive: true, force: true });
mkdirSync(STATIC, { recursive: true });
cpSync(HERE + '../../app/dist', STATIC, { recursive: true });
writeFileSync(STATIC + '/siteconfig.kdl', 'site "example.com" {\n  plugins "sample-observer"\n}\n');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
    console.log('[PASS] ' + name + (detail ? ' | ' + detail : ''));
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log('[FAIL] ' + name + ' | ' + String(err?.message ?? err));
  }
}

const server = spawn(BIN, ['--port', new URL(ENGINE).port || '80', '--static', STATIC], { stdio: ['ignore', openSync(SRVLOG, 'a'), openSync(SRVLOG, 'a')] });
async function waitHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(ENGINE + '/sw.js', { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {}
    await sleep(300);
  }
  return false;
}

const MARKER = 'sample-observer plugin loaded and saw a response';

async function main() {
  console.log('== #256 plugin registry e2e ==');
  if (!(await waitHealth(20000))) { console.error('server did not come up'); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const host = await ctx.newPage();
    const ctl = (msg) => host.evaluate((m) => new Promise((res) => {
      const ch = new MessageChannel();
      const c = navigator.serviceWorker.controller;
      if (!c) return res({ ok: false, error: 'no controller on host page' });
      ch.port1.onmessage = (e) => res(e.data);
      c.postMessage(m, [ch.port2]);
      setTimeout(() => res({ ok: false, error: 'ctl timeout' }), 15000);
    }), msg);

    await check('host: embed page is SW-controlled', async () => {
      await host.goto(ENGINE + '/?url=' + encodeURIComponent('https://example.com'), { waitUntil: 'domcontentloaded', timeout: 30000 });
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        if (await host.evaluate(() => !!navigator.serviceWorker.controller)) break;
        await sleep(300);
      }
      if (!(await host.evaluate(() => !!navigator.serviceWorker.controller))) throw new Error('no controller');
      return 'controlled';
    });

    const nav = async () => {
      const h = await ctl({ type: 'zl:navHandle', dest: 'https://example.com/' });
      if (!h.ok) throw new Error('navHandle failed: ' + JSON.stringify(h));
      const pg = await ctx.newPage();
      await pg.goto(ENGINE + h.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const n = await Promise.race([pg.evaluate('document.querySelectorAll(String.fromCharCode(42)).length'), sleep(5000).then(() => null)]) ?? 0;
        if (n >= 8) { await pg.close(); return true; }
        await sleep(400);
      }
      await pg.close();
      throw new Error('proxied example.com never rendered');
    };

    await check('proxied navigation through the engine', async () => { await nav(); return 'example.com rendered'; });

    let seenCount = 0;
    await check('sample plugin loaded and ran in the real SW', async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        const d = await ctl({ type: 'zl:getDiag', since: 0 });
        seenCount = (d.events || []).filter((e) => e.message && e.message.includes(MARKER)).length;
        if (seenCount > 0) break;
        await sleep(400);
      }
      if (seenCount === 0) throw new Error('plugin diagnostic never appeared in the diag ring');
      return 'diag events: ' + seenCount;
    });

    await check('second navigation does not re-emit (bounded once)', async () => {
      await nav();
      const d = await ctl({ type: 'zl:getDiag', since: 0 });
      const n = (d.events || []).filter((e) => e.message && e.message.includes(MARKER)).length;
      if (n !== 1) throw new Error('expected exactly 1 plugin diag, saw ' + n);
      return 'exactly 1 after two navigations';
    });

    await check('no unknown-plugin warning for the shipped name', async () => {
      const d = await ctl({ type: 'zl:getDiag', since: 0 });
      const warned = (d.events || []).filter((e) => e.message && e.message.includes('not in the build registry')).length;
      if (warned !== 0) throw new Error('unexpected registry warning present');
      return 'clean';
    });
  } finally {
    await browser.close();
    server.kill();
  }
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  const bad = results.filter(r => !r.ok).length;
  console.log(bad ? 'FAIL ' + bad : 'ALL PASS');
  process.exit(bad ? 1 : 0);
}
main();
