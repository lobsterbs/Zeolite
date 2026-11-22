/* #711 C0: event-loop lag sampler. A single setInterval probe: the
   gap between expected and actual tick is the loop stall time, the
   number the G1 gate needs (is rewrite CPU starving the SW loop
   while a heavy page streams?). Numbers only: nothing writes the
   diag ring on a timer, stats ride the zl:getDiag poll piggyback. */
const PERIOD = 200;
const CAP = 512;

let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
let ring: number[] = [];
let ewma = 0;

export function lagStatsFrom(samples: number[]): { n: number; p50: number; p95: number; p99: number; max: number; ewma: number } {
  const xs = [...samples].filter((x) => x >= 0).sort((a, b) => a - b);
  const pick = (p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
  let e = 0;
  for (const x of xs) e = e === 0 ? x : e * 0.9 + x * 0.1;
  return { n: xs.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: xs.length ? xs[xs.length - 1] : 0, ewma: Math.round(e) };
}

function tick() {
  const now = Date.now();
  if (last !== 0) {
    const lag = Math.max(0, now - last - PERIOD);
    ring.push(lag);
    if (ring.length > CAP) ring = ring.slice(-CAP);
  }
  last = now;
}

/* Idempotent: the SW top level starts it on every worker start, so
   the ring resets with the worker (generation covers the consumer). */
export function startLoopLag() {
  if (timer) return;
  ring = [];
  last = 0;
  ewma = 0;
  timer = setInterval(tick, PERIOD);
}

export function loopLagStats() {
  return lagStatsFrom(ring);
}
