/* Experimental feature selection (#452/#456/#477/#487).
   This is a selection registry, NOT an implementation of unfinished
   browser features. In particular, no selection may enable CSP
   translation or same-realm guest service workers until their
   independent security and Chromium gates are complete.
   Memory-only: a host re-pushes selected choices after SW restarts. */
export const EXPERIMENTAL_FLAGS = [
  "adaptiveTransit", "hybridLocation", "cspTranslation", "virtualSW",
] as const;
export type ExperimentalFlag = typeof EXPERIMENTAL_FLAGS[number];
export type ExperimentalChoices = Record<ExperimentalFlag, boolean>;

const defaults = (): ExperimentalChoices => ({
  adaptiveTransit: false,
  hybridLocation: false,
  cspTranslation: false,
  virtualSW: false,
});
let requested = defaults();

/** Runtime flags must never be inferred from caller-provided
    messages on the proxied page side. Only host zl:config can write. */
export function experimentalEnabled(key: ExperimentalFlag): boolean {
  return requested[key] === true;
}

/** Effective describes shipped behavior, not a promised complete
    feature: CSP is limited to deny-only policies; adaptive routing
    has an observational shadow gate only. Full guest execution and
    hybrid pre-execution rewriting remain inactive. */
export function experimentalSnapshot() {
  return {
    requested: { ...requested },
    effective: {
      adaptiveTransit: false,
      hybridLocation: false,
      cspTranslation: requested.cspTranslation,
      virtualSW: false,
    },
    status: {
      adaptiveTransit: requested.adaptiveTransit ? "shadow-only" : "disabled",
      hybridLocation: "not-wired",
      cspTranslation: requested.cspTranslation ? "deny-only" : "disabled",
      virtualSW: "not-implemented",
    } as const,
  };
}

/** Reject unknown keys and invalid values atomically. Never accept
    arbitrary nested object paths or prototype keys from an embedder. */
export function selectExperimental(input: unknown): { ok: boolean; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype) {
    return { ok: false, error: "experimental flags must be a plain boolean object" };
  }
  const o = input as Record<string, unknown>;
  const allowed: ReadonlySet<string> = new Set(EXPERIMENTAL_FLAGS);
  if (Object.keys(o).some(k => !allowed.has(k) || typeof o[k] !== "boolean")) {
    return { ok: false, error: "unknown or non-boolean experimental flag" };
  }
  const next = { ...requested };
  for (const k of EXPERIMENTAL_FLAGS) {
    if (Object.prototype.hasOwnProperty.call(o, k)) next[k] = o[k] as boolean;
  }
  requested = next;
  return { ok: true };
}

/** Test helper only. */
export function resetExperimentalForTests(): void { requested = defaults(); }
