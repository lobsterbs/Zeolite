/* #452: conservative, OFF-BY-DEFAULT CSP translation prototype.
   CSP is not a URL-rewriting language: 'self' on the shared engine
   origin can grant access to another virtual site's resources, and
   simply keeping upstream host sources will block engine routes.
   Do not feed candidate output to a live Response without real
   Chromium enforcement and injection compatibility tests.

   This pure planner only accepts a tiny, provably deny-only subset
   of source-list directives. It deliberately rejects directives with
   origins, paths, wildcards, nonce/hash, strict-dynamic, reports,
   sandbox, fallback semantics or embedding meaning rather than
   silently dropping or broadening them. A rejection emits no policy. */

export type CspUnsupportedReason =
  | "oversize" | "invalid-syntax" | "duplicate-directive"
  | "unsupported-directive" | "unsupported-source"
  | "report-only";

export type CspTranslationPlan =
  | { kind: "candidate"; policy: string; directives: readonly string[] }
  | { kind: "unsupported"; reason: CspUnsupportedReason };

/* These directives have no fallback to another source list and 'none'
   prohibits their class of actions. Other directives need a URL-aware
   engine-origin and bootstrap safety proof before we can translate. */
const DENY_ONLY = new Set(["object-src", "base-uri", "form-action"]);
const MAX_POLICY_BYTES = 8192;
const MAX_DIRECTIVES = 64;

export function planCspTranslation(
  raw: string,
  options: { reportOnly?: boolean } = {},
): CspTranslationPlan {
  if (options.reportOnly) return { kind: "unsupported", reason: "report-only" };
  if (new TextEncoder().encode(raw).length > MAX_POLICY_BYTES)
    return { kind: "unsupported", reason: "oversize" };
  /* Reject commas (multiple header policies) and CRLF instead of
     reinterpreting their intersection as a single weaker policy. */
  if (!raw.trim() || /[\x00-\x1f\x7f,]/.test(raw))
    return { kind: "unsupported", reason: "invalid-syntax" };

  const parts = raw.split(";");
  if (parts.length > MAX_DIRECTIVES + 1)
    return { kind: "unsupported", reason: "oversize" };
  const seen = new Set<string>();
  const emitted: string[] = [];
  for (const part of parts) {
    const directive = part.trim();
    if (!directive) continue; // ordinary trailing semicolon
    const tokens = directive.split(/\s+/);
    const name = tokens[0].toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      return { kind: "unsupported", reason: "invalid-syntax" };
    if (seen.has(name)) return { kind: "unsupported", reason: "duplicate-directive" };
    seen.add(name);
    if (!DENY_ONLY.has(name))
      return { kind: "unsupported", reason: "unsupported-directive" };
    /* 'none' must be the WHOLE source list. In CSP, 'none' combined
       with another source is ignored, so accepting a mixture could
       dramatically broaden the policy. */
    if (tokens.length !== 2 || tokens[1].toLowerCase() !== "'none'")
      return { kind: "unsupported", reason: "unsupported-source" };
    emitted.push(name + " 'none'");
  }
  if (!emitted.length) return { kind: "unsupported", reason: "invalid-syntax" };
  return { kind: "candidate", policy: emitted.join("; "), directives: emitted.map(v => v.split(" ")[0]) };
}

/** Candidate headers are NOT applied by the current engine. This
    function allows unit tests and later opt-in adapters to classify
    both enforcement and report-only headers without re-parsing. */
export function planCspHeaders(headers: { get(name: string): string | null }): {
  enforcing: CspTranslationPlan | null;
  reportOnly: CspTranslationPlan | null;
} {
  const enforce = headers.get("content-security-policy");
  const report = headers.get("content-security-policy-report-only");
  return {
    enforcing: enforce === null ? null : planCspTranslation(enforce),
    reportOnly: report === null ? null : planCspTranslation(report, { reportOnly: true }),
  };
}
