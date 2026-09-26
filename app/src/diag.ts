/* Structured proxy diagnostics: bounded event ring + trace index.
   Phase 1 of the diagnostics foundation. Every significant interception
   step (and every failure) is recorded as a DiagEvent carrying a
   category, severity, lifecycle stage, and cause classification. Events
   share traceIds with the network log entries, so the devtools UI can
   join a request with its full lifecycle. Memory is bounded: 512
   events, 256 trace references. Secrets (authorization headers, cookie
   values, bearer tokens) are redacted before anything is stored. */

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
  | "EXTENSION"
  | "BROWSER_API"
  | "PARSER"
  | "TIMEOUT"
  | "BLOCKED"
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
  | "REDIRECTED";

export interface DiagEvent {
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

let traceCounter = 0;

/** Redact secrets from any string before it enters the ring. */
export function redactSecrets(s: string): string {
  return s
    .replace(/(authorization["'\s:=]+)(\S+)/gi, "$1[redacted]")
    .replace(/(cookie["'\s:=]+)([^;\s]+)/gi, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    .replace(/((?:token|password|secret|api[_-]?key)["'\s:=]+)([^&\s;]+)/gi, "$1[redacted]");
}

class Diag {
  /** New trace id, shared with the network log entry. */
  trace(): string {
    traceCounter++;
    return "zl-t" + Date.now().toString(36) + "-" + traceCounter.toString(36);
  }

  /** Record one diagnostic event. Secrets are redacted on entry. */
  emit(e: Omit<DiagEvent, "seq" | "ts">): void {
    const ev: DiagEvent = {
      ...e,
      ts: Date.now(),
      seq: ++diagSeq,
      message: redactSecrets(e.message),
      technicalReason: e.technicalReason ? redactSecrets(e.technicalReason) : undefined,
      url: e.url ? redactSecrets(e.url) : undefined,
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
  eventsSince(since: number): DiagEvent[] {
    return events.filter((x) => x.seq > since);
  }

  /** Snapshot for the zl:getDiag delta poll. */
  snapshot(since: number): DiagSnapshot {
    return { events: this.eventsSince(since), lastSeq: diagSeq };
  }
}

export const DIAG = new Diag();
