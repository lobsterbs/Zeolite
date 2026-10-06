/* Network inspector log (Phase 4), extracted from sw.ts (issue #89:
  modularize sw.ts - isolate observability). This module owns the
  bounded request ring, the per-entry redaction helper and the
  generation stamp that lets a devtools client detect a worker
  restart. It records only; it never changes request behavior, and
  secrets are redacted before anything is stored (redactSecrets on
  entry). sw.ts and the extracted request engine / control plane are
  call sites. */

import { redactSecrets } from "./diag";

/* ---- Network inspector log (Phase 4) -------------------------------- */
/* Fixed-size ring buffer of proxied requests. The devtools page polls
   zl:getNetLog; a snapshot plus a monotonically increasing sequence
   lets it drop entries it has already seen. */

export interface NetEntry {
  seq: number;
  ts: number;
  method: string;
  /** Engine-local request path (the full URL for foreign-origin
      requests the engine routes, #34). */
  path: string;
  /** Real destination URL. */
  dest: string;
  status: number;
  /** Time until response headers (TTFB through the wisp hop), ms. */
  ms: number;
  /** Response body size: content-length when present, else -1. */
  bytes: number;
  /** Plugin verdict from the onRequest hooks, when any plugin ran. */
  verdict?: string;
  /** Resource type classification (DOCUMENT/SCRIPT/STYLE/...). fetch()
      and XHR are not distinguishable without initiator info, so both
      are reported as FETCH rather than guessed apart. */
  rtype: string;
  /** Rewrite applied to this response, when any: "html" | "css". */
  rewritten?: string;
  err?: string;
  /** Diagnostics trace identifier, joinable with zl:getDiag events. */
  traceId?: string;
  /** Transport mode decision (NativeTransit Alpha / RewriteFallback), or
      "browser" for a cross-origin passthrough the engine declines
      (issue #30: escape telemetry, not proxied traffic), or "engine"
      for an engine-answered request that never touched the transport
      (the #34 CORS preflight). */
  transport?: "NativeTransit" | "RewriteFallback" | "browser" | "engine";
  /** Machine-readable reason when the decision was RewriteFallback. */
  fallbackReason?: string;
  /** Final destination after redirects, when the transport exposed it. */
  finalDest?: string;
  /** Inspector detail record (1.2 Halide), for the detail view. */
  detail?: NetDetail;
}

/** Per-request inspector detail (1.2 Halide): the original target
    URL lives in the entry itself; this adds the internal engine URL,
    timing, initiator and redacted header/cookie records. Values of
    secrets are never stored (redactSecrets on entry). */
export interface NetDetail {
  /** Internal engine URL as the browser requested it (path + query). */
  internalUrl: string;
  /** Time until response headers, ms. */
  ttfb: number;
  /** Destination of the controlling page, when the SW can resolve it. */
  initiator?: string;
  /** Redacted request headers. */
  reqHeaders?: Record<string, string>;
  /** Redacted response headers, when a response was produced. */
  respHeaders?: Record<string, string>;
  /** Set-Cookie names seen on the response (values never stored). */
  cookies?: string[];
  /** True when the request arrived on a foreign origin and the engine
      routed it through the transport instead of letting the browser
      go direct (issue #34). */
  crossOrigin?: boolean;
}

export const NET_LIMIT = 256;
export const netLog: NetEntry[] = [];
let netSeq = 0;

export function netLogPush(entry: Omit<NetEntry, "seq" | "ts">): void {
  netLog.push({ ...entry, seq: ++netSeq, ts: Date.now() });
  if (netLog.length > NET_LIMIT) netLog.shift();
}

/** Flatten headers into a redacted record for the inspector detail.
    Secret-bearing header names redact the whole value (#95: cookie and
    authorization values are never stored even when the value itself
    contains no keyword for redactSecrets to catch); every other value
    runs through redactSecrets as before. */
export function flatRed(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    const name = k.toLowerCase();
    if (name === "cookie" || name === "authorization" || name === "proxy-authorization" || name === "set-cookie") {
      out[k] = "[redacted]";
      return;
    }
    out[k] = redactSecrets(v);
  });
  return out;
}

/* NetLog generation is an epoch stamped per worker evaluation, not a
   count from zero: a restarted worker used to come back with
   generation 1 again, so a devtools that reconnected after a restart
   could see an unchanged generation and skip the ring reset its
   entries+cursor needed. sw.ts stamps it once per worker start. */
let netGeneration = Date.now();

/** Stamp a fresh generation (once per worker evaluation, at init). */
export function stampNetGeneration(): void {
  netGeneration = Date.now();
}

/** Current generation, for delta-poll replies (zl:getNetLog/zl:getTracing). */
export function netLogGeneration(): number {
  return netGeneration;
}

/** Entries with seq strictly greater than the cursor (delta poll /
    recording slices share this). */
export function netLogSince(since: number): NetEntry[] {
  return netLog.filter((x) => x.seq > since);
}

/** Current ring cursor (zl:recordStart captures it). */
export function netLogCursor(): number {
  return netSeq;
}
