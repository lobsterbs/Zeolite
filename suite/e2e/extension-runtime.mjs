/* Extension runtime e2e: install the repo test extensions plus
   crafted fixtures through the real engine SW control plane, then
   prove function on real proxied sites: content-script injection,
   storage round-trip, messaging round-trip, extension pages, context
   menus, lifecycle, and the host-only install gate. Env style mirrors
   interaction-crawl.mjs: ZL_ENGINE (default http://127.0.0.1:6003),
   ZL_BIN, ZL_STATIC (default ../../app/dist), ZL_FIXROOT, ZL_OUT,
   ZL_SRVLOG. Run from a directory with playwright in node_modules. */
/* w15 extension check: install many extensions through the real
   engine SW control plane (zl:installExtFiles from the controlled host
   page), verify listing/permissions, then prove function on real
   proxied sites: content-script injection, messaging round-trip,
   storage round-trip, extension pages (options/popup), context menus,
   enable/disable, uninstall, and the host-only install gate.
   Port 6003 (the crawl owns 6002). Fixtures: the 10 repo test
   extensions plus 3 crafted realistic ones. */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
import { chromium } from 'playwright';

const ENGINE = process.env.ZL_ENGINE ?? 'http://127.0.0.1:6003';
const BIN = process.env.ZL_BIN ?? 'zeolite-server';
const STATIC = process.env.ZL_STATIC ?? HERE + '../../app/dist';
const FIXROOT = process.env.ZL_FIXROOT ?? HERE + '../test-extensions';
const OUT = process.env.ZL_OUT ?? 'extension-runtime-results.json';
const SRVLOG = process.env.ZL_SRVLOG ?? '/tmp/extension-runtime-server.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function readDirFiles(root) {
  const files = [];
  for (const e of readdirSync(root)) {
    const p = root + '/' + e;
    if (statSync(p).isDirectory()) continue;
    files.push([e, readFileSync(p)]);
  }
  return files;
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

/* Crafted extension sources. */
const CRAFTED = {
  'zl-annotator': {
    'manifest.json': JSON.stringify({ manifest_version: 2, name: 'zl-annotator', version: '1.0', description: 'w15: all-urls banner + storage + messaging round-trip', permissions: ['storage'], background: { scripts: ['bg.js'] }, content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'], run_at: 'document_idle' }] }, null, 2),
    'bg.js': 'browser.runtime.onMessage.addListener((m) => { if (m && m.zlPing) return { zlPong: true, id: browser.runtime.id }; });',
    'cs.js': '(async () => { try { const d = document.createElement("div"); d.id = "zl-annotator"; d.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;background:#b35900;color:#fff;padding:6px;font:12px monospace"; document.body.appendChild(d); const w = (t) => { d.textContent = t; }; w("zl-annotator-boot"); try { await browser.storage.local.set({ w15: "roundtrip" }); const g = await browser.storage.local.get("w15"); w("zl-storage:" + (g && g.w15 === "roundtrip" ? "ok" : "BAD:" + JSON.stringify(g))); } catch (e) { w("zl-storage-err:" + e); } try { const r = await browser.runtime.sendMessage({ zlPing: 1 }); w(d.textContent + " zl-msg:" + (r && r.zlPong ? "ok" : "BAD:" + JSON.stringify(r))); } catch (e) { w(d.textContent + " zl-msg-err:" + e); } } catch (e) { try { const d = document.getElementById("zl-annotator"); if (d) d.textContent = "zl-annotator-fatal:" + e; } catch {} } })();',
  },
  'zl-tabinfo': {
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'zl-tabinfo', version: '1.0', description: 'w15: Firefox-style MV3 background + tabs API surface', permissions: ['tabs'], background: { scripts: ['bg.js'] }, content_scripts: [{ matches: ['https://example.com/*'], js: ['cs.js'] }] }, null, 2),
    'bg.js': 'browser.runtime.onMessage.addListener(async (m) => { if (!m || m.type !== "tabcount") return; const has = typeof browser.tabs !== "undefined"; let n = -1; if (has) { try { const t = await browser.tabs.query({}); n = t.length; } catch (e) { n = -2; } } return { ok: true, hasTabs: has, tabs: n }; });',
    'cs.js': '(async () => { try { const r = await browser.runtime.sendMessage({ type: "tabcount" }); document.documentElement.setAttribute("data-zl-tabinfo", JSON.stringify(r)); } catch (e) { document.documentElement.setAttribute("data-zl-tabinfo", "err:" + e); } })();',
  },
  'zl-menu': {
    'manifest.json': JSON.stringify({ manifest_version: 2, name: 'zl-menu', version: '1.0', description: 'w15: context menu registration', permissions: ['contextMenus'], background: { scripts: ['bg.js'] } }, null, 2),
    'bg.js': 'try { browser.contextMenus.create({ id: "zl-menu-test", title: "Zeolite w15 menu", contexts: ["page"] }); } catch (e) { console.log("zl-menu create err: " + e); }',
  },
};

