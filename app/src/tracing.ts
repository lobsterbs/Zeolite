/* Opt-in rewrite tracing (1.2 Halide). A bounded ring of per-decision
   records taken at every interception/rewrite/transport seam in the
   service worker. The enabled-flag gate comes first in every entry
   point: while tracing is off nothing is allocated and nothing is
   recorded. Enabled with a zl:tracing control message; polled with
   zl:getTracing using the same cursor protocol as the network log.
   Secrets are redacted before anything is stored.

   Known limit: token-level decisions inside the wasm rewriter are not
   surfaced; the traced seams are rules, intercept handlers, transport
   and the html/css rewrite boundaries. */

import { redactSecrets } from "./diag";

export interface TraceEntry {
  seq: number;
  ts: number;
  /** Seam that decided: rules | intercept | transport | rewriter. */
  subsystem: string;
  /** Matched rule, mode or label within the subsystem. */
  rule?: string;
  /** Value before the decision (URL or mode). */
  original: string;
  /** Value or outcome after. */
  result: string;
  /** Resource type at decision time, when known. */
  resource?: string;
  /** Diagnostics trace id, joinable with zl:getDiag events. */
  traceId?: string;
}

const LIMIT = 512;
const ring: TraceEntry[] = [];
let seq = 0;
let enabled = false;

export function tracingEnabled(): boolean {
  return enabled;
}

export function setTracing(on: boolean): void {
  enabled = on;
}

/** Record one decision. No-op (zero allocation) while tracing is off. */
export function traceDecision(d: Omit<TraceEntry, "seq" | "ts">): void {
  if (!enabled) return;
  ring.push({
    ...d,
    original: redactSecrets(d.original),
    result: redactSecrets(d.result),
    seq: ++seq,
    ts: Date.now(),
  });
  if (ring.length > LIMIT) ring.shift();
}

/** Snapshot for the zl:getTracing delta poll. */
export function tracingSnapshot(since: number): {
  entries: TraceEntry[];
  lastSeq: number;
  enabled: boolean;
} {
  return { entries: ring.filter((x) => x.seq > since), lastSeq: seq, enabled };
}

/** Test helper: clear the ring and reset the flag. */
export function tracingResetForTests(): void {
  ring.length = 0;
  seq = 0;
  enabled = false;
}
