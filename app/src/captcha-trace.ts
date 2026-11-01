/* #451: bounded per-attempt CAPTCHA tracing.

   A failed CAPTCHA flow must report WHICH observable stage failed, so
   hosts can tell "the widget asset 404ed" apart from "the verify call
   was refused with 429". This module records exactly that, per attempt:

   - BOOTSTRAP_SEEN   the challenge URL itself was fetched
   - ASSET_LOAD       a widget asset response was observed
   - FRAME_HANDSHAKE  a challenge iframe/frame navigation was observed
   - SUBMISSION       an upstream verify-family request was observed
   - VERIFY_OUTCOME   the HTTP outcome class of a verify-family response

   The vocabulary is fixed and every record states only what was
   actually observed: a stage that was not observable is either absent
   (never seen) or explicitly `unknown` (markUnknown) - never guessed.
   Provider class is derived ONLY from URL classification (the same
   host rules as request.ts isChallengeFrameUrl); no request bodies,
   tokens, site keys, cookies or answers are ever recorded, and every
   URL/note passes redactSecrets on entry.

   Bounds follow the diag/tracing precedent: <=64 attempts, <=16 stage
   records per attempt, overwrite-oldest. Zero allocation when no
   captcha traffic occurs: no buffers, timers or eager structures exist
   until the first observation. Detection and human solving only - this
   is observability, not a solver (the no-bypass rule stands). */

import { DIAG, redactSecrets } from "./diag";

export type CaptchaProvider = "recaptcha" | "hcaptcha" | "turnstile" | "unknown";

export type CaptchaStage =
  | "BOOTSTRAP_SEEN"
  | "ASSET_LOAD"
  | "FRAME_HANDSHAKE"
  | "SUBMISSION"
  | "VERIFY_OUTCOME";

/** HTTP outcome class of a response-shaped stage. Fixed vocabulary:
    the engine never invents finer detail than the status class. */
export type CaptchaOutcome = "200" | "403" | "429" | "other-status" | "transport-failure";

export interface CaptchaStageRecord {
  stage: CaptchaStage;
  ts: number;
  /** Response-shaped stages only; absent means not observed. */
  outcome?: CaptchaOutcome;
  /** Fixed-vocabulary transport route when the caller observed it
      ("wisp" | "wisp-route" | "relay"). Never inferred. */
  transport?: string;
  /** Provider-relative ms from attempt start when known. */
  ms?: number;
  /** Redacted URL of the observed request/response. */
  url?: string;
  /** Fixed note from the call site (redacted). */
  note?: string;
  /** #451: explicit not-observable marker - the stage mattered but
      could not be observed. Never combined with an invented outcome. */
  unknown?: boolean;
}

export interface CaptchaObservationBase {
  /** Trace id of the DIAG event this observation feeds from; reused
      as the attemptId so the trace and the diag ring stay joinable. */
  attemptId?: string;
  clientId?: string;
  url?: string;
  stage: CaptchaStage;
  note?: string;
  /** Test seam: wall-clock override (production uses Date.now). */
  ts?: number;
}

export interface CaptchaAttempt {
  attemptId: string;
  clientId?: string;
  provider: CaptchaProvider;
  startedAt: number;
  stages: CaptchaStageRecord[];
  /** True once a VERIFY_OUTCOME was recorded: the flow reached a
      verdict, later observations start a fresh attempt. */
  closed: boolean;
}

export interface CaptchaTraceSnapshot {
  attempts: CaptchaAttempt[];
  /** Honest boundedness counters (adaptive-evidence precedent). */
  droppedAttempts: number;
  droppedStages: number;
}

const ATTEMPT_LIMIT = 64;
const STAGE_LIMIT = 16;
/** Same-client observations merge into an open attempt only within
    this recency window; older activity starts a new attempt. */
const MERGE_WINDOW_MS = 5 * 60 * 1000;

/** Provider class from URL classification only. Same host rules as
    request.ts isChallengeFrameUrl; captcha-trace.test.ts pins the two
    against each other so they cannot drift. */
export function classifyProvider(url: string): CaptchaProvider {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "unknown";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "unknown";
  const h = u.hostname;
  if ((h === "www.google.com" || h === "www.recaptcha.net" || h === "recaptcha.net") && u.pathname.startsWith("/recaptcha/")) {
    return "recaptcha";
  }
  if (h === "challenges.cloudflare.com") return "turnstile";
  if (h === "hcaptcha.com" || h === "newassets.hcaptcha.com") return "hcaptcha";
  return "unknown";
}