let browser = null, host = null, consoleBuf = [];
async function ctl(msg) {
  return await host.evaluate((m) => new Promise((res) => {
    const ch = new MessageChannel();
    const c = navigator.serviceWorker.controller;
    if (!c) return res({ ok: false, error: 'no controller on host page' });
    ch.port1.onmessage = (e) => res(e.data);
    c.postMessage(m, [ch.port2]);
    setTimeout(() => res({ ok: false, error: 'ctl timeout' }), 15000);
  }), msg);
}
function ctlInstallMsg(files) {
  const b64 = files.map(([p, buf]) => [p, Buffer.from(buf).toString('base64')]);
  return { filesB64: b64 };
}
async function installFiles(dirName, files) {
  const m = ctlInstallMsg(files);
  return await host.evaluate((m) => new Promise((res) => {
    const files = (m.filesB64 || []).map(([p, b64]) => {
      const s = atob(b64);
      const u = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      return [p, u];
    });
    const ch = new MessageChannel();
    const c = navigator.serviceWorker.controller;
    if (!c) return res({ ok: false, error: 'no controller' });
    ch.port1.onmessage = (e) => res(e.data);
    c.postMessage({ type: 'zl:installExtFiles', files }, [ch.port2]);
    setTimeout(() => res({ ok: false, error: 'install timeout' }), 20000);
  }), m).then(r => ({ ...r, _dir: dirName }));
}

async function contentFrame(pg, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    for (const f of pg.frames()) {
      if (f.parentFrame() !== pg.mainFrame()) continue;
      try {
        const u = f.url();
        if (!u.includes('/j/') && !u.includes('__zl_navh__')) continue;
        const n = await Promise.race([f.evaluate('document.querySelectorAll(String.fromCharCode(42)).length'), sleep(5000).then(() => null)]);
        if (n !== null && n >= 8) return f;
      } catch {}
    }
    await sleep(400);
  }
  return null;
}

