/* #452: conservative, OFF-BY-DEFAULT CSP translation prototype,
   now an opt-in enforcement seam (#527). CSP is not a URL-rewriting
   language: 'self' on the shared engine origin can grant access to
   another virtual site's resources, and simply keeping upstream host
   sources would block engine routes. The enforcement accepts only the
   audited deny-only subset, marks every translation decision visibly
   (the x-zl-csp response header) and leaves every unsupported policy
   stripped, never passed through.

   This pure planner only accepts a tiny, provably deny-only subset
   of source-list directives. It deliberately rejects directives with
   origins, paths, wildcards, nonce/hash, strict-dynamic, reports,
   sandbox, fallback semantics or embedding meaning rather than
   silently dropping or broadening them. The 2026-10-28 audit added
   worker-src, frame-src and child-src 'none' as representable (the
   engine page runtime creates no workers and injects no frames into
   proxied documents); frame-ancestors and connect-src stay rejected
   (the engine embeds proxied pages in its own UI frame and the page
   runtime legitimately fetches minted engine routes), and nonce/hash
   stay rejected (injected scripts cannot carry the upstream nonce
   and the rewriter mutates inline bodies, so upstream hashes fail).
   A rejection emits no policy. */

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
/* worker-src/frame-src/child-src 'none' joined after the 2026-10-28 audit: the engine page runtime creates no workers and injects no frames into proxied documents, and a site declaring them 'none' had none upstream either. */
const DENY_ONLY = new Set(["object-src", "base-uri", "form-action", "worker-src", "frame-src", "child-src"]);
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

/** #452/#527 opt-in runtime subset. This is ONLY a monotonic-denial
    restoration after the engine's normal stripping of unsafe upstream
    headers. The planner rejects origins, paths, fallbacks, nonces,
    wildcard sources, reporting, or any other directive. A rejected
    upstream CSP stays stripped, never copied through unmodified.
    Only a proxied HTML document may receive this experimental header.
    #527: every decision is visible. An enforced candidate sets the
    x-zl-csp marker naming exactly the translated directives; an
    unsupported policy sets the marker with the typed reason. The
    marker values are engine-generated (whitelisted directive names or
    a reason enum), never upstream source text, so nothing upstream
    can inject through them. */
export function applyExperimentalCsp(
  downstream: Headers,
  upstream: { get(name: string): string | null },
  contentType: string,
  isDocument: boolean,
): boolean {
  if (!isDocument || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType.trim()))
    return false;
  const raw = upstream.get("content-security-policy");
  if (!raw) return false;
  const plan = planCspTranslation(raw);
  if (plan.kind !== "candidate") {
    downstream.set("x-zl-csp", "unsupported " + plan.reason);
    return false;
  }
  downstream.set("content-security-policy", plan.policy);
  downstream.set("x-zl-csp", "enforced " + plan.directives.join(","));
  /* Report-only endpoints can leak from the browser to upstream
     reports; the generic hostile-header stripper keeps removing it. */
  downstream.delete("content-security-policy-report-only");
  return true;
}
