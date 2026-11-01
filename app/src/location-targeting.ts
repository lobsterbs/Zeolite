/* #456 gate 4: automatic #432-class location targeting. When a
   pathname-reading SPA renders its own not-found view on a correct
   URL (play2048.co class, the LegacyUnforgeable limit no page shim
   can fix), the origin is marked for the hybrid pre-execution
   location rewrite on its next load. Evidence must be stronger than
   a generic 404 (a legitimate application response): the mark needs
   BOTH corroborated page-side not-found reports from >= 2 distinct
   loads (the injected post-load watcher, zl:spa404) AND observed
   location-read rewrites on that origin's documents (the wasm
   location pass reason "rewritten"). Storage is hostname +
   counters only: no URLs, queries or tokens. Module state, like
   adaptive-evidence: a worker restart clears it (which is also the
   engine version invalidation) and a 7-day TTL bounds a
   long-lived worker. */

import { DIAG } from "./diag";
import { experimentalEnabled } from "./experimental-flags";
import { locationPolicy, type LocationPolicy, type SiteRule } from "./siteconfig";
import { locationTargetingEnabled, ZEOLITE_VERSION } from "./swstate";

export interface LocationTargetEvidence {
  origin: string;
  reports: number;
  clientIds: string[];
  locationReads: number;
  markedAt: number | null;
  firstSeen: number;
  lastSeen: number;
}

/* ponytail: bounded store - 512 origins, drop-oldest, 8 client ids
   per origin. Corroboration: >= 2 distinct client ids AND >= 1
   observed location-read rewrite. One load never marks. */
const MAX_ORIGINS = 512;
const MAX_CLIENTS = 8;
export const LOCATION_TARGET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const evidence = new Map<string, LocationTargetEvidence>();
let dropped = 0;

function hostOf(target: string): string | null {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function entry(origin: string): LocationTargetEvidence {
  let e = evidence.get(origin);
  const now = Date.now();
  if (!e) {
    if (evidence.size >= MAX_ORIGINS) {
      const oldest = evidence.keys().next().value;
      if (oldest !== undefined) {
        evidence.delete(oldest);
        dropped++;
      }
    }
    e = { origin, reports: 0, clientIds: [], locationReads: 0, markedAt: null, firstSeen: now, lastSeen: now };
    evidence.set(origin, e);
  }
  e.lastSeen = now;
  return e;
}

/** #456: a served document's scripts were location-rewritten (the
    wasm pass reason "rewritten") - the pathname-reading half of the
    evidence. Observe-only; never changes behavior by itself. */
export function recordDocumentLocationReads(target: string): void {
  const h = hostOf(target);
  if (!h) return;
  entry(h).locationReads++;
}

/** #456: one page-side not-found report (zl:spa404; the origin is
    recovered worker-side from the sender's own route, never
    page-supplied). Marks the origin once the corroboration
    threshold is met. */
export function recordSpa404Report(target: string, clientId: string | undefined): void {
  const h = hostOf(target);
  if (!h) return;
  const e = entry(h);
  e.reports++;
  if (clientId && !e.clientIds.includes(clientId)) {
    if (e.clientIds.length >= MAX_CLIENTS) e.clientIds.shift();
    e.clientIds.push(clientId);
  }
  if (e.markedAt === null && e.clientIds.length >= 2 && e.locationReads > 0) {
    e.markedAt = Date.now();
    DIAG.emit({
      category: "REWRITE",
      severity: "info",
      message: "location auto-targeting marked origin",
      technicalReason: h,
    });
  }
}

function marked(target: string): boolean {
  const h = hostOf(target);
  if (!h) return false;
  const e = evidence.get(h);
  if (!e || e.markedAt === null) return false;
  if (Date.now() - e.lastSeen > LOCATION_TARGET_TTL_MS) {
    evidence.delete(h);
    return false;
  }
  return true;
}

/** #456 gate 4 effective policy: an explicit siteconfig rule always
    wins (including "off" - the host said so); the host experimental
    hybridLocation selection (zl:config, default off) takes the
    hybrid pass for every origin without an explicit rule; a
    corroborated origin takes the hybrid pass; everything else keeps
    the legacy default. The swstate flag is the host kill switch. */
export function resolveLocationPolicy(target: string | null | undefined, rule: SiteRule): LocationPolicy {
  if (rule.locationRewrite) return rule.locationRewrite;
  if (experimentalEnabled("hybridLocation")) {
    return { mode: "hybrid", maxBytes: 512 * 1024 };
  }
  if (target && locationTargetingEnabled() && marked(target)) {
    return { mode: "hybrid", maxBytes: 512 * 1024 };
  }
  return locationPolicy(rule);
}

/** Host diagnostics view: hostname + counters only, TTL-pruned,
    with the engine version stamp. */
export function locationTargetSnapshot(): {
  version: string;
  origins: number;
  dropped: number;
  entries: LocationTargetEvidence[];
} {
  const now = Date.now();
  for (const [k, v] of evidence) {
    if (now - v.lastSeen > LOCATION_TARGET_TTL_MS) evidence.delete(k);
  }
  return { version: ZEOLITE_VERSION, origins: evidence.size, dropped, entries: Array.from(evidence.values()) };
}

/** Tests and the kill switch reset. */
export function locationTargetReset(): void {
  evidence.clear();
  dropped = 0;
}
