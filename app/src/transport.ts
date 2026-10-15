/// <reference lib="webworker" />
/* Upstream transport seam (issue #84): the Wisp-over-libcurl client
   lifecycle (initialization, connect-class reset + single retry,
   engine selection) lives here so sw.ts depends on the Transport
   interface, not the vendored implementation surface. One
   implementation exists (Wisp v2.1, pinned); the interface documents
   the seam, it does not invite a second backend (#84 non-goals).
   WebSocket opening and the live engine name are re-exported through
   the same seam; WS bridging stays in sw.ts (#88). */
import { DIAG } from "./diag";
import { loadEnter, loadLeave } from "./loadstate";
import { transportState, waitForTransportState } from "./transport-lifecycle";
import { ZL_WISP_URL } from "./config";
import {
  fetch as zlCurlFetch,
  init as zlCurlInit,
  isConnectClassError,
  reset as zlCurlReset,
  setEngine,
  currentEngine,
  openWebSocket,
  altFetch as zlAltFetch,
  altRegister,
  altConfigured,
  altReset as zlAltReset,
  type TransportEngine,
} from "./libcurl-transport-vendored";
import { relayAvailable, relayFetch } from "./relayfetch";

export { currentEngine, openWebSocket, altRegister, altConfigured, type TransportEngine };

/** Internal upstream transport contract (issue #84). */
export interface Transport {
  /** Proxied fetch. Connect-class failures reset the client and
      retry at most once (issue #74 behavior, preserved verbatim). */
  fetch(dest: string, init?: RequestInit): Promise<Response>;
  /** Initialize the client (idempotent); rejects on init failure and
      allows a retry on the next call. */
  ready(): Promise<void>;
  /** Engine selection for the next initialization (zl:transport
      switch: select + invalidate the initialized client). */
  switchEngine(engine: TransportEngine): void;
}

/** SW-state seam (issue #84): the degraded flag stays in sw.ts
    (zl:ping reads it). Wired once by sw.ts at module eval. */
export function initTransport(deps: { setDegraded: (reason: string) => void }): void {
  setDegradedImpl = deps.setDegraded;
}

let setDegradedImpl: (reason: string) => void = () => {};

let curlReady: Promise<void> | null = null;
async function ensureCurl(): Promise<void> {
  if (!curlReady) {
    curlReady = zlCurlInit({ websocket: ZL_WISP_URL }).catch((err) => {
      setDegradedImpl("libcurl transport: " + String(err));
      curlReady = null; // allow retry on next request
      DIAG.emit({
        category: "TRANSPORT",
        severity: "error",
        message: "libcurl transport init failed",
        technicalReason: String(err),
        url: ZL_WISP_URL,
      });
      throw err;
    });
  }
  return curlReady;
}

/* Issue #74: a dead or never-opened wisp websocket is transport state,
   not a per-destination failure. Connect-class errors (libcurl error 55
   send / 56 receive on the dead socket, "websocket did not open" from
   either engine; error 52 is the #104 stale-connection empty reply,
   where an upstream that closed a pooled connection answers the
   reuse with nothing - the reset drops the connection cache so the
   one retry rides a fresh connection) reset the transport singleton
   and retry once before the 502 page reaches the user. #155: request.ts buffers a stream body once at its upstreamFetch
   choke point before it reaches here, so the retry replays a buffered
   body instead of dying on an already-consumed stream; each wispFetch
   call still retries at most once. */

/* Issue #99 class: the vendored request promise resolves when headers
   arrive, so a request that stalls before the first byte (a silently
   dropped wisp websocket, the class behind #99's mid-stream stalls
   and hanging subresources) never settles and the page spinner runs
   forever. Every fetch - navigation or subresource - now carries a
   first-byte deadline (same 30s budget as request.ts navigations). A
   stall is transport state exactly like a connect-class error: reset
   the singleton, retry once on a fresh connection, then fail
   honestly. Local copy of request.ts's withDeadline: transport.ts is
   imported by request.ts, importing back would close a module cycle.
   The abandoned fetch keeps running after the deadline fires; its
   answer is dropped, never served. */
let WISP_TTFB_DEADLINE_MS = 30_000;

/* 2026-10-11 YouTube-class stall storm (user diag): one wedged wisp
   socket makes every in-flight request eat the full 30s TTFB
   deadline, and each one resets and retries the same singleton, so a
   media-heavy page hangs in a reset storm instead of failing fast.
   After STALL_THRESHOLD stalls within STALL_WINDOW_MS the transport
   enters a cooldown: requests ride the embedder relay first when a
   channel is registered (#137) and otherwise still try wisp (a
   standalone embed has no relay; hard-failing would break it for the
   whole window). Any first-byte success clears the window and the
   cooldown: one delivered answer is evidence the socket is healthy
   again. The cooldown expires on its own. */
const STALL_WINDOW_MS = 60_000;
const STALL_THRESHOLD = 3;
const COOLDOWN_MS = 60_000;
const stallTimes: number[] = [];
let cooldownUntil = 0;

function transportCooling(): boolean {
  return Date.now() < cooldownUntil;
}

