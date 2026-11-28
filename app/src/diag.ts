/* Structured proxy diagnostics: bounded event ring + trace index.
   Phase 1 of the diagnostics foundation. Every significant interception
   step (and every failure) is recorded as a DiagEvent carrying a
   category, severity, lifecycle stage, and cause classification. Events
   share traceIds with the network log entries, so the devtools UI can
   join a request with its full lifecycle. Memory is bounded: 512
   events, 256 trace references. Secrets (authorization headers, cookie
   values, bearer tokens) are redacted before anything is stored.

   #95: the request engine tracks the lifecycle stage a request is in
   and failure events name that stage; classifyStageFailure maps the
   stage to the honest category/cause (a rewrite failure is not an
   upstream failure). A transit decision that leaves the native path is
   an explainable TRANSPORT_FALLBACK stage event; native is the
   default and stays row/counter-only. */

export type DiagSeverity = "info" | "warning" | "error" | "critical";

export type DiagCategory =
  | "TRANSPORT"
  | "UPSTREAM"
  | "REWRITE"
  | "RUNTIME"
  | "NAVIGATION"
  | "STORAGE"
  | "WEBSOCKET"
  | "SERVICE_WORKER"
  | "CORS"
  | "CSP"
  | "COOKIE"
  | "EXTENSION"
  | "BROWSER_API"
  | "PARSER"
  | "TIMEOUT"
  | "BLOCKED"
  | "CHALLENGE"
  | "UNSUPPORTED"
  | "UNKNOWN";

/** Why the event happened; "unknown" means instrumentation genuinely
    could not establish a cause. Never guess a more specific cause. */
export type DiagCause =
  | "failure"
  | "unsupported"
  | "blocked"
  | "upstream"
  | "proxy"
  | "rewrite"
  | "browser_limit"
  | "extension"
  | "challenge"
  | "unknown";

/** Lifecycle stages a resource or navigation can pass through. Not
    every resource uses every stage; only record what actually
    happened. */
export type DiagStage =
  | "REQUEST_CREATED"
  | "REQUEST_INTERCEPTED"
  | "UPSTREAM_REQUEST"
  | "UPSTREAM_RESPONSE"
  | "RESPONSE_RECEIVED"
  | "REWRITE_STARTED"
  | "REWRITE_COMPLETED"
  | "REWRITE_FAILED"
  | "RUNTIME_INJECTION"
  | "SCRIPT_EXECUTION"
  | "DOWNSTREAM_REQUEST"
  | "TRANSPORT_FALLBACK"
  | "REDIRECT_HOP"
  | "REDIRECTED"
  | "PINNED_SCRIPT"
  | "ADAPTIVE_RECOVERY"
  /* #456: an over-cap script/worker body serves verbatim (the
     buffering bound); informational, never a failure point. */
  | "RAW_BODY_CAP"
  /* #664: websocket bridge lifecycle stages, emitted by the bridge and
     the relay factory themselves. Bounded to at most one event per
     stage per connection on top of the ring bound; a normal close is
     WS_CLOSE at info severity, never a failure. */
  | "WS_OPEN"
  | "WS_CLOSE"
  | "WS_ERROR"
  /* #685 follow-up: a cf-mitigated challenge document had its inline cZone
     literal relabeled to location.hostname so the orchestrator's
     hostname===cZone gate passes on the opaque /j/ realm. Informational,
     never a failure point. */
  | "CHALLENGE_ZONE_RELABEL"
  /* #694: the verbatim challenge serve spliced the storage-firewall
     prelude (engine-own zl- and zeolite- prefixed names denied in the
     doc realm). Informational, never a failure point. */
  | "CHALLENGE_FIREWALL";

export type DiagDeliveryState =
  | "definitely-not-delivered"
  | "delivered-response"
  | "delivery-unknown";
export type DiagDeliveryTransport = "wisp" | "wisp-route" | "relay";

export interface DiagEvent {
  /** Browser-owned source client, assigned at interception. */
  clientId?: string;
  seq: number;
  ts: number;
  category: DiagCategory;
  severity: DiagSeverity;
  message: string;
  technicalReason?: string;
  stage?: DiagStage;
  cause?: DiagCause;
  url?: string;
  traceId?: string;
  requestId?: string;
  /** #454: fixed-vocabulary transport evidence. Never infer these
      from technicalReason/message text. */
  deliveryState?: DiagDeliveryState;
  deliveryTransport?: DiagDeliveryTransport;
  stack?: string;
}

export interface DiagSnapshot {
  events: DiagEvent[];
  lastSeq: number;
}

const EVENT_LIMIT = 512;
const TRACE_LIMIT = 256;

const events: DiagEvent[] = [];
let diagSeq = 0;
/** traceId -> most recent event seq, bounded independently of events. */
const traceIndex = new Map<string, number>();
const traceClients = new Map<string, string>();
export function traceClient(id?: string): string | undefined { return id ? traceClients.get(id) : undefined; }

let traceCounter = 0;

/** #95: map the lifecycle stage a failure broke at to the honest
    category and cause. One table, used by the request engine's catch:
    a failure while rewriting is a rewrite failure, one before the
    engine handed the request upstream is a proxy failure, and
    everything between is upstream. */
export function classifyStageFailure(stage: DiagStage): {
  category: DiagCategory;
  cause: DiagCause;
} {
  if (stage.startsWith("REWRITE") || stage === "RAW_BODY_CAP") return { category: "REWRITE", cause: "rewrite" };
  if (stage === "REQUEST_CREATED" || stage === "REQUEST_INTERCEPTED") return { category: "TRANSPORT", cause: "proxy" };
  return { category: "TRANSPORT", cause: "upstream" };
}

