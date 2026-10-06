/* NativeTransit transport layer (Alpha).
   Truthful transport-mode classification for every intercepted request,
   plus the fallback decision record the diagnostics contract requires.

   Engine reality this names: every non-document resource already
   travels natively (the SW transports the original destination over
   wisp with no rewriting); documents and stylesheets still require the
   rewriter, because parser-inserted URLs must be routed to same-origin
   engine paths before any script runs. NativeTransit is the first
   case, RewriteFallback the second, and every fallback carries a
   machine-readable reason. This module classifies and records only:
   no second network stack, no second cookie store.

   #94: the model is ONE explainable, discriminated decision per
   request - NativeTransit | RewriteFallback | Blocked, each carrying
   a machine-readable reason. The request engine constructs the
   blocked decisions at its deny gates (rules, intercept handlers,
   extension webRequest) and reads reasonOf() for telemetry; nothing
   downstream re-derives classification. Redirects are deliberately
   NOT a mode: a redirect is an upstream-execution fact surfaced
   through the hop chain (netLog finalDest), never a change in
   whether a resource needs rewriting. The passthrough classes
   (opaque schemes, engine assets, the wisp endpoint, host-app
   cross-origin traffic) are the browser's own requests the engine
   never transports, so they are not transit decisions either. */

export type TransportMode = "NativeTransit" | "RewriteFallback" | "Blocked";

export type FallbackReason =
  | "DOCUMENT_REWRITE_REQUIRED"
  | "CSS_URL_REWRITE_REQUIRED"
  | "JS_LITERAL_REWRITE_REQUIRED"
  | "XML_DOCUMENT_REWRITE_REQUIRED"
  | "UNSUPPORTED_PROTOCOL";

/* #94: the reason taxonomy. A native decision explains itself too
   (the unremarkable default), and a blocked request carries the gate
   that denied it, so every decision is explainable without
   re-reading the call site. */
export type NativeReason = "NON_DOCUMENT_RESOURCE";
export type BlockReason = "BLOCKED_RULES" | "BLOCKED_INTERCEPT" | "BLOCKED_WEBREQUEST";
export type TransitReason = FallbackReason | NativeReason | BlockReason;

export interface OriginContext {
  scheme: string;
  host: string;
  port: number | null;
}

export function originOf(url: string): OriginContext | null {
  try {
    const u = new URL(url);
    return {
      scheme: u.protocol.replace(":", ""),
      host: u.hostname,
      port: u.port ? Number(u.port) : null,
    };
  } catch {
    return null;
  }
}

/* #94: one authoritative, explainable decision per request. The
   discriminated union keeps each mode's reason type honest: a
   fallback always carries a FallbackReason, a block a BlockReason,
   a native transport the default's own reason. */
export type TransitDecision =
  | { mode: "NativeTransit"; reason: NativeReason }
  | { mode: "RewriteFallback"; reason: FallbackReason }
  | { mode: "Blocked"; reason: BlockReason };

/** The telemetry view of a decision's reason: fallbacks and blocks
    explain themselves; native is the unremarkable default and stays
    silent (every netLog row would otherwise read the same). */
export function reasonOf(dec: TransitDecision): string | undefined {
  return dec.mode === "NativeTransit" ? undefined : dec.reason;
}

/** Request destinations that load a document, one list for the
    pre-fetch decision and the post-response refinement (issue E:
    embed, fencedframe and xslt used to fall through to
    NativeTransit). */
export const DOC_DESTS: ReadonlySet<string> = new Set([
  "document",
  "iframe",
  "object",
  "frame",
  "embed",
  "fencedframe",
  "xslt",
]);

/** Rewritable-body classification, ONE copy for the SW's rewrite
    branches and the post-response refinement (they used to be two
    includes() checks that could drift; issue C). XHTML documents are
    HTML to the rewriter. */
export function docKind(contentType: string): "html" | "css" | "none" {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return "html";
  if (ct.includes("text/css")) return "css";
  return "none";
}

/** JS body classification, ONE copy for the SW's isJs and the
    post-response refinement: the SW serve-time-transforms these
    bodies (import specifiers, URL-literal pass), so the transit
    decision must know what the rewriter actually touches. */
export function jsBody(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("javascript") || ct.includes("ecmascript");
}

/* #94: the destinations whose JS bodies the engine serve-time
    transforms (specifiers, URL literals, worker prelude). ONE copy:
    the request engine's transform branch and cache-store skip used
    to re-derive this set inline (two `destination === "script" ||
    destination === ""` checks that could drift from the refinement
    below). Worker destinations are intercepted by the engine's own
    worker branches before the page-script branch, so sharing the
    set there is order-safe. */
export const JS_TRANSFORM_DESTS: ReadonlySet<string> = new Set([
  "script",
  "",
  "worker",
  "sharedworker",
]);

/** Content-type-less responses to a document destination: sniff the
    head the way the browser's MIME sniffing would, because the
    browser sniffs html for such navigations and an unrewritten
    document would leak absolute links past the engine (issue C).
    ponytail: latin1 + the sniffing table's tag list over the first
    512 bytes, not the full algorithm (BOM sniffing lives in
    headers.resolveCharset). */
