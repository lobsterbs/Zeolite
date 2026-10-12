/* w14 crawl v3: sites through the pinned engine dist bytes.
   Fresh context per site. Per-site: consent-overlay dismissal
   (honest click on the site own accept button), scroll round-trip
   (window then largest scrollable container), captcha press
   (detection + one honest press, never a solve), search submit
   navigation, button click, link navigation. Engine error pages
   captured with reason/category/trace. Server stdio to file +
   auto-restart on connection-refused streaks.
   Env: ZL_ENGINE ZL_OUT ZL_PROG ZL_SRVLOG ZL_STATIC ZL_BIN ZL_WORKERS
   ZL_RESUME=1 (skip sites already present in ZL_OUT).
   Every frame/page evaluate races a watchdog (EV_MS): a wedged
   renderer answers null after the cap instead of stalling the
   worker forever (finn.no once hung one probe for ~32 min). */
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, openSync } from 'node:fs';
import { chromium } from 'playwright';

const ENGINE = process.env.ZL_ENGINE || 'http://127.0.0.1:6002';
const OUT = process.env.ZL_OUT || '/home/sprite/w14-results.jsonl';
const PROG = process.env.ZL_PROG || '/home/sprite/w14-progress.txt';
const SRVLOG = process.env.ZL_SRVLOG || '/home/sprite/w14-server.log';
const STATIC = process.env.ZL_STATIC || '/home/sprite/w14static';
const BIN = process.env.ZL_BIN || '/home/sprite/Zeolite/target/release/zeolite-server';
const WORKERS = Number(process.env.ZL_WORKERS || 3);
const GOTO_MS = 25000, FRAME_WAIT_MS = 20000, SETTLE_MS = 12000, EV_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LIST = JSON.parse(readFileSync(new URL('./crawl-sites.json', import.meta.url), 'utf8'));

const BOTWALL = ['Just a moment','Checking your browser','Attention Required','Verify you are human','confirm you are human','unusual traffic','Access denied','DDoS protection','security check','Enable JavaScript and cookies to continue','Sorry, you have been blocked','Request unsuccessful','Incapsula','Press & Hold'];

const METRICS = "(() => {" +
  "const vis = el => { try { const s = getComputedStyle(el); const rc = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && rc.width > 0 && rc.height > 0; } catch { return false; } };" +
  "const btns = [...document.querySelectorAll('button')].filter(vis);" +
  "const ins = [...document.querySelectorAll('input[type=text],input[type=search],input:not([type])')].filter(vis);" +
  "const links = [...document.querySelectorAll('a[href]')].filter(vis);" +
  "const imgs = [...document.images];" +
  "const caps = [];" +
  "if (document.querySelector('.g-recaptcha,[data-sitekey],iframe[src*=recaptcha]')) caps.push('recaptcha');" +
  "if (document.querySelector('.h-captcha,iframe[src*=hcaptcha]')) caps.push('hcaptcha');" +
  "if (document.querySelector('.cf-turnstile,iframe[src*=turnstile],iframe[src*=challenges]')) caps.push('turnstile');" +
  "if (document.querySelector('#challenge-form,.challenge-form,#pow-captcha,[data-pow-captcha]')) caps.push('challenge-form');" +
  "const t = (document.body ? document.body.innerText : '');" +
  "return { title: document.title, els: document.querySelectorAll('*').length, links: links.length, buttons: btns.length, inputs: ins.length, imgs: imgs.length, imgsOk: imgs.filter(i => i.complete && i.naturalWidth > 0).length, textLen: t.length, bodyText: t.slice(0, 1500), url: location.href, caps };" +
  "})()";

const CAPTCHA_SEL = ".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*=recaptcha], iframe[src*=hcaptcha], iframe[src*=challenges], #challenge-form, .challenge-form";
const CONSENT_RE = /accept|agree|got it|allow all|i understand|consent|alle akzeptieren|tout accepter/i;

function parseErrPage(bodyText) {
  if (!bodyText || !/Could not load this page/.test(bodyText)) return null;
  const g = re => { const m = bodyText.match(re); return m ? m[1].trim() : ''; };
  return {
    reason: g(/Reason\s*\n([^\n]+)/i).slice(0, 220),
    category: g(/Category\s*\n([^\n]+)/i),
    status: g(/Status\s*\n([^\n]+)/i),
    trace: g(/Trace ID\s*\n([^\n]+)/i),
  };
}

