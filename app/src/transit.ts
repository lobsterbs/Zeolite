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

import { DIAG } from "./diag";

export type TransportMode = "NativeTransit" | "RewriteFallback";

export type FallbackReason =
  | "DOCUMENT_REWRITE_REQUIRED"
  | "CSS_URL_REWRITE_REQUIRED"
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

/** Pre-fetch decision from the destination URL and sec-fetch-dest. */
export function decideTransport(target: string, destHeader: string): TransitDecision {
  const o = originOf(target);
  if (!o || (o.scheme !== "http" && o.scheme !== "https")) {
    return { mode: "RewriteFallback", fallbackReason: "UNSUPPORTED_PROTOCOL" };
  }
  const d = destHeader.toLowerCase();
  if (d === "document" || d === "iframe" || d === "object" || d === "frame") {
    return { mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" };
  }
  return { mode: "NativeTransit" };
}

/** Post-response refinement: an HTML or CSS body forces the rewrite
    path whatever the request's destination header said. */
export function refineWithContent(dec: TransitDecision, contentType: string): TransitDecision {
  if (dec.mode === "RewriteFallback") return dec;
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) {
    return { mode: "RewriteFallback", fallbackReason: "DOCUMENT_REWRITE_REQUIRED" };
  }
  if (ct.includes("text/css")) {
    return { mode: "RewriteFallback", fallbackReason: "CSS_URL_REWRITE_REQUIRED" };
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
const FALLBACK_LIMIT = 64;
let nativeCount = 0;
let fallbackCount = 0;
const fallbacks: FallbackEvent[] = [];

/** Record one request's final transport decision. Fallbacks are never
    silent: each lands in the diag ring with its reason. */
export function transitRecord(traceId: string, url: string, dec: TransitDecision): void {
  if (dec.mode === "NativeTransit") {
    nativeCount++;
    return;
  }
  fallbackCount++;
  const reason = dec.fallbackReason ?? "DOCUMENT_REWRITE_REQUIRED";
  fallbacks.push({ ts: Date.now(), url, reason, traceId });
  if (fallbacks.length > FALLBACK_LIMIT) fallbacks.shift();
  DIAG.stage(traceId, "TRANSPORT_FALLBACK", {
    url,
    message: "rewrite fallback: " + reason,
    category: "UNSUPPORTED",
  });
}

/** Counters + recent fallbacks for zl:getNetLog consumers. */
export function transitStats(): { native: number; fallback: number; fallbacks: FallbackEvent[] } {
  return { native: nativeCount, fallback: fallbackCount, fallbacks: [...fallbacks] };
}

/** Tests only: reset counters and ring. */
export function transitResetForTests(): void {
  nativeCount = 0;
  fallbackCount = 0;
  fallbacks.length = 0;
}