async function main() {
  console.log('== w15 extension check ==');
  if (!(await waitHealth(20000))) { console.error('server 6003 did not come up'); process.exit(1); }
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  host = await ctx.newPage();

  /* Host page: an embed loads the engine and registers the SW. */
  await check('host: embed page is SW-controlled (control plane available)', async () => {
    await host.goto(ENGINE + '/?url=' + encodeURIComponent('https://example.com'), { waitUntil: 'domcontentloaded', timeout: 30000 });
    const fr = await contentFrame(host, 30000);
    if (!fr) throw new Error('no proxied frame rendered');
    const ctlOk = await host.evaluate(() => !!navigator.serviceWorker.controller);
    if (!ctlOk) throw new Error('no controller on the embed page');
    return 'frame ' + fr.url().slice(0, 40);
  });

  /* Install the 10 repo fixtures + 3 crafted extensions. */
  const installed = [];
  const fixtureDirs = readdirSync(FIXROOT).filter(d => { try { return statSync(FIXROOT + '/' + d).isDirectory(); } catch { return false; } });
  await check('install: all ' + (fixtureDirs.length + Object.keys(CRAFTED).length) + ' extensions accepted (zl:installExtFiles)', async () => {
    for (const d of fixtureDirs) {
      const r = await installFiles(d, readDirFiles(FIXROOT + '/' + d));
      installed.push(r);
      if (!r.ok) throw new Error('fixture ' + d + ' install failed: ' + JSON.stringify(r));
    }
    for (const [name, files] of Object.entries(CRAFTED)) {
      const r = await installFiles(name, Object.entries(files).map(([p, c]) => [p, Buffer.from(c)]));
      installed.push(r);
      if (!r.ok) throw new Error('crafted ' + name + ' install failed: ' + JSON.stringify(r));
    }
    const warn = installed.filter(r => (r.warnings || []).length || (r.unsupportedFields || []).length);
    return installed.length + ' ok; ' + warn.length + ' with warnings/unsupported fields';
  });

  let list = null;
  await check('list: zl:listExt shows every extension installed and enabled', async () => {
    list = await ctl({ type: 'zl:listExt' });
    if (!list.ok) throw new Error('listExt failed: ' + JSON.stringify(list));
    if (!Array.isArray(list.extensions)) throw new Error('no extensions array');
    const bad = list.extensions.filter(e => !['enabled', 'running', 'installed'].includes(e.state) || e.enabled !== true);
    const names = list.extensions.map(e => e.name);
    if (bad.length) throw new Error('not enabled/installed: ' + JSON.stringify(bad));
    if (!names.includes('zl-annotator') || !names.includes('zl-tabinfo') || !names.includes('zl-menu')) throw new Error('crafted extensions missing: ' + JSON.stringify(names));
    return list.extensions.length + ' listed: ' + names.join(', ');
  });

  const idOf = (name) => (list?.extensions || []).find(e => e.name === name)?.id ?? null;

  await check('info: zl:extInfo reports manifest surface (permissions, content scripts, options)', async () => {
    const id = idOf('Zeolite Storage Fixture');
    if (!id) throw new Error('storage fixture id unknown');
    const info = await ctl({ type: 'zl:extInfo', extId: id });
    if (!info.ok) throw new Error('extInfo failed: ' + JSON.stringify(info));
    if (!(info.extension.permissions || []).includes('storage')) throw new Error('storage permission missing: ' + JSON.stringify(info.extension));
    return 'permissions ' + JSON.stringify(info.extension.permissions);
  });

  await check('mv3-service-worker: install warns honestly (recorded, not executed)', async () => {
    const r = installed.find(x => x._dir === 'mv3-service-worker');
    if (!r) throw new Error('mv3-service-worker install result missing');
    const blob = JSON.stringify([r.warnings, r.unsupportedFields]);
    if (!/service.?worker/i.test(blob)) throw new Error('no MV3 SW warning surfaced: ' + blob);
    return blob.slice(0, 200);
  });

  /* Function on real proxied sites: TOP-LEVEL navigation via
     zl:navHandle (LobsterBrowse's production path). The embed page's
     subframe is deliberately NOT used here: non-all_frames content
     scripts must not run in subframes, so the old subframe-based
     checks could never pass by design. */
  let pg = null, fr = null;
  await check('content-script: repo fixture injects its runtime id on a real proxied page', async () => {
    const h = await ctl({ type: 'zl:navHandle', dest: 'https://example.com/' });
    if (!h.ok) throw new Error('navHandle failed: ' + JSON.stringify(h));
    pg = await ctx.newPage();
    pg.on('console', m => consoleBuf.push(m.type() + ': ' + m.text()));
    await pg.goto(ENGINE + h.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    fr = pg.mainFrame();
    const id = idOf('Zeolite ContentScript Fixture');
    let attr = '';
    for (let i = 0; i < 40; i++) {
      attr = await Promise.race([fr.evaluate('document.documentElement.getAttribute(String.fromCharCode(100,97,116,97,45,122,108,45,99,115,45,102,105,120,116,117,114,101))'), sleep(4000).then(() => null)]) ?? '';
      if (attr) break;
      await sleep(500);
    }
    if (attr !== id) throw new Error('data-zl-cs-fixture = ' + JSON.stringify(attr) + ', expected ext id ' + JSON.stringify(id));
    return 'attribute equals runtime id ' + attr;
  });

  await check('annotator: crafted all-urls ext works end to end (injection + storage + messaging)', async () => {
    if (!fr) throw new Error('no frame');
    let txt = '';
    for (let i = 0; i < 40; i++) {
      txt = await Promise.race([fr.evaluate('(() => { const d = document.getElementById(String.fromCharCode(122,108,45,97,110,110,111,116,97,116,111,114)); return d ? d.textContent : ""; })()'), sleep(4000).then(() => null)]) ?? '';
      if (txt.includes('zl-msg:')) break;
      await sleep(500);
    }
    if (!/zl-storage:ok/.test(txt)) throw new Error('storage round-trip missing: ' + JSON.stringify(txt));
    if (!/zl-msg:ok/.test(txt)) throw new Error('messaging round-trip missing: ' + JSON.stringify(txt));
    return txt;
  });

  await check('messaging: repo fixture content script gets the background pong', async () => {
    if (!fr) throw new Error('no frame');
    let got = '';
    for (let i = 0; i < 30; i++) {
      const hits = consoleBuf.filter(c => c.includes('messaging cs reply'));
      if (hits.length) { got = hits[hits.length - 1]; break; }
      await sleep(500);
    }
    if (!got) throw new Error('no messaging cs reply in console; buffer: ' + JSON.stringify(consoleBuf.slice(-15)));
    if (!got.includes('pong')) throw new Error('reply had no pong: ' + got);
    return got;
  });

  await check('tabinfo: crafted Firefox-style MV3 background answers a tabs query', async () => {
    if (!fr) throw new Error('no frame');
    let attr = '';
    for (let i = 0; i < 40; i++) {
      attr = await Promise.race([fr.evaluate('document.documentElement.getAttribute(String.fromCharCode(100,97,116,97,45,122,108,45,116,97,98,105,110,102,111))'), sleep(4000).then(() => null)]) ?? '';
      if (attr) break;
      await sleep(500);
    }
    const o = (() => { try { return JSON.parse(attr); } catch { return null; } })();
    if (!o || !o.ok) throw new Error('tabinfo attribute: ' + JSON.stringify(attr));
    return 'hasTabs=' + o.hasTabs + ' tabs=' + o.tabs;
  });

  await check('multiframe: document_start all_frames script marks window.name', async () => {
    if (!fr) throw new Error('no frame');
    const nm = await Promise.race([fr.evaluate('window.name'), sleep(5000).then(() => null)]);
    if (nm !== 'zl-multiframe-top') throw new Error('window.name = ' + JSON.stringify(nm));
    return nm;
  });

  await check('injection persistence: a second real proxied site also gets the all-urls scripts', async () => {
    const h2 = await ctl({ type: 'zl:navHandle', dest: 'https://www.wikipedia.org/' });
    if (!h2.ok) throw new Error('navHandle failed: ' + JSON.stringify(h2));
    const pg2 = await ctx.newPage();
    await pg2.goto(ENGINE + h2.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const fr2 = pg2.mainFrame();
    let ann = '';
    for (let i = 0; i < 40; i++) {
      ann = await Promise.race([fr2.evaluate('(() => { const d = document.getElementById(String.fromCharCode(122,108,45,97,110,110,111,116,97,116,111,114)); return d ? d.textContent : ""; })()'), sleep(4000).then(() => null)]) ?? '';
      if (ann.includes('zl-msg:')) break;
      await sleep(500);
    }
    const attr = await Promise.race([fr2.evaluate('document.documentElement.getAttribute(String.fromCharCode(100,97,116,97,45,122,108,45,99,115,45,102,105,120,116,117,114,101))'), sleep(4000).then(() => null)]) ?? '';
    if (!/zl-storage:ok/.test(ann) || !/zl-msg:ok/.test(ann)) throw new Error('annotator incomplete on wikipedia: ' + JSON.stringify(ann));
    if (!attr) throw new Error('content-script fixture attribute missing on wikipedia');
    await pg2.close();
    return 'wikipedia: annotator + fixture attribute present';
  });

  await check('ext pages: options and popup pages serve real content through zl:openExtPage', async () => {
    const oid = idOf('Zeolite Options Fixture');
    const pid = idOf('Zeolite Popup Fixture');
    const op = await ctl({ type: 'zl:openExtPage', extId: oid, which: 'options' });
    if (!op.ok) throw new Error('options openExtPage failed: ' + JSON.stringify(op));
    const pg3 = await ctx.newPage();
    await pg3.goto(ENGINE + op.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ot = await pg3.evaluate('document.body.innerText');
    if (!ot.includes('options fixture')) throw new Error('options page text: ' + JSON.stringify(ot));
    const pp = await ctl({ type: 'zl:openExtPage', extId: pid, which: 'popup' });
    if (!pp.ok) throw new Error('popup openExtPage failed: ' + JSON.stringify(pp));
    await pg3.goto(ENGINE + pp.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const pt = await pg3.evaluate('document.getElementById(String.fromCharCode(115)).textContent');
    if (!pt.startsWith('ext ')) throw new Error('popup #s text: ' + JSON.stringify(pt));
    await pg3.close();
    return 'options text ok; popup "ext <runtime id>" ok';
  });

  await check('menus: crafted context-menu item registers (zl:listMenus)', async () => {
    const lm = await ctl({ type: 'zl:listMenus' });
    if (!lm.ok) throw new Error('listMenus failed: ' + JSON.stringify(lm));
    const flat = JSON.stringify(lm.menus || []);
    if (!flat.includes('zl-menu-test')) throw new Error('menu item missing: ' + flat);
    return flat.slice(0, 200);
  });

  await check('gate: a proxied page cannot install extensions (host-only refusal)', async () => {
    if (!fr) throw new Error('no frame');
    const r = await fr.evaluate(() => new Promise((res) => {
      const ch = new MessageChannel();
      const c = navigator.serviceWorker.controller;
      if (!c) return res({ ok: false, error: 'no controller' });
      ch.port1.onmessage = (e) => res(e.data);
      c.postMessage({ type: 'zl:installExtFiles', files: [['manifest.json', new TextEncoder().encode(JSON.stringify({ manifest_version: 2, name: 'zl-gate-probe', version: '1.0' }))]] }, [ch.port2]);
      setTimeout(() => res({ ok: false, error: 'timeout' }), 8000);
    }));
    if (r.ok) throw new Error('proxied page installed an extension: ' + JSON.stringify(r));
    if (!/host-only/.test(r.error || '')) throw new Error('unexpected refusal: ' + JSON.stringify(r));
    return 'refused: ' + r.error;
  });

  await check('lifecycle: disable/enable round-trip, then uninstall removes the extension', async () => {
    const id = idOf('Zeolite Hello');
    const off = await ctl({ type: 'zl:extEnable', extId: id, enabled: false });
    if (!off.ok) throw new Error('disable failed: ' + JSON.stringify(off));
    let l2 = await ctl({ type: 'zl:listExt' });
    if (l2.extensions.find(e => e.id === id)?.enabled !== false) throw new Error('still enabled after disable');
    const on = await ctl({ type: 'zl:extEnable', extId: id, enabled: true });
    if (!on.ok) throw new Error('enable failed');
    l2 = await ctl({ type: 'zl:listExt' });
    if (l2.extensions.find(e => e.id === id)?.enabled !== true) throw new Error('not re-enabled');
    const wid = idOf('Zeolite WebRequest Blocker Fixture');
    const un = await ctl({ type: 'zl:extUninstall', extId: wid });
    if (!un.ok) throw new Error('uninstall failed: ' + JSON.stringify(un));
    l2 = await ctl({ type: 'zl:listExt' });
    if (l2.extensions.some(e => e.id === wid)) throw new Error('webrequest-blocker still listed after uninstall');
    return 'disabled+re-enabled hello; uninstalled webrequest-blocker; ' + l2.extensions.length + ' remain';
  });

  const failed = results.filter(r => !r.ok);
  writeFileSync(OUT, JSON.stringify({ results, installed, list: list?.extensions ?? null }, null, 2));
  console.log('');
  console.log('== w15 extension summary: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed ==');
  if (failed.length) process.exitCode = 1;
}

main()
  .catch(e => { console.log('[HARNESS-ERROR] ' + (e?.stack ?? e)); process.exitCode = 1; })
  .finally(async () => {
    try { await browser?.close(); } catch {}
    try { server.kill('SIGKILL'); } catch {}
  });
