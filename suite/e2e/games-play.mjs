/* Games-play e2e: actually PLAY games through the engine, not just
   load them. Each check drives real input (keyboard, mouse drag) and
   verifies the game state responded. Proven-stable checks ship:
   the original 2048 on GitHub Pages (arrow keys change tiles/score;
   play2048.co regressed upstream 2026-10-12: it now serves a shell
   with empty iframes whose game JS never mounts, even direct, no
   engine involvement) and lichess.org/editor (drag g2-g4 changes the
   FEN; Stockfish wasm runs in-page).
   Games whose failures are upstream bot walls are deliberately NOT
   asserted: cookieclicker (Cloudflare interstitial), skribbl.io (join
   assets 403 behind bot management), typeracer (race UI behind a
   challenge platform) -- honest upstream rejects, not engine defects
   (wave-16 evidence, issue #149).
   Lessons baked in: first paint through the tunnel can take 90s+
   (waitUntil commit, then poll for the board AND for the FEN input
   before dragging); chessground ignores click-click but accepts a
   real drag, identically direct and through the engine (always run a
   direct control before blaming the engine).
   Env style mirrors extension-runtime.mjs: ZL_ENGINE (default
   http://127.0.0.1:6010), ZL_BIN, ZL_STATIC (default ../../app/dist),
   ZL_OUT, ZL_SRVLOG. Run from a directory with playwright in
   node_modules. */
import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ENGINE = process.env.ZL_ENGINE ?? 'http://127.0.0.1:6010';
const BIN = process.env.ZL_BIN ?? 'zeolite-server';
const STATIC = process.env.ZL_STATIC ?? HERE + '../../app/dist';
const OUT = process.env.ZL_OUT ?? 'games-play-results.json';
const SRVLOG = process.env.ZL_SRVLOG ?? '/tmp/games-play-server.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(BIN, ['--port', new URL(ENGINE).port || '80', '--static', STATIC], {
  stdio: ['ignore', openSync(SRVLOG, 'a'), openSync(SRVLOG, 'a')],
});

async function waitHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(ENGINE + '/sw.js', { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
    console.log('[PASS] ' + name + ' | ' + (detail ?? ''));
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log('[FAIL] ' + name + ' | ' + String(err?.message ?? err));
  }
}

/* NAVH top-level navigation, the same flow the crawl and the
   extension-runtime harness use (game JS needs the top-level page,
   not an embed subframe). */
const browser = await chromium.launch({ headless: true });
async function play(dest) {
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  await host.goto(ENGINE + '/?url=' + encodeURIComponent(dest), { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 80; i++) {
    if (await host.evaluate('!!navigator.serviceWorker.controller').catch(() => false)) break;
    await sleep(500);
  }
  const h = await host.evaluate((d) => new Promise((res) => {
    const ch = new MessageChannel();
    const c = navigator.serviceWorker.controller;
    if (!c) return res({ ok: false, error: 'no controller' });
    ch.port1.onmessage = (e) => res(e.data);
    c.postMessage({ type: 'zl:navHandle', dest: d }, [ch.port2]);
    setTimeout(() => res({ ok: false, error: 'navHandle timeout' }), 20000);
  }), dest);
  await host.close();
  if (!h.ok) { await ctx.close(); throw new Error('navHandle: ' + JSON.stringify(h)); }
  const pg = await ctx.newPage();
  await pg.goto(ENGINE + h.url, { waitUntil: 'commit', timeout: 120000 });
  return { ctx, pg };
}

if (!(await waitHealth(20000))) {
  console.error('server dead: ' + ENGINE);
  process.exit(1);
}

await check('2048: arrow keys drive real game state', async () => {
  const { ctx, pg } = await play('https://gabrielecirulli.github.io/2048/');
  try {
    const snap = () => pg.evaluate(() => {
      const tiles = document.querySelectorAll('.tile').length;
      const sc = document.querySelector('.score-container');
      return tiles + '/' + (sc ? sc.textContent.trim() : '?');
    }).catch(() => '');
    let before = '';
    for (let i = 0; i < 60; i++) {
      before = await snap();
      if (before && !before.includes('?')) break;
      await sleep(1000);
    }
    if (!before || before.includes('?')) throw new Error('board never rendered: ' + JSON.stringify(before));
    await pg.locator('body').click({ position: { x: 200, y: 200 } }).catch(() => {});
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      await pg.keyboard.press(k);
      await sleep(300);
    }
    await sleep(1500);
    let after = '';
    for (let i = 0; i < 10; i++) {
      after = await snap();
      if (after && after !== before) break;
      await sleep(500);
    }
    if (!after || after === before) throw new Error('game state frozen: ' + JSON.stringify({ before, after }));
    return 'tiles/score ' + before + ' -> ' + after;
  } finally { await ctx.close(); }
});

await check('lichess editor: drag g2-g4 changes the FEN', async () => {
  const { ctx, pg } = await play('https://lichess.org/editor');
  try {
    const readFen = () => pg.evaluate(() => {
      const el = [...document.querySelectorAll('input,textarea')].find(i => /^[rnbqkpRNBQKP1-8/]+ [wb] /.test(i.value));
      return el ? el.value : '';
    }).catch(() => '');
    let board = false;
    for (let i = 0; i < 36; i++) {
      board = await pg.evaluate(() => !!document.querySelector('cg-board')).catch(() => false);
      if (board) break;
      await sleep(5000);
    }
    if (!board) throw new Error('board never rendered (goto through the tunnel can take 90s+)');
    /* the editor panel inputs mount after the board; wait for a FEN
       field before dragging so the oracle exists up front */
    let fen0 = '';
    for (let i = 0; i < 30; i++) {
      fen0 = await readFen();
      if (fen0) break;
      await sleep(4000);
    }
    if (!fen0) throw new Error('no FEN input found after board render');
    const pre = await pg.evaluate(() => {
      const b = document.querySelector('cg-board');
      const r = b.getBoundingClientRect();
      const sq = (f, rk) => ({ x: r.left + (f - 0.5) * (r.width / 8), y: r.top + (8 - rk + 0.5) * (r.height / 8) });
      const g2 = sq(7, 2), g4 = sq(7, 4);
      return { g2, g4, steps: [...Array(8)].map((_, i) => ({ x: g2.x + (g4.x - g2.x) * (i + 1) / 9, y: g2.y + (g4.y - g2.y) * (i + 1) / 9 })) };
    });
    await pg.mouse.move(pre.g2.x, pre.g2.y);
    await pg.mouse.down();
    for (const s of pre.steps) { await pg.mouse.move(s.x, s.y, { steps: 2 }); await sleep(60); }
    await pg.mouse.up();
    let fen1 = '';
    for (let i = 0; i < 15; i++) {
      fen1 = await readFen();
      if (fen1 && fen1 !== fen0) break;
      await sleep(2000);
    }
    if (!fen1) throw new Error('FEN input disappeared after drag');
    if (fen1 === fen0) throw new Error('drag did not move the pawn: ' + fen1);
    if (!fen1.startsWith('rnbqkbnr/pppppppp/8/8/6P1/8/PPPPPP1P/RNBQKBNR')) throw new Error('unexpected FEN after g2-g4: ' + fen1);
    return 'fen ' + fen1;
  } finally { await ctx.close(); }
});

const failed = results.filter(r => !r.ok).length;
writeFileSync(OUT, JSON.stringify({ engine: ENGINE, results, passed: results.length - failed, failed }, null, 2));
console.log(JSON.stringify({ passed: results.length - failed, failed }, null, 2));
await browser.close();
server.kill();
if (failed) process.exit(1);
