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
   no second network stack, no second cookie store. */

export type TransportMode = "NativeTransit" | "RewriteFallback";

export type FallbackReason =
  | "DOCUMENT_REWRITE_REQUIRED"
  | "CSS_URL_REWRITE_REQUIRED"
  | "XML_DOCUMENT_REWRITE_REQUIRED"
  | "UNSUPPORTED_PROTOCOL";

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

export interface TransitDecision {
  mode: TransportMode;
  fallbackReason?: FallbackReason;
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
    return { mode: "RewriteFallback", fallbackReason: "UNSUPPORTED_PROTOCOL" };
  }
  if (DOC_DESTS.has(dest.toLowerCase())) {
    return { mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" };
  }
  return { mode: "NativeTransit" };
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
  if (dec.mode === "RewriteFallback") return dec;
  const kind = docKind(contentType);
  if (kind === "html") {
    return { mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" };
  }
  if (kind === "css") {
    return { mode: "RewriteFallback", fallbackReason: "CSS_URL_REWRITE_REQUIRED" };
  }
  const ct = contentType.toLowerCase();
  const docDest = DOC_DESTS.has(dest.toLowerCase());
  if (docDest && ct.includes("xml")) {
    return { mode: "RewriteFallback", fallbackReason: "XML_DOCUMENT_REWRITE_REQUIRED" };
  }
  /* No content type at all on a document destination: the browser
     sniffs html for such navigations, so the SW sniffs the body bytes
     itself (sniffsAsHtml) and records the rewrite requirement. */
  if (docDest && ct === "") {
    return { mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" };
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
  fallbackCount++;
  const reason = dec.fallbackReason ?? "DOCUMENT_REWRITE_REQUIRED";
  fallbacks.push({ ts: Date.now(), url, reason, traceId });
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