function classify(r) {
  const bt = (r.bodyText || '').toLowerCase();
  if (r.errPage) return 'error-page';
  if (!r.loaded) return 'loadfail';
  if (!r.hasFrame) return 'no-frame';
  for (const m of BOTWALL) if (bt.includes(m.toLowerCase())) return r.captchaProviders.length ? 'botwall-captcha' : 'botwall';
  if (r.captchaProviders.length && r.els < 60) return 'captcha-gate';
  if (r.els < 8) return 'thin-or-error';
  if (r.els >= 40) return 'ok';
  return 'small-ok';
}

let server = null; let serverStarts = 0; let refusedStreak = 0;
function startServer() {
  const out = openSync(SRVLOG, 'a');
  server = spawn(BIN, ['--port', '6002', '--static', STATIC], { stdio: ['ignore', out, out] });
  server.on('exit', (c, s) => { if (c !== null && s !== 'SIGTERM' && s !== 'SIGKILL') appendFileSync(SRVLOG, '\n[w14] server exited code=' + c + '\n'); });
  serverStarts++;
}
async function waitHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const res = await fetch(ENGINE + '/sw.js', { signal: AbortSignal.timeout(1500) }); if (res.status < 500) return true; } catch {}
    await sleep(400);
  }
  return false;
}
async function restartServer() {
  try { server.kill('SIGKILL'); } catch {}
  await sleep(800);
  startServer();
  await waitHealth(15000);
}

/* Watchdogged evaluate: a wedged renderer answers null after ms. */
async function evT(target, expr, ms = EV_MS) {
  try { return await Promise.race([target.evaluate(expr), sleep(ms).then(() => null)]); } catch { return null; }
}

async function contentFrame(pg, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    for (const f of pg.frames()) {
      if (f.parentFrame() !== pg.mainFrame()) continue;
      try {
        const url = f.url();
        if (!url.includes('/j/') && !url.includes('__zl_navh__')) continue;
        const n = await evT(f, 'document.querySelectorAll(String.fromCharCode(42)).length', 5000);
        if (n !== null && n >= 8) return f;
      } catch {}
    }
    await sleep(400);
  }
  return null;
}

async function evalM(fr) { return evT(fr, METRICS); }