import { activeSeam } from "./seam";

/** Redact secrets from any string before it enters the ring. */
export function redactSecrets(s: string): string {
  const w = activeSeam();
  if (w) {
    try {
      return w.redactSecrets(s);
    } catch {
      /* #633: a trapping seam degrades to the TS chain below; the
         seam contract promises a failed module never regresses. */
    }
  }
  /* shortcut: the userinfo scan below is quadratic on a long scheme-like
     run, and a page can put an 80 KB URL into a diag event (5.6 s).
     Fallback path only (the seam is linear); cut at 4 KiB, the tail is
     dropped rather than kept unredacted. Lift with a linear scanner. */
  if (s.length > 4096) s = s.slice(0, 4096) + "[truncated]";
  return s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/([?&#](?:code|state|nonce|code_verifier|id_token|access_token|refresh_token|session_token|credential|g-recaptcha-response|h-captcha-response|cf-turnstile-response)=)[^&#\s]*/gi, "$1[redacted]")
    // Match the whole authorization value: redacting only the word
    // "Bearer" would leave its actual credential in diagnostic text.
    .replace(/(authorization["'\s:=]+)(?:bearer|basic|digest|token|negotiate|ntlm|apikey|api-key|aws4-hmac-sha256|dpop|vapid)\s+\S+/gi, "$1[redacted]")
    .replace(/(authorization["'\s:=]+)(\S+)/gi, "$1[redacted]")
    /* A Cookie request header carries many pairs: redact every name=value
       after the first too, and stop at a Set-Cookie attribute (Path=...). */
    .replace(/(cookie["'\s:=]+)[^;\s]+(?:;\s*(?!(?:path|domain|expires|max-age|samesite|secure|httponly|partitioned|priority)\b)[^;\s=]+=[^;\s]*)*/gi, "$1[redacted]")
    .replace(/((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:token|password|secret|api[_-]?key)["'\s:=]+)([^&\s;]+)/gi, "$1[redacted]");
}

class Diag {
  /** New trace id, shared with the network log entry. */
  trace(clientId?: string): string {
    traceCounter++;
    const id = "zl-t" + Date.now().toString(36) + "-" + traceCounter.toString(36);
    if (clientId) {
      traceClients.set(id, clientId);
      if (traceClients.size > EVENT_LIMIT) traceClients.delete(traceClients.keys().next().value!);
    }
    return id;
  }

  /** Record one diagnostic event. Secrets are redacted on entry. */
  emit(e: Omit<DiagEvent, "seq" | "ts">): void {
    const ev: DiagEvent = {
      ...e,
      clientId: traceClient(e.traceId),
      ts: Date.now(),
      seq: ++diagSeq,
      message: redactSecrets(e.message),
      technicalReason: e.technicalReason ? redactSecrets(e.technicalReason) : undefined,
      url: e.url ? redactSecrets(e.url) : undefined,
      stack: e.stack ? redactSecrets(e.stack) : undefined,
    };
    events.push(ev);
    if (events.length > EVENT_LIMIT) events.shift();
    if (ev.traceId) {
      traceIndex.set(ev.traceId, ev.seq);
      if (traceIndex.size > TRACE_LIMIT) {
        const first = traceIndex.keys().next();
        if (!first.done) traceIndex.delete(first.value);
      }
    }
  }

  /** Record a successful lifecycle step (info severity). */
  stage(
    traceId: string,
    stage: DiagStage,
    extra?: { url?: string; message?: string; category?: DiagCategory },
  ): void {
    this.emit({
      traceId,
      requestId: traceId,
      stage,
      category: extra?.category ?? "TRANSPORT",
      severity: "info",
      message: extra?.message ?? stage.toLowerCase().replace(/_/g, " "),
      url: extra?.url,
    });
  }

  /** Record a failure with a cause classification. */
  failure(e: {
    traceId?: string;
    category: DiagCategory;
    cause: DiagCause;
    message: string;
    technicalReason?: string;
    url?: string;
    stage?: DiagStage;
    severity?: DiagSeverity;
  }): void {
    this.emit({
      traceId: e.traceId,
      requestId: e.traceId,
      category: e.category,
      cause: e.cause,
      severity: e.severity ?? "error",
      message: e.message,
      technicalReason: e.technicalReason,
      url: e.url,
      stage: e.stage,
    });
  }

  /** Events with seq strictly greater than the cursor. */
  eventsSince(since: number, clientId?: string): DiagEvent[] {
    return events.filter((x) => x.seq > since && (clientId === undefined || x.clientId === clientId));
  }

  /** Snapshot for the zl:getDiag delta poll. */
  snapshot(since: number, clientId?: string): DiagSnapshot {
    return { events: this.eventsSince(since, clientId), lastSeq: diagSeq };
  }
}

/* #647: bounded prefix capture of an upstream error body. The caller tees the
   response stream; this drains a bounded prefix of the diagnostic branch so an
   export shows WHY the origin refused (an innertube 400 JSON names the bad
   field) instead of a bare status line. Redacted by the caller like every
   other diagnostic surface. */
export const ERROR_BODY_CAPTURE_LIMIT = 2048;

export async function captureErrorBodyPrefix(
  stream: ReadableStream<Uint8Array>,
  limit: number = ERROR_BODY_CAPTURE_LIMIT,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= limit) {
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    /* a partial capture is still a capture */
  }
  const dec = new TextDecoder();
  let text = '';
  for (const c of chunks) text += dec.decode(c, { stream: true });
  text += dec.decode();
  return text.slice(0, limit);
}

export const DIAG = new Diag();
