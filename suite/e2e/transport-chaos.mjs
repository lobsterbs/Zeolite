/* transport-chaos: kill the wisp server mid-session, click an UNCACHED
   content link in the
   proxied frame, expect the honest error page; restart, Try again. */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { chromium } from 'playwright';
const ENGINE = process.env.ZL_ENGINE || 'http://127.0.0.1:6002';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server = null;
function startServer() { const out = openSync('/home/sprite/w14-chaos-server.log', 'a'); server = spawn(process.env.ZL_BIN || '/home/sprite/Zeolite/target/release/zeolite-server', ['--port', process.env.ZL_PORT || '6002', '--static', process.env.ZL_STATIC || '/home/sprite/w14static'], { stdio: ['ignore', out, out] }); return server.pid; }
async function waitHealth(ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const res = await fetch(ENGINE + '/sw.js', { signal: AbortSignal.timeout(1500) }); if (res.status < 500) return true; } catch {} await sleep(300); } return false; }
async function contentFrame(pg, budgetMs) { const t0 = Date.now(); while (Date.now() - t0 < budgetMs) { for (const f of pg.frames()) { if (f.parentFrame() !== pg.mainFrame()) continue; try { const url = f.url(); if (!url.includes('/j/') && !url.includes('__zl_navh__')) continue; const n = await f.evaluate('document.querySelectorAll(String.fromCharCode(42)).length'); if (n >= 8) return f; } catch {} } await sleep(400); } return null; }
async function frameText(fr) { try { return await fr.evaluate('(document.body ? document.body.innerText : String(0)).slice(0, 1400)'); } catch { return null; } }
async function main() {
  const pid = startServer();
  if (!(await waitHealth(15000))) { console.log(JSON.stringify({ fail: 'health' })); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const out = { steps: [] };
  const log = s => { out.steps.push(s); console.log(s); };
  await pg.goto(ENGINE + '/?url=' + encodeURIComponent('https://en.wikipedia.org/wiki/Eiffel_Tower'), { waitUntil: 'domcontentloaded', timeout: 25000 });
  const fr = await contentFrame(pg, 20000);
  out.firstLoad = !!fr;
  if (!fr) { console.log('RESULT ' + JSON.stringify(out)); process.exit(1); }
  await sleep(4000);
  /* pre-warm: remember which links are uncached (engine routes) */
  const hrefs = await fr.evaluate('(() => { const raw = [...document.querySelectorAll(String.fromCharCode(35) + String.fromCharCode(109,119,45,99,111,110,116,101,110,116,45,116,101,120,116) + String.fromCharCode(32) + String.fromCharCode(97))].filter(x => x.getAttribute(String.fromCharCode(104,114,101,102))).map(x => x.getAttribute(String.fromCharCode(104,114,101,102))).slice(5, 12); return raw.filter(h => h && h.includes(String.fromCharCode(47,106,47))); })()');
  log('candidate links: ' + hrefs.length);
  process.kill(pid, 'SIGKILL');
  log('server killed');
  await sleep(1000);
  try { const r = await fetch(ENGINE + '/sw.js', { signal: AbortSignal.timeout(2000) }); log('WARN server still answering: ' + r.status); } catch (e) { log('server confirmed down: ' + String(e && e.cause && e.cause.code || e).slice(0, 60)); }
  let errSeen = null;
  for (const h of hrefs.slice(0, 4)) {
    const frx = await contentFrame(pg, 4000);
    if (!frx) { log('frame gone, skip'); break; }
    const beforeUrl = frx.url().slice(-14);
    try { await frx.evaluate(hh => { location.href = hh; }, h); log('nav issued from ' + beforeUrl + ' to ' + h.slice(-14)); } catch (e) { log('nav err ' + String(e && e.message || e).slice(0, 80)); }
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await sleep(1500);
      const fr2 = await contentFrame(pg, 4000);
      const txt = fr2 ? await frameText(fr2) : null;
      const nowUrl = fr2 ? fr2.url().slice(-14) : '(none)';
      if (txt && /Could not load this page/.test(txt)) { errSeen = txt; log('ERROR PAGE SHOWN at ' + nowUrl); break; }
      if (nowUrl !== beforeUrl && txt && txt.length > 400) { log('page actually loaded at ' + nowUrl + ': ' + JSON.stringify(txt.slice(40, 110))); break; }
      if (nowUrl !== beforeUrl && txt && txt.length <= 400) { log('thin content at ' + nowUrl + ' len ' + txt.length); }
    }
    if (errSeen) break;
  }
  out.errorPageShown = !!errSeen;
  if (errSeen) {
    out.category = (errSeen.match(/Category\s*\n([^\n]+)/i) || [])[1] || '';
    out.reason = ((errSeen.match(/Reason\s*\n([^\n]+)/i) || [])[1] || '').trim().slice(0, 200);
    out.trace = (errSeen.match(/Trace ID\s*\n([^\n]+)/i) || [])[1] || '';
    out.destLeak = /wikipedia/i.test(errSeen);
  }
  const pid2 = startServer();
  await waitHealth(15000);
  log('server restarted');
  let recovered = false;
  if (errSeen) {
    const fr3 = await contentFrame(pg, 6000);
    if (fr3) {
      try {
        await fr3.locator('form button[type=submit]').first().click({ timeout: 6000 });
        log('try-again clicked');
        const t1 = Date.now();
        while (Date.now() - t1 < 30000) {
          await sleep(1500);
          const fr4 = await contentFrame(pg, 5000);
          const txt = fr4 ? await frameText(fr4) : null;
          if (txt && !/Could not load this page/.test(txt) && txt.length > 300) { recovered = true; out.recoverText = txt.slice(0, 80); break; }
        }
      } catch (e) { out.tryAgainErr = String(e && e.message || e).slice(0, 150); }
    } else out.tryAgainErr = 'error frame gone';
  }
  out.recoveredAfterTryAgain = recovered;
  await browser.close();
  try { process.kill(pid2, 'SIGTERM'); } catch {}
  console.log('RESULT ' + JSON.stringify(out));
}
main().catch(e => { console.error('FATAL', e); try { server && server.kill('SIGKILL'); } catch {} process.exit(1); });