async function probe(ctx, site) {
  const r = { c: site.c, site: site.u, loaded: false, hasFrame: false, title: '', els: 0, links: 0, buttons: 0, inputs: 0, imgs: 0, imgsOk: 0, textLen: 0, consentDismissed: false, scrollOk: false, captchaProviders: [], captchaPressable: false, captchaPressed: false, captchaOutcome: '', typeOk: false, submitNavOk: false, afterSubmitUrl: '', clickOk: false, linkNavOk: false, afterLinkUrl: '', consoleErrs: 0, pageErrs: 0, errPage: null, bodyText: '', frameUrl: '', loadMs: 0, totalMs: 0 };
  const t0 = Date.now();
  const pg = await ctx.newPage();
  pg.on('dialog', async d => { try { await d.dismiss(); } catch {} });
  pg.on('popup', async p => { try { await p.close(); } catch {} });
  pg.on('console', m => { if (m.type() === 'error') r.consoleErrs++; });
  pg.on('pageerror', () => r.pageErrs++);
  try {
    try {
      await pg.goto(ENGINE + '/?url=' + encodeURIComponent(site.u), { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
      r.loaded = true;
    } catch (e) {
      r.err = String(e && e.message || e).slice(0, 200);
      if (/ERR_CONNECTION_REFUSED/.test(r.err)) refusedStreak++; else refusedStreak = 0;
      return r;
    }
    const fr = await contentFrame(pg, FRAME_WAIT_MS);
    r.loadMs = Date.now() - t0;
    if (!fr) { r.embedStatus = await evT(pg, '(() => { const el = document.getElementById(String.fromCharCode(122,108,45,115,116,97,116,117,115)); return el ? el.textContent : String(40,110,111,110,101,41); })()', 5000); r.topUrl = pg.url(); return r; }
    r.hasFrame = true;
    let m = null;
    const tw0 = Date.now();
    while (Date.now() - tw0 < SETTLE_MS) {
      m = await evalM(fr);
      if (m && ((m.els >= 15 && m.textLen > 100) || (m.title && m.els >= 8))) break;
      await sleep(500);
    }
    if (!m) m = await evalM(fr);
    if (!m) { r.probeErr = 'metrics unavailable'; return r; }
    Object.assign(r, { title: m.title, els: m.els, links: m.links, buttons: m.buttons, inputs: m.inputs, imgs: m.imgs, imgsOk: m.imgsOk, textLen: m.textLen, bodyText: m.bodyText });
    r.captchaProviders = m.caps;
    r.frameUrl = m.url;
    r.errPage = parseErrPage(m.bodyText);

    /* 0. consent/cookie overlay: honest click on the site own accept button */
    try {
      const cl = fr.locator('button:visible, [role=button]:visible').filter({ hasText: CONSENT_RE }).first();
      if (await cl.count()) {
        await cl.click({ timeout: 2500 });
        await sleep(900);
        const mm = await evalM(fr);
        if (mm) { m = mm; Object.assign(r, { title: mm.title, els: mm.els, links: mm.links, buttons: mm.buttons, inputs: mm.inputs, imgs: mm.imgs, imgsOk: mm.imgsOk, textLen: mm.textLen, bodyText: mm.bodyText }); }
        r.consentDismissed = true;
      }
    } catch {}

    /* 1. scroll round-trip: window, else largest scrollable container */
    try {
      await evT(fr, 'window.scrollBy(0, 1200)', 5000);
      r.scrollOk = (await evT(fr, 'window.scrollY', 5000)) > 50;
      if (!r.scrollOk) {
        r.scrollOk = !!(await evT(fr, "(() => { const els = [...document.querySelectorAll('div')].filter(e => e.scrollHeight > e.clientHeight + 300); els.sort((a, b) => b.scrollHeight - a.scrollHeight); if (els[0]) { els[0].scrollTop = 600; return els[0].scrollTop > 50; } return false; })()", 6000));
      }
      await evT(fr, 'window.scrollTo(0, 0)', 5000);
    } catch {}

    /* 2. captcha: one honest press on the visible widget, no solve logic */
    if (m.caps && m.caps.length) { try {
      const wloc = fr.locator(CAPTCHA_SEL).first();
      const bb = await wloc.boundingBox({ timeout: 3000 });
      if (bb) {
        r.captchaPressable = true;
        await pg.mouse.click(bb.x + 24, bb.y + bb.height / 2);
        await sleep(3000);
        r.captchaPressed = true;
        const after = await evalM(fr);
        if (after) r.captchaOutcome = (after.title || '') + ' | els:' + after.els + ' | ' + (after.caps.length ? 'caps-still-present' : 'caps-gone');
      }
    } catch {} }

    /* 3. search submit: type + Enter, watch the frame navigate */
    if (m.inputs > 0) { try {
      const loc = fr.locator('input[type=text],input[type=search],input:not([type])').first();
      try { await loc.click({ timeout: 3000 }); } catch { try { await loc.evaluate('el => el.focus()'); } catch {} }
      await pg.keyboard.type('hello world', { timeout: 2000 });
      const val = await loc.inputValue({ timeout: 2000 });
      r.typeOk = (val || '').length > 2;
      if (r.typeOk) {
        await pg.keyboard.press('Enter');
        await sleep(5000);
        const fr2 = await contentFrame(pg, 8000);
        const m2 = fr2 ? await evalM(fr2) : null;
        if (m2) {
          r.afterSubmitUrl = m2.url;
          r.submitNavOk = (m2.url !== m.url) || Math.abs(m2.els - m.els) > 30 || (m2.title || '') !== (m.title || '');
          if (m2.caps && m2.caps.length && !m.caps.length) r.captchaProviders = m2.caps;
        }
      }
    } catch {} }

    /* 4. button click (non-captcha surface) */
    try {
      const fr3 = await contentFrame(pg, 4000);
      if (fr3) { await fr3.locator('button:visible').first().click({ timeout: 3000 }); await sleep(900); r.clickOk = true; }
    } catch {}

    /* 5. link navigation */
    try {
      const fr4 = await contentFrame(pg, 4000);
      if (fr4) {
        const before = fr4.url();
        await fr4.locator('a[href]:visible').first().click({ timeout: 3000 });
        await sleep(6000);
        const fr5 = await contentFrame(pg, 8000);
        if (fr5) { r.afterLinkUrl = fr5.url(); r.linkNavOk = fr5.url() !== before; }
      }
    } catch {}
  } catch (e) { r.probeErr = String(e && e.message || e).slice(0, 150); }
  r.totalMs = Date.now() - t0;
  return r;
}

async function main() {
  startServer();
  if (!(await waitHealth(20000))) { console.error('server did not come up'); process.exit(1); }
  /* ZL_RESUME=1: keep existing OUT rows and skip sites already
     probed in them, so a killed crawl continues instead of
     restarting from zero. */
  const resume = process.env.ZL_RESUME === '1';
  const seen = new Set();
  if (resume) {
    try {
      for (const l of readFileSync(OUT, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const j = JSON.parse(l); if (j && j.site) seen.add(j.site); } catch {}
      }
    } catch {}
  } else {
    writeFileSync(OUT, '');
  }
  writeFileSync(PROG, '');
  let next = 0; const done = { n: 0 };
  const browsers = await Promise.all(Array.from({ length: WORKERS }, () => chromium.launch({ headless: true })));
  async function worker(browser) {
    for (;;) {
      const i = next++;
      if (i >= LIST.length) return;
      const site = LIST[i];
      if (resume && seen.has(site.u)) { done.n++; writeFileSync(PROG, JSON.stringify({ done: done.n, total: LIST.length, last: site.u, cls: 'skip', serverStarts, t: new Date().toISOString() })); continue; }
      let ctx;
      try { ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } }); } catch { return; }
      let r;
      try { r = await probe(ctx, site); } catch (e) { r = { c: site.c, site: site.u, loaded: false, harnessErr: String(e && e.message || e).slice(0, 150) }; }
      r.cls = classify(r);
      try { await ctx.close(); } catch {}
      appendFileSync(OUT, JSON.stringify(r) + '\n');
      done.n++;
      writeFileSync(PROG, JSON.stringify({ done: done.n, total: LIST.length, last: site.u, cls: r.cls, serverStarts, t: new Date().toISOString() }));
      if (refusedStreak >= 6) { await restartServer(); refusedStreak = 0; }
    }
  }
  await Promise.all(browsers.map(worker));
  for (const b of browsers) { try { await b.close(); } catch {} }
  try { server.kill('SIGTERM'); } catch {}
  /* summary */
  const rows = readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const cnt = {};
  for (const r of rows) cnt[r.cls] = (cnt[r.cls] || 0) + 1;
  const sum = {
    total: rows.length, serverStarts, classified: cnt,
    consentDismissed: rows.filter(r => r.consentDismissed).length,
    scrollOk: rows.filter(r => r.scrollOk).length,
    typeOk: rows.filter(r => r.typeOk).length,
    submitNavOk: rows.filter(r => r.submitNavOk).length,
    clickOk: rows.filter(r => r.clickOk).length,
    linkNavOk: rows.filter(r => r.linkNavOk).length,
    captchaSeen: rows.filter(r => r.captchaProviders && r.captchaProviders.length).length,
    captchaPressable: rows.filter(r => r.captchaPressable).length,
    captchaPressed: rows.filter(r => r.captchaPressed).length,
    captchaPassed: rows.filter(r => /caps-gone/.test(r.captchaOutcome || '')).length,
    errPages: rows.filter(r => r.errPage).map(r => ({ site: r.site, cat: r.errPage.category, reason: r.errPage.reason, trace: r.errPage.trace })),
    consoleClean: rows.filter(r => r.cls === 'ok' && r.consoleErrs === 0).length,
  };
  writeFileSync(OUT.replace(/\.jsonl$/, '') + '-summary.json', JSON.stringify(sum, null, 2));
  console.log(JSON.stringify(sum, null, 2));
}
main().catch(e => { console.error('FATAL', e); try { server && server.kill('SIGKILL'); } catch {} process.exit(1); });
