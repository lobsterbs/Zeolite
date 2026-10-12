/* Wisp relay byte-honestness probe (#149 follow-up): run a real
   OpenSSL TLS client (Node tls) over a raw wisp v1 relay socket against
   the same hosts a direct socket reaches, and compare. Proves whether
   the zeolite-server wisp relay (session termination + TCP relay loop)
   corrupts or drops bytes for specific upstreams, independently of the
   wasm TLS/h2 stacks the SW uses. Env style mirrors
   interaction-crawl.mjs: ZL_ENGINE, ZL_BIN, ZL_STATIC, ZL_OUT,
   ZL_SRVLOG, ZL_HOSTS (comma list). Needs no playwright; uses the
   global WebSocket (Node >= 22). */
import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';

const ENGINE = process.env.ZL_ENGINE ?? 'http://127.0.0.1:6020';
const BIN = process.env.ZL_BIN ?? 'zeolite-server';
const STATIC = process.env.ZL_STATIC ?? new URL('../../app/dist', import.meta.url).pathname;
const OUT = process.env.ZL_OUT ?? 'wisp-tls-probe-results.json';
const SRVLOG = process.env.ZL_SRVLOG ?? '/tmp/wisp-tls-probe-server.log';
const HOSTS = (process.env.ZL_HOSTS ?? 'cbc.ca,www.cbc.ca,united.com,delta.com,slither.io,opentable.com,acer.com,example.com').split(',');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(ENGINE.split(':').pop());
const server = spawn(BIN, ['--port', String(PORT), '--static', STATIC], { stdio: ['ignore', openSync(SRVLOG, 'a'), openSync(SRVLOG, 'a')] });
async function waitHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(ENGINE + '/sw.js', { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {}
    await sleep(300);
  }
  return false;
}
if (!(await waitHealth(20000))) { console.error('server ' + PORT + ' dead'); process.exit(1); }

const u32le = v => Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
const parseFrame = m => ({ type: m[0], streamId: m.readUInt32LE(1), payload: m.subarray(5) });

class WispConn {
  constructor() {
    this.ws = new WebSocket('ws://127.0.0.1:' + PORT + '/wisp/');
    this.ws.binaryType = 'arraybuffer';
    this.queue = [];
    this.waiters = [];
    this.onStream = null;
    this.ws.onmessage = e => {
      const f = parseFrame(Buffer.from(e.data));
      if (this.onStream) { this.onStream(f); return; }
      const w = this.waiters; this.waiters = [];
      if (w.length) w.forEach(r => r(f)); else this.queue.push(f);
    };
  }
  opened() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); }); }
  next(timeoutMs) {
    const p = this.queue.length ? Promise.resolve(this.queue.shift()) : new Promise(res => this.waiters.push(res));
    return Promise.race([p, sleep(timeoutMs).then(() => { throw new Error('frame timeout'); })]);
  }
  send(buf) { this.ws.send(buf); }
}

/* open a wisp v1 TCP stream to host:443, return a Duplex of the stream */
async function wispConnect(host, port, timeoutMs) {
  const c = new WispConn();
  await c.opened();
  let f = await c.next(timeoutMs);
  if (f.type !== 0x03 || f.streamId !== 0) throw new Error('expected CONTINUE(0), got ' + f.type + '/' + f.streamId);
  const hostBuf = Buffer.from(host, 'utf8');
  c.send(Buffer.concat([Buffer.from([0x01]), u32le(1), Buffer.from([0x01]), Buffer.from([port & 255, (port >> 8) & 255]), hostBuf]));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (Date.now() > deadline) throw new Error('connect timeout');
    f = await c.next(Math.max(200, deadline - Date.now()));
    if (f.type === 0x03 && f.streamId === 1) break;
    if (f.type === 0x04) throw new Error('wisp close reason ' + f.payload[0]);
  }
  const sock = new Duplex({
    write(chunk, enc, cb) { try { c.send(Buffer.concat([Buffer.from([0x02]), u32le(1), chunk])); cb(); } catch (e) { cb(e); } },
    final(cb) { try { c.send(Buffer.concat([Buffer.from([0x04]), u32le(1), Buffer.from([0x02])])); } catch {} cb(); },
    read() {},
  });
  c.onStream = f => {
    if (f.streamId !== 1) return;
    if (f.type === 0x02) sock.push(f.payload);
    else if (f.type === 0x04) sock.push(null);
  };
  return sock;
}

async function httpOverSocket(sock, host, path) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { try { sock.destroy(); } catch {} rej(new Error('http timeout')); }, 15000);
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n\r\n')) { clearTimeout(t); sock.destroy(); res(buf.split('\r\n\r\n')[0]); }
    });
    sock.on('error', e => { clearTimeout(t); rej(new Error('sock error: ' + e.message)); });
    sock.on('close', () => { clearTimeout(t); if (!buf.includes('\r\n\r\n')) rej(new Error('closed early, ' + buf.length + ' bytes')); });
    sock.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\nUser-Agent: wisp-tls-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n');
  });
}

async function probe(mode, host) {
  try {
    let sock;
    if (mode === 'direct') {
      sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true }, () => {});
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); setTimeout(() => rej(new Error('tls timeout')), 12000); });
    } else {
      const raw = await wispConnect(host, 443, 12000);
      sock = tls.connect({ socket: raw, servername: host, rejectUnauthorized: true }, () => {});
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); setTimeout(() => rej(new Error('tls timeout')), 12000); });
    }
    const head = await httpOverSocket(sock, host, '/robots.txt');
    return { ok: /^HTTP\/1\.[01] [1-5]/.test(head.split('\r\n')[0]), status: head.split('\r\n')[0] };
  } catch (e) { return { ok: false, error: String(e.message ?? e) }; }
}

const results = [];
for (const host of HOSTS) {
  const direct = await probe('direct', host);
  const wisp = await probe('wisp', host);
  results.push({ host, direct, wisp });
  console.log(host + ' direct=' + JSON.stringify(direct) + ' wisp=' + JSON.stringify(wisp));
}
server.kill();
writeFileSync(OUT, JSON.stringify(results, null, 2));
const mismatches = results.filter(r => r.direct.ok !== r.wisp.ok);
console.log('mismatches (tunnel not byte-honest for these): ' + JSON.stringify(mismatches.map(m => m.host)));
process.exit(mismatches.length ? 1 : 0);
