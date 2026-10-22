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
import {
  normalizeWispUrl,
  primaryWispOverrideValue,
  primaryWispUrl,
  setPrimaryWispOverride,
} from "./config";
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
  altEndpoint,
  altReset as zlAltReset,
  type TransportEngine,
} from "./libcurl-transport-vendored";
import { relayAvailable, relayFetch } from "./relayfetch";

export { currentEngine, openWebSocket, altRegister, altConfigured, altEndpoint, type TransportEngine };

/** Internal upstream transport contract (issue #84). */
export interface Transport {
  /** Proxied fetch. Connect-class failures reset the client and
      retry at most once (issue #74 behavior, preserved verbatim). */
  fetch(dest: string, init?: RequestInit, traceId?: string): Promise<Response>;
  /* #226: traceId is diagnostic correlation for cooldown relay
     failures; absent means unattributed, never a crash. */
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

/* LobsterBrowse Settings: the embedder picks the primary wisp endpoint
   at runtime. "" restores the build-time endpoint. Returns false for an
   invalid non-empty URL (nothing changes). A real change drops the live
   libcurl client so the next request re-initializes on the new URL. */
export function setPrimaryWisp(url: string): boolean {
  const next = url === "" ? null : normalizeWispUrl(url);
  if (url !== "" && next === null) return false;
  if (next === primaryWispOverrideValue()) return true;
  setPrimaryWispOverride(next);
  curlReady = null;
  zlCurlReset();
  return true;
}

/* #390: the zl:transport choice must survive an idle worker restart.
   controllerchange never fires for an instance restart, so the
   embedder cannot re-send its toggle; without persistence the UI
   shows epoxy while the engine silently runs the deployment default.
   Same Cache API pattern as the route-shape restore; a write failure
   keeps the choice for this worker lifetime only. */
const ENGINE_CACHE = "zeolite-engine-v1";
const engineOrigin = (): string =>
  typeof self !== "undefined" && self.location ? self.location.origin : "http://zeolite.test";
let engineReadyPromise: Promise<void> | null = null;

/** Restore the persisted engine choice once per worker instance;
    safe to call from any seam, never throws. */
export function engineReady(): Promise<void> {
  if (!engineReadyPromise) {
    engineReadyPromise = (async () => {
      try {
        const hit = await (
          await caches.open(ENGINE_CACHE)
        ).match(new Request(engineOrigin() + "/zl-engine-choice"));
        const eng = hit ? await hit.text() : "";
        if (eng === "libcurl" || eng === "epoxy") setEngine(eng);
      } catch {
        /* storage unavailable: the deployment default stays */
      }
    })();
  }
  return engineReadyPromise;
}

async function persistEngine(engine: TransportEngine): Promise<void> {
  try {
    await (
      await caches.open(ENGINE_CACHE)
    ).put(new Request(engineOrigin() + "/zl-engine-choice"), new Response(engine));
  } catch {
    /* storage unavailable: the choice lives for this worker lifetime */
  }
}

let curlReady: Promise<void> | null = null;
async function ensureCurl(): Promise<void> {
  await engineReady(); // #390: replay the persisted choice before the first init
  if (!curlReady) {
    curlReady = zlCurlInit({ websocket: primaryWispUrl() }).catch((err) => {
      setDegradedImpl("libcurl transport: " + String(err));
      curlReady = null; // allow retry on next request
      DIAG.emit({
        category: "TRANSPORT",
        severity: "error",
        message: "libcurl transport init failed",
        technicalReason: String(err),
        url: primaryWispUrl(),
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
   honestly. #255: the deadline aborts the abandoned upstream fetch,
   so its answer is neither transferred nor served. */
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
      url: primaryWispUrl(),
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

/* #251: the automatic reset+retry only rides methods that are safe
   to send twice, and only bodies that can be replayed after a
   reset. A non-idempotent method or a one-shot (stream) body fails
   honestly on the first error instead of the retry duplicating a
   side effect or dying on an already-consumed stream.
   "websocket did not open" fails before the request is ever sent,
   so it is retryable for any method (pre-send is the one safe
   class). request.ts buffers stream bodies once at its
   upstreamFetch choke point (#155), so real traffic arrives here
   replayable; a bare stream means a caller that bypassed that
   seam. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);

function bodyReplayable(init?: RequestInit): boolean {
  const b = init?.body;
  if (b == null || typeof b === "string" || b instanceof URLSearchParams) return true;
  if (b instanceof ArrayBuffer || b instanceof Blob || ArrayBuffer.isView(b)) return true;
  return false; /* ReadableStream and anything else one-shot */
}

function retryable(init: RequestInit | undefined, err: unknown): boolean {
  if (!bodyReplayable(init)) return false;
  if (/websocket did not open/i.test(String(err))) return true;
  return IDEMPOTENT_METHODS.has((init?.method ?? "GET").toUpperCase());
}

/* #255: the deadline still races the fetch promise (a transport
   that ignores its abort signal must still fail on time), and
   additionally aborts the abandoned upstream fetch through the
   signal the vendored request accepts, so a stalled transfer stops
   consuming the socket instead of running to completion with its
   answer dropped. The caller's signal is composed in: a caller
   abort stays an honest AbortError, only the deadline surfaces as
   a stall. Replaces the old promise-race withDeadline, which left
   the abandoned fetch running. */
async function fetchWithDeadline(
  fetcher: (dest: string, init?: RequestInit) => Promise<Response>,
  dest: string,
  init: RequestInit | undefined,
): Promise<Response> {
  const ms = WISP_TTFB_DEADLINE_MS;
  const ctl = new AbortController();
  const forward = () => ctl.abort();
  init?.signal?.addEventListener("abort", forward, { once: true });
  if (init?.signal?.aborted) ctl.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Response>((resolve, reject) => {
      timer = setTimeout(() => {
        ctl.abort(); /* cancel the abandoned upstream fetch */
        reject(new WispStallError("wisp transport stall: no first byte within " + ms + "ms"));
      }, ms);
      fetcher(dest, { ...init, signal: ctl.signal }).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    init?.signal?.removeEventListener("abort", forward);
  }
}

async function wispFetch(dest: string, init?: RequestInit, traceId?: string): Promise<Response> {
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
      /* #261: relayFetch deliberately has no clock of its own, so
         the first-byte deadline is applied HERE: an embedder that
         never answers must not hang the request, and the abort
         cancels the embedder's upstream fetch (zl:relayCancel)
         instead of streaming an answer nobody waits for. A
         caller abort stays an honest AbortError; only the
         deadline surfaces as a stall. */
      const ctl = new AbortController();
      const relayTimer = setTimeout(() => ctl.abort(), WISP_TTFB_DEADLINE_MS);
      const forward = () => ctl.abort();
      init?.signal?.addEventListener("abort", forward, { once: true });
      if (init?.signal?.aborted) ctl.abort();
      const relayInit = {
        method: init?.method ?? "GET",
        headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers),
        body: init?.body as string | ArrayBuffer | null | undefined,
        signal: ctl.signal,
      };
      try {
        const rr = await relayFetch(dest, relayInit, traceId ?? "");
        if (rr) return rr;
        DIAG.emit({
          category: "TRANSPORT",
          severity: "info",
          message: "cooldown relay could not carry this request; trying wisp",
          url: dest,
        });
      } catch (err) {
        if (init?.signal?.aborted) throw err;
        /* #400: a stall on the relay arm counts for the storm detector
           too. Without this, stalls seen while the cooldown was active
           never refreshed the window, so a wedged relay looked
           healthy the moment the cooldown expired. */
        recordStall();
        throw new WispStallError(
          "relay transport stall: no first byte within " +
            WISP_TTFB_DEADLINE_MS +
            "ms",
        );
      } finally {
        clearTimeout(relayTimer);
        init?.signal?.removeEventListener("abort", forward);
      }
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
      const resp = await fetchWithDeadline(zlCurlFetch, dest, init);
      /* A first-byte success is evidence the socket is healthy:
         clear the storm window and any cooldown. */
      stallClear();
      return resp;
    } catch (err) {
      if (!isConnectClassError(err) && !(err instanceof WispStallError)) throw err;
      /* #251: a non-idempotent method or a one-shot body must not
         ride the reset+retry: the side effect may already have
         happened upstream. Record the stall for the storm detector
         and fail honestly. */
      if (!retryable(init, err)) {
        if (err instanceof WispStallError) recordStall();
        DIAG.emit({
          category: "TRANSPORT",
          severity: "warning",
          message: "transport failure not retried: non-idempotent method or one-shot body",
          technicalReason: String(err),
          url: dest,
        });
        throw err;
      }
      if (err instanceof WispStallError) recordStall();
      DIAG.emit({
        category: "TRANSPORT",
        severity: "error",
        message:
          err instanceof WispStallError
            ? "transport stall: no first byte within " + WISP_TTFB_DEADLINE_MS + "ms; reset, retrying once"
            : "transport failure; reset, retrying once on a fresh connection",
        technicalReason: String(err),
        url: primaryWispUrl(),
      });
      zlCurlReset();
      curlReady = null; // force re-init inside the next ensureCurl()
      await ensureCurl();
      try {
        return await fetchWithDeadline(zlCurlFetch, dest, init);
      } catch (err2) {
        /* #226: a stall on the fresh connection is the strongest
           evidence the socket is wedged; count it before rethrowing
           so the storm detector does not undercount. */
        if (err2 instanceof WispStallError) recordStall();
        throw err2;
      }
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
    void persistEngine(engine); // #390: survive the next idle restart
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
      return await fetchWithDeadline(zlAltFetch, dest, init);
    } catch (err) {
      if (!isConnectClassError(err) && !(err instanceof WispStallError)) throw err;
      /* #251: same retry-safety gate as the primary path */
      if (!retryable(init, err)) {
        DIAG.emit({
          category: "TRANSPORT",
          severity: "warning",
          message: "wisp-route failure not retried: non-idempotent method or one-shot body",
          technicalReason: String(err),
          url: dest,
        });
        throw err;
      }
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
      return fetchWithDeadline(zlAltFetch, dest, init);
    }
  } finally {
    loadLeave(dest);
  }
}
