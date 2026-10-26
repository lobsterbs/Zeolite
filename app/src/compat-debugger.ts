/* #494: bounded request-level compatibility debugger, pure and inert.
   Never serialize raw strings from page-controlled headers, URLs, bodies,
   exception messages, request initiators, rule IDs or transport errors.
   Each exported fact is an observed numeric value or fixed vocabulary.
   The control-plane boundary must independently verify host sender,
   live proxied client, and SW-owned trace -> client identity. */
import type { DiagEvent } from "./diag";
import type { NetEntry } from "./netlog";
import type { TraceEntry } from "./tracing";

export type DebugStep = {
  source: "diagnostic" | "network" | "decision";
  ts: number;
  code: string;
  severity?: string;
  cause?: string;
  status?: number;
  decision?: string;
  reason?: string;
};
export interface DebugReport {
  schemaVersion: 1;
  collection: "observed" | "no-evidence";
  scope: "request";
  redaction: "strict";
  engineVersion: string;
  generation: number;
  capturedAt: number;
  traceId: string;
  steps: DebugStep[];
}
const categories = new Set([
  "TRANSPORT","UPSTREAM","REWRITE","RUNTIME","NAVIGATION","STORAGE",
  "WEBSOCKET","SERVICE_WORKER","CORS","CSP","COOKIE","EXTENSION",
  "BROWSER_API","PARSER","TIMEOUT","BLOCKED","CHALLENGE","UNSUPPORTED","UNKNOWN",
]);
const stages = new Set([
  "REQUEST_CREATED","REQUEST_INTERCEPTED","UPSTREAM_REQUEST","UPSTREAM_RESPONSE",
  "RESPONSE_RECEIVED","REWRITE_STARTED","REWRITE_COMPLETED","REWRITE_FAILED",
  "RUNTIME_INJECTION","SCRIPT_EXECUTION","DOWNSTREAM_REQUEST","TRANSPORT_FALLBACK",
  "REDIRECT_HOP","REDIRECTED","PINNED_SCRIPT",
]);
const severities = new Set(["info","warning","error","critical"]);
const causes = new Set(["failure","unsupported","blocked","upstream","proxy","rewrite","browser_limit","extension","challenge","unknown"]);
const decisions = new Set(["NativeTransit","RewriteFallback","Blocked","browser","engine"]);
const fallbackReasons = new Set([
  "DOCUMENT_REWRITE_REQUIRED","CSS_URL_REWRITE_REQUIRED","JS_LITERAL_REWRITE_REQUIRED",
  "XML_DOCUMENT_REWRITE_REQUIRED","UNSUPPORTED_PROTOCOL","POLICY_REWRITE",
  "NON_DOCUMENT_RESOURCE","POLICY_NATIVE","CDN_CGI_NATIVE","CF_CHALLENGE_VERBATIM",
  "BLOCKED_RULES","BLOCKED_INTERCEPT","BLOCKED_WEBREQUEST",
]);
const rewrites = new Set(["html","css","js","js-pinned"]);
const subsystems = new Set(["rules","intercept","transport","rewriter","websocket"]);

const fromSet = (v: unknown, allowed: Set<string>, fallback = "unknown") =>
  typeof v === "string" && allowed.has(v) ? v : fallback;
const safeNumber = (v: unknown, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : 0;

/** Pure aggregation: a request's verified trace and exact SW client only.
    A client id is a privacy-sensitive lookup key, never a report field.
    An omitted record is not interpreted as a successful request. */
export function buildCompatibilityReport(args: {
  clientId: string;
  traceId: string;
  engineVersion: string;
  generation: number;
  now: number;
  diagnostics: readonly DiagEvent[];
  network: readonly NetEntry[];
  tracing: readonly TraceEntry[];
}): DebugReport {
  const steps: DebugStep[] = [];
  for (const ev of args.diagnostics) {
    if (ev.traceId !== args.traceId || ev.clientId !== args.clientId) continue;
    if (steps.length >= 128) break;
    steps.push({
      source: "diagnostic", ts: safeNumber(ev.ts, 9e15),
      code: ev.stage ? fromSet(ev.stage, stages) : fromSet(ev.category, categories),
      severity: fromSet(ev.severity, severities),
      cause: fromSet(ev.cause, causes),
    });
  }
  for (const ev of args.network) {
    if (ev.traceId !== args.traceId || ev.clientId !== args.clientId) continue;
    steps.push({
      source: "network", ts: safeNumber(ev.ts, 9e15), code: "RESPONSE_OBSERVATION",
      status: safeNumber(ev.status, 599),
      decision: fromSet(ev.transport, decisions),
      reason: ev.fallbackReason ? fromSet(ev.fallbackReason, fallbackReasons) :
        ev.rewritten ? fromSet(ev.rewritten, rewrites) : "unknown",
    });
    break; // one bounded request record per trace
  }
  for (const ev of args.tracing) {
    if (ev.traceId !== args.traceId) continue;
    if (steps.length >= 160) break;
    steps.push({
      source: "decision", ts: safeNumber(ev.ts, 9e15),
      code: fromSet(ev.subsystem, subsystems),
      /* Rule, original and result contain arbitrary URLs/site text.
         Even a redactSecrets() string is not export-safe. */
    });
  }
  steps.sort((a,b) => a.ts - b.ts);
  return {
    schemaVersion: 1,
    collection: steps.length ? "observed" : "no-evidence",
    scope: "request",
    redaction: "strict",
    engineVersion: "Zeolite", // no caller-provided free text
    generation: safeNumber(args.generation, 9e15),
    capturedAt: safeNumber(args.now, 9e15),
    traceId: /^zl-t[a-z0-9]+-[a-z0-9]+$/.test(args.traceId) && args.traceId.length <= 64 ? args.traceId : "unknown",
    steps,
  };
}
/** The fixed-vocabulary serializer is intentionally unable to include
    raw URLs, credentials, arbitrary strings, or worker-global logs. */
export function compatibilityKdl(report: DebugReport): string {
  const q = (v: string) => JSON.stringify(v);
  return 'zeolite-debug version=1 scope="request" redaction="strict" collection=' +
    q(report.collection) + ' trace=' + q(report.traceId) +
    ' generation=' + report.generation + ' captured-at=' + report.capturedAt + ' {\n' +
    report.steps.map(s => '  step source=' + q(s.source) + ' code=' + q(s.code) +
      ' at=' + s.ts +
      (s.severity ? ' severity=' + q(s.severity) : '') +
      (s.cause ? ' cause=' + q(s.cause) : '') +
      (s.status !== undefined ? ' status=' + s.status : '') +
      (s.decision ? ' decision=' + q(s.decision) : '') +
      (s.reason ? ' reason=' + q(s.reason) : '')).join('\n') + '\n}\n';
}