function recordStall(): void {
  const now = Date.now();
  stallTimes.push(now);
  while (stallTimes.length > 0 && now - stallTimes[0] > STALL_WINDOW_MS) stallTimes.shift();
  if (stallTimes.length >= STALL_THRESHOLD && now >= cooldownUntil) {
    cooldownUntil = now + COOLDOWN_MS;
    DIAG.emit({
      category: "TRANSPORT",
      severity: "warning",
      message:
        "wisp stall storm: " +
        stallTimes.length +
        " stalls within " +
        STALL_WINDOW_MS / 1000 +
        "s; relay-first cooldown for " +
        COOLDOWN_MS / 1000 +
        "s",
      url: ZL_WISP_URL,
    });
  }
}

function stallClear(): void {
  stallTimes.length = 0;
  cooldownUntil = 0;
}

/* Test hooks: the deadline is the production value, tests shrink it
   and reset the storm state between cases. */
export function transportResetForTests(deadlineMs: number): void {
  WISP_TTFB_DEADLINE_MS = deadlineMs;
  stallTimes.length = 0;
  cooldownUntil = 0;
}

export function wispCoolingForTests(): boolean {
  return transportCooling();
}

/* #119: how long a request that arrives while the transport is
   known-dead waits for the reconnect before proceeding on the
   normal path. Bounded: a timeout is not an error, ensureCurl()
   below still runs and fails honestly if the transport is gone. */
const WAIT_FOR_RECONNECT_MS = 10_000;

class WispStallError extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new WispStallError("wisp transport stall: no first byte within " + ms + "ms")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

async function wispFetch(dest: string, init?: RequestInit): Promise<Response> {
  /* Loading-indicator accounting (zl:loadState): the transport seam
     is the one place every upstream request passes through, so the
     in-flight counter rides it; the finally covers every settle
     path (success, honest failure, retry). */
  loadEnter(dest);
  try {
    /* Stall-storm cooldown: prefer the embedder relay while the wisp
       socket is known to wedge; without a channel (or for a body the
       relay cannot carry) fall through to the wisp path honestly. */
    if (transportCooling() && relayAvailable()) {
      const relayInit = {
        method: init?.method ?? "GET",
        headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers),
        body: init?.body as string | ArrayBuffer | null | undefined,
        signal: init?.signal ?? undefined,
      };
      const rr = await relayFetch(dest, relayInit, "");
      if (rr) return rr;
      DIAG.emit({
        category: "TRANSPORT",
        severity: "info",
        message: "cooldown relay could not carry this request; trying wisp",
        url: dest,
      });
    }
    /* #119: the lifecycle machine (not the dead-but-present client)
       owns the answer to whether the transport is alive. A request
       landing in the dead window waits for the reconnect instead of
       racing it. */
    if (transportState() === "dead") {
      await waitForTransportState("connected", WAIT_FOR_RECONNECT_MS);
    }
    await ensureCurl();
    try {
      const resp = await withDeadline(zlCurlFetch(dest, init), WISP_TTFB_DEADLINE_MS);
      /* A first-byte success is evidence the socket is healthy:
         clear the storm window and any cooldown. */
      stallClear();
      return resp;
    } catch (err) {
      if (!isConnectClassError(err) && !(err instanceof WispStallError)) throw err;
      if (err instanceof WispStallError) recordStall();
      DIAG.emit({
        category: "TRANSPORT",
        severity: "error",
        message:
          err instanceof WispStallError
            ? "transport stall: no first byte within " + WISP_TTFB_DEADLINE_MS + "ms; reset, retrying once"
            : "transport failure; reset, retrying once on a fresh connection",
        technicalReason: String(err),
        url: ZL_WISP_URL,
      });
      zlCurlReset();
      curlReady = null; // force re-init inside the next ensureCurl()
      await ensureCurl();
      return withDeadline(zlCurlFetch(dest, init), WISP_TTFB_DEADLINE_MS);
    }
  } finally {
    loadLeave(dest);
  }
}

export const wispTransport: Transport = {
  fetch: wispFetch,
  ready: ensureCurl,
  switchEngine(engine) {
    setEngine(engine);
    curlReady = null; // force re-init inside the next ensureCurl()
  },
};

/* #168: policy route "wisp". Mirrors the primary wispFetch contract:
   first-byte deadline, connect-class reset + single retry, loading
   accounting. Deliberately no stall-storm cooldown (that state
   tracks the primary endpoint's health) and no lifecycle machine
   (transport-lifecycle owns the primary only). */
export async function altWispFetch(dest: string, init?: RequestInit): Promise<Response> {
  loadEnter(dest);
  try {
    try {
      return await withDeadline(zlAltFetch(dest, init), WISP_TTFB_DEADLINE_MS);
    } catch (err) {
      if (!isConnectClassError(err) && !(err instanceof WispStallError)) throw err;
      DIAG.emit({
        category: "TRANSPORT",
        severity: "error",
        message:
          err instanceof WispStallError
            ? "wisp-route transport stall: no first byte within " + WISP_TTFB_DEADLINE_MS + "ms; reset, retrying once"
            : "wisp-route transport failure; reset, retrying once on a fresh connection",
        technicalReason: String(err),
        url: dest,
      });
      zlAltReset();
      return withDeadline(zlAltFetch(dest, init), WISP_TTFB_DEADLINE_MS);
    }
  } finally {
    loadLeave(dest);
  }
}
