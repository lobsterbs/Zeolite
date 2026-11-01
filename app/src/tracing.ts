/* Opt-in rewrite tracing (1.2 Halide). A bounded ring of per-decision
   records taken at every interception/rewrite/transport seam in the
   service worker. The enabled-flag gate comes first in every entry
   point: while tracing is off nothing is allocated and nothing is
   recorded. Enabled with a zl:tracing control message; polled with
   zl:getTracing using the same cursor protocol as the network log.
   Secrets are redacted before anything is stored.

   #529: token-level decisions inside the wasm rewriter surface
   through the same opt-in: rewriteStream enables the per-instance
   wasm trace (set_trace) and drains the aggregated fixed-vocabulary
   (pass, decision, count) pairs into this ring at stream end - no
   source text, URL or host ever enters a trace entry. Standalone CSS
   streams and one-shot JS bodies stay untraced (documented residual
   in docs/tracing.md). */

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
/** A host-selected adaptive shadow may emit its fixed-vocabulary
    comparison even when full, URL-bearing tracing is disabled. */
export function traceDecision(d: Omit<TraceEntry, "seq" | "ts">, shadow = false): void {
  if (!enabled && !shadow) return;
  /* Forced shadow observations must not enable arbitrary URL-bearing
     tracing. Accept only exact engine-owned planner enumerations. */
  if (shadow) {
    if (d.subsystem !== "transport" || d.rule !== "adaptive-shadow" ||
        !/^(NativeTransit|RewriteFallback|Blocked)$/.test(d.original) ||
        !/^(native|light|full|required|blocked):(default|request-destination|response-content-type|manual-policy|challenge-namespace)$/.test(d.result)) return;
    d = { subsystem: "transport", rule: "adaptive-shadow",
      original: d.original, result: d.result,
      traceId: typeof d.traceId === "string" && /^zl-t[a-z0-9]+-[a-z0-9]+$/.test(d.traceId)
        ? d.traceId : undefined };
  }
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