export function sniffsAsHtml(head: Uint8Array): boolean {
  let s = "";
  for (let i = 0; i < head.length && i < 512; i++) s += String.fromCharCode(head[i]);
  return /<!doctype\s+html|<!--|<\/?(?:html|head|body|script|iframe|table|h[1-6]|title|meta)\b/i.test(s);
}

/** Pre-fetch decision from the destination URL and the request
    destination. */
export function decideTransport(target: string, dest: string): TransitDecision {
  const o = originOf(target);
  if (!o || (o.scheme !== "http" && o.scheme !== "https")) {
    return { mode: "RewriteFallback", reason: "UNSUPPORTED_PROTOCOL" };
  }
  if (DOC_DESTS.has(dest.toLowerCase())) {
    return { mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" };
  }
  return { mode: "NativeTransit", reason: "NON_DOCUMENT_RESOURCE" };
}

/** Post-response refinement: an HTML or CSS body forces the rewrite
    path whatever the request's destination said. dest is the request
    destination (issue C): an XML document (SVG/XML navigation) is
    recorded as a required-but-unsupported rewrite instead of silently
    counted as native - the rewriter speaks HTML, not XML, so the body
    still serves native and the honest reason is the only telemetry. */
export function refineWithContent(
  dec: TransitDecision,
  contentType: string,
  dest = "",
): TransitDecision {
  /* #94: refinement only demotes a native decision to a fallback;
     decided requests (fallback, blocked) pass through untouched. */
  if (dec.mode !== "NativeTransit") return dec;
  const kind = docKind(contentType);
  if (kind === "html") {
    return { mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" };
  }
  if (kind === "css") {
    return { mode: "RewriteFallback", reason: "CSS_URL_REWRITE_REQUIRED" };
  }
  /* JS bodies on the destinations the SW serve-time-transforms
     (script, destination "" fetch/XHR/eval, module and classic
     workers) are rewritten: specifiers folded, URL literals routed,
     worker prelude prepended. The decision used to say NativeTransit
     for bodies the rewriter actually touched. */
  const d = dest.toLowerCase();
  if (jsBody(contentType) && JS_TRANSFORM_DESTS.has(d)) {
    return { mode: "RewriteFallback", reason: "JS_LITERAL_REWRITE_REQUIRED" };
  }
  const ct = contentType.toLowerCase();
  const docDest = DOC_DESTS.has(dest.toLowerCase());
  if (docDest && ct.includes("xml")) {
    return { mode: "RewriteFallback", reason: "XML_DOCUMENT_REWRITE_REQUIRED" };
  }
  /* No content type at all on a document destination: the browser
     sniffs html for such navigations, so the SW sniffs the body bytes
     itself (sniffsAsHtml) and records the rewrite requirement. */
  if (docDest && ct === "") {
    return { mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" };
  }
  return dec;
}

export interface FallbackEvent {
  ts: number;
  url: string;
  reason: FallbackReason;
  traceId?: string;
}

/* ponytail: bounded fallback ring (64); per-request work only happens
   on fallback, native successes stay counter-only. */

/* Counters are module state: a SW restart resets them. The epoch is a
   per-worker-evaluation stamp (same trick as the netLog generation),
   so a consumer can detect a reset instead of trusting counters that
   silently restarted (issue E). */
const epoch = Date.now();

const FALLBACK_LIMIT = 64;
let nativeCount = 0;
let fallbackCount = 0;
const fallbacks: FallbackEvent[] = [];

/** Record one COMPLETED request's final transport decision (blocked
    or errored requests record nothing here; their netLog rows carry
    the outcome). A fallback decision is expected-path network data,
    not a load failure: it lands in the counters + fallback ring that
    zl:getNetLog serves, never in the diag failure channel (issue #1
    finding 5: hosts surfaced successful CSS fallbacks as resfail
    entries while the CSS visibly loaded). Genuine rewrite failures
    emit their own REWRITE diag events at the rewrite site; the
    decision itself is not a failure. */
export function transitRecord(traceId: string, url: string, dec: TransitDecision): void {
  if (dec.mode === "NativeTransit") {
    nativeCount++;
    return;
  }
  /* #94: a blocked request never completed, so it is not transit
     telemetry (issue E: its netLog row carries the verdict).
     Defensive: the engine returns before transitRecord on block
     exits. */
  if (dec.mode === "Blocked") return;
  fallbackCount++;
  fallbacks.push({ ts: Date.now(), url, reason: dec.reason, traceId });
  if (fallbacks.length > FALLBACK_LIMIT) fallbacks.shift();
}

/** Counters + recent fallbacks for zl:getNetLog consumers. */
export function transitStats(): {
  native: number;
  fallback: number;
  fallbacks: FallbackEvent[];
  epoch: number;
} {
  return { native: nativeCount, fallback: fallbackCount, fallbacks: [...fallbacks], epoch };
}

/** Tests only: reset counters and ring. */
export function transitResetForTests(): void {
  nativeCount = 0;
  fallbackCount = 0;
  fallbacks.length = 0;
}
