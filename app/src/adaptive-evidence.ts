/* #487 phases 3 + 4: bounded, privacy-preserving per-origin
   transit evidence. Phase 3 records observe-only JS serve outcomes
   (no behavior ever changes on them); phase 4 turns CORROBORATED
   rewrite-specific body-pass failures into an opt-in next-navigation
   literal-pass skip. The learned demotion is off by default and gated
   by the swstate adaptiveTransit flag (the host kill switch); a
   manual KDL native rule wins earlier in the request path; documents,
   CSS and worker preludes are never learned-demoted. Storage is
   hostname + counters only: no URLs, queries, headers or body bytes.
   Module state: a worker restart clears it (which is also the engine
   version invalidation), and a 7-day TTL bounds a long-lived worker. */

import { ZEOLITE_VERSION } from "./swstate";

export interface AdaptiveOriginEvidence {
  origin: string;
  observed: number;
  provenUnchanged: number;
  literalChanged: number;
  specifierChanged: number;
  bodyPassFailures: number;
  failureTraces: string[];
  demotionsServed: number;
  /* #539: failure-source classes. Observe-only counters. None of
     them ever feeds literalPassDemotion: an upstream status, a
     transport error, a challenge interstitial or a rewrite-stage
     failure is not proof that the literal pass broke the site. */
  upstream3xx: number;
  upstream4xx: number;
  upstream5xx: number;
  challengePages: number;
  transportErrors: number;
  rewriteStageErrors: number;
  firstSeen: number;
  lastSeen: number;
}

/* #539: the failure-source taxonomy for one served JS body. The
   demoting signal stays the literal pass's own throw
   (recordBodyPassFailure); everything here is observation only.
   A 404 at this seam is indistinguishable from a genuine
   application 404, so no upstream status can ever demote. */
export type ServeFailureClass =
  | "UPSTREAM_3XX"
  | "UPSTREAM_4XX"
  | "UPSTREAM_5XX"
  | "CHALLENGE_PAGE"
  | "TRANSPORT_ERROR"
  | "REWRITE_STAGE_ERROR";

/** Classify one serve outcome's failure source. null when the serve
    was ordinary (2xx, no transport or rewrite-stage failure). */
export function classifyServeFailure(
  status: number | null,
  failure: "transport" | "rewrite" | null,
  challenge: boolean,
): ServeFailureClass | null {
  if (challenge) return "CHALLENGE_PAGE";
  if (failure === "rewrite") return "REWRITE_STAGE_ERROR";
  if (failure === "transport") return "TRANSPORT_ERROR";
  if (status === null || status < 300) return null;
  if (status < 400) return "UPSTREAM_3XX";
  if (status < 500) return "UPSTREAM_4XX";
  return "UPSTREAM_5XX";
}

/* ponytail: bounded store - 512 origins, drop-oldest; 8 failure
   trace ids per origin. Corroboration: >= 3 failures on >= 2
   distinct traces. One failure (one flaky wasm load) never changes
   behavior. */
const MAX_ORIGINS = 512;
const MAX_TRACES = 8;
const CORROBORATE_FAILURES = 3;
const CORROBORATE_TRACES = 2;
export const ADAPTIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const evidence = new Map<string, AdaptiveOriginEvidence>();
let dropped = 0;

/* #539: engine-version invalidation. Learned state is stamped with
   the engine version that produced it; a worker restart is the
   natural wipe (module state), but a long-lived worker that swapped
   to a new engine version must not act on evidence the old
   rewriter produced. The stamp rides the snapshot for operators. */
let stampedVersion: string | null = null;
let versionResets = 0;
let versionSource: () => string = () => ZEOLITE_VERSION;

/** Tests only: pretend the engine version is v (null restores the
    real one). Never used by the engine itself. */
export function adaptiveEvidenceVersionForTests(v: string | null): void {
  versionSource = v === null ? () => ZEOLITE_VERSION : () => v;
}

function versionGate(): void {
  const v = versionSource();
  if (stampedVersion === v) return;
  if (stampedVersion !== null) {
    evidence.clear();
    dropped = 0;
    versionResets++;
  }
  stampedVersion = v;
}

