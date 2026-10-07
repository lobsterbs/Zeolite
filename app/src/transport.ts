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
import { ZL_WISP_URL } from "./config";
import {
  fetch as zlCurlFetch,
  init as zlCurlInit,
  isConnectClassError,
  reset as zlCurlReset,
  setEngine,
  currentEngine,
  openWebSocket,
  type TransportEngine,
} from "./libcurl-transport-vendored";

export { currentEngine, openWebSocket, type TransportEngine };

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
   and retry once before the 502 page reaches the user. A request whose body stream was already
   consumed may fail the retry and surface as before: honest fallback,
   never a loop - each wispFetch call retries at most once. */
async function wispFetch(dest: string, init?: RequestInit): Promise<Response> {
  await ensureCurl();
  try {
    return await zlCurlFetch(dest, init);
  } catch (err) {
    if (!isConnectClassError(err)) throw err;
    DIAG.emit({
      category: "TRANSPORT",
      severity: "error",
      message: "transport failure; reset, retrying once on a fresh connection",
      technicalReason: String(err),
      url: ZL_WISP_URL,
    });
    zlCurlReset();
    curlReady = null; // force re-init inside the next ensureCurl()
    await ensureCurl();
    return zlCurlFetch(dest, init);
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