/** Status class for a response-shaped stage. Never called with a
    status the caller did not actually observe. */
export function outcomeOf(status: number): CaptchaOutcome {
  if (status === 200) return "200";
  if (status === 403) return "403";
  if (status === 429) return "429";
  return "other-status";
}

export interface CaptchaObservation extends CaptchaObservationBase {
  outcome?: CaptchaOutcome;
  transport?: string;
  unknown?: boolean;
}

class CaptchaTrace {
  private readonly attempts = new Map<string, CaptchaAttempt>();
  private droppedAttempts = 0;
  private droppedStages = 0;

  resetForTests(): void {
    this.attempts.clear();
    this.droppedAttempts = 0;
    this.droppedStages = 0;
  }

  /** Attach one observation. Creates the attempt when no open attempt
      matches (by attemptId, or clientId+provider within the merge
      window); a closed attempt is never appended to. Returns the
      attemptId the record landed in, or null when it was dropped. */
  observe(a: CaptchaObservation): string | null {
    const now = a.ts ?? Date.now();
    const provider = a.url ? classifyProvider(a.url) : "unknown";
    let att = this.findAttempt(a, provider, now);
    if (!att) {
      /* A trace id already mapped to a closed attempt stays with that
         attempt; the new flow mints a fresh id instead of overwriting. */
      let id = a.attemptId;
      if (id === undefined || this.attempts.has(id)) id = DIAG.trace(a.clientId);
      att = { attemptId: id, clientId: a.clientId, provider, startedAt: now, stages: [], closed: false };
      this.attempts.set(id, att);
      if (this.attempts.size > ATTEMPT_LIMIT) {
        const first = this.attempts.keys().next();
        if (!first.done) this.attempts.delete(first.value);
        this.droppedAttempts++;
      }
    }
    const rec: CaptchaStageRecord = {
      stage: a.stage,
      ts: now,
      ...(a.outcome !== undefined ? { outcome: a.outcome } : {}),
      ...(a.transport !== undefined ? { transport: a.transport } : {}),
      ...(a.unknown === true ? { unknown: true } : {}),
      ...(att.stages.length > 0 ? { ms: Math.max(0, now - att.startedAt) } : {}),
      ...(a.url !== undefined ? { url: redactSecrets(a.url) } : {}),
      ...(a.note !== undefined ? { note: redactSecrets(a.note) } : {}),
    };
    att.stages.push(rec);
    if (att.stages.length > STAGE_LIMIT) {
      att.stages.shift();
      this.droppedStages++;
    }
    if (a.stage === "VERIFY_OUTCOME") att.closed = true;
    return att.attemptId;
  }

  /** Record a stage that mattered but was not observable - explicitly
      unknown, never a guess at what happened. */
  markUnknown(a: CaptchaObservationBase): string | null {
    return this.observe({ ...a, unknown: true, note: a.note ?? "unknown" });
  }

  private findAttempt(a: CaptchaObservation, provider: CaptchaProvider, now: number): CaptchaAttempt | null {
    if (a.attemptId) {
      const att = this.attempts.get(a.attemptId);
      if (att && !att.closed && (att.provider === provider || provider === "unknown")) return att;
      /* Each emit point mints its OWN DIAG trace id for one flow, so a
         miss falls through to clientId+provider correlation instead of
         fragmenting the attempt per emit site. */
    }
    if (!a.clientId) return null;
    let best: CaptchaAttempt | null = null;
    for (const att of this.attempts.values()) {
      if (att.closed || att.clientId !== a.clientId) continue;
      if (att.provider !== provider && provider !== "unknown" && att.provider !== "unknown") continue;
      if (now - att.stages[att.stages.length - 1]!.ts > MERGE_WINDOW_MS) continue;
      if (!best || att.startedAt > best.startedAt) best = att;
    }
    return best;
  }

  /** Compact host-facing snapshot (zl:captchaTrace). Cloned: callers
      cannot mutate the ring through it. */
  snapshot(): CaptchaTraceSnapshot {
    return {
      attempts: [...this.attempts.values()].map((att) => ({
        attemptId: att.attemptId,
        ...(att.clientId !== undefined ? { clientId: att.clientId } : {}),
        provider: att.provider,
        startedAt: att.startedAt,
        closed: att.closed,
        stages: att.stages.map((s) => ({ ...s })),
      })),
      droppedAttempts: this.droppedAttempts,
      droppedStages: this.droppedStages,
    };
  }
}

export const CAPTCHA_TRACE = new CaptchaTrace();