function hostOf(target: string): string | null {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function entry(origin: string): AdaptiveOriginEvidence {
  versionGate();
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
    e = {
      origin,
      observed: 0,
      provenUnchanged: 0,
      literalChanged: 0,
      specifierChanged: 0,
      bodyPassFailures: 0,
      failureTraces: [],
      demotionsServed: 0,
      upstream3xx: 0,
      upstream4xx: 0,
      upstream5xx: 0,
      challengePages: 0,
      transportErrors: 0,
      rewriteStageErrors: 0,
      firstSeen: now,
      lastSeen: now,
    };
    evidence.set(origin, e);
  }
  e.lastSeen = now;
  return e;
}

/** #487 phase 3: observe-only record of one served JS body's actual
    transformation class (from transit.planJsServeOutcome). */
export function recordJsServeOutcome(
  target: string,
  o: { specifierChanged: boolean; literalChanged: boolean; literalSkipped: boolean },
): void {
  const h = hostOf(target);
  if (!h) return;
  const e = entry(h);
  e.observed++;
  if (o.specifierChanged) e.specifierChanged++;
  if (o.literalChanged) e.literalChanged++;
  if (!o.specifierChanged && !o.literalChanged && !o.literalSkipped) e.provenUnchanged++;
}

/** #487 phase 4: one rewrite-specific body-pass failure (the literal
    pass threw; the specifier output still served). traceId rides for
    corroboration across DISTINCT loads only - never logged. This is
    the ONLY demoting signal. */
export function recordBodyPassFailure(target: string, traceId: string): void {
  const h = hostOf(target);
  if (!h) return;
  const e = entry(h);
  e.bodyPassFailures++;
  if (!e.failureTraces.includes(traceId)) {
    if (e.failureTraces.length >= MAX_TRACES) e.failureTraces.shift();
    e.failureTraces.push(traceId);
  }
}

/** #539: observe-only record of a serve's failure SOURCE class
    (upstream status, transport error, challenge page,
    rewrite-stage error). Counted, reported in the snapshot, never
    demoting. null (an ordinary serve) is a no-op. */
export function recordServeFailure(target: string, cls: ServeFailureClass | null): void {
  if (!cls) return;
  const h = hostOf(target);
  if (!h) return;
  const e = entry(h);
  if (cls === "UPSTREAM_3XX") e.upstream3xx++;
  else if (cls === "UPSTREAM_4XX") e.upstream4xx++;
  else if (cls === "UPSTREAM_5XX") e.upstream5xx++;
  else if (cls === "CHALLENGE_PAGE") e.challengePages++;
  else if (cls === "TRANSPORT_ERROR") e.transportErrors++;
  else e.rewriteStageErrors++;
}

/** #487 phase 4: is the literal pass for this origin corroborated as
    failing? TTL-stale evidence never demotes. The caller gates on the
    swstate adaptiveTransit flag; this answers evidence only. */
export function literalPassDemotion(target: string): boolean {
  versionGate();
  const h = hostOf(target);
  if (!h) return false;
  const e = evidence.get(h);
  if (!e) return false;
  if (Date.now() - e.lastSeen > ADAPTIVE_TTL_MS) {
    evidence.delete(h);
    return false;
  }
  return e.bodyPassFailures >= CORROBORATE_FAILURES && e.failureTraces.length >= CORROBORATE_TRACES;
}

/** #487 phase 4: deployment-level metric - one serve that skipped the
    literal pass on learned evidence. */
export function noteDemotionServed(target: string): void {
  const h = hostOf(target);
  if (!h) return;
  entry(h).demotionsServed++;
}

/** Host diagnostics view: hostname + counters only, TTL-pruned, with
    the engine version that produced it (the versioned rollout stamp)
    and the #539 failure-source counters. */
export function adaptiveEvidenceSnapshot(): {
  version: string;
  origins: number;
  dropped: number;
  versionResets: number;
  entries: AdaptiveOriginEvidence[];
} {
  versionGate();
  const now = Date.now();
  for (const [k, v] of evidence) {
    if (now - v.lastSeen > ADAPTIVE_TTL_MS) evidence.delete(k);
  }
  return { version: versionSource(), origins: evidence.size, dropped, versionResets, entries: Array.from(evidence.values()) };
}

/** Tests and the kill switch reset. zl:teardown also lands here
    (#539: learned state is removed on teardown). */
export function adaptiveEvidenceReset(): void {
  evidence.clear();
  dropped = 0;
  versionResets = 0;
  stampedVersion = null;
}
