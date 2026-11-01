/* Ghostery cosmetic CSS selector injection (#551, first slice).

   Scope of this slice: the `styles` arm of the engine's
   getCosmeticsFilters for the DOCUMENT URL only, computed in the
   service worker at document-rewrite time and spliced into the
   rewritten stream head as a single <style data-zl-cosmetic> element
   (the same after-doctype splice the bootstrap init script rides).

   Never applied, by design of this slice:
   - scriptlets (+js(...)): counted, refused, never executed;
   - extended/HTML filters (:has()-style AST arms, :-abp-contains,
     element removal): counted, refused;
   - class/id/href-anchored generic hides that need DOM feature
     extraction (getRulesFromDOM): the SW has no DOM at rewrite time,
     so the engine query runs with getRulesFromDOM=false and those
     rules stay dormant;
   - re-injection on dynamic DOM mutations (the engine's
     lifecycle="dom-update" half): follow-up work;
   - frame-ancestor-constrained rules: the frame chain is not tracked
     SW-side, so ancestors stays empty.

   The gate mirrors network blocking exactly (rules.ts applyRules):
   the zl:adblock toggle, the per-site zl:rules adblock override, and
   the shipped captcha/anti-bot allowlist (challenge-provider
   allowlists take precedence over cosmetics - the same single
   compiled allow list the block evaluation consults, never a copy).

   Diagnostics: at most ONE bounded REWRITE event per document with
   aggregate counts only - no selectors, no page content; anything
   URL-shaped passes through redactSecrets on emit. */

import { getDomain } from "tldts";
import type { FiltersEngine } from "@ghostery/adblocker";
import { DIAG } from "./diag";
import {
  allowlistedHostFor,
  isRulesEnabled,
  siteOverrideFor,
  type CompiledRules,
} from "./rules";
import { ghosteryEngine, requestType } from "./ghostery";

/** Cap for the injected stylesheet (#551). A compiled EasyList-scale
    stylesheet for one site is a few KiB; 64 KiB is generous headroom.
    A larger stylesheet truncates at a rule boundary is NOT attempted -
    CSS error recovery drops the incomplete tail rule, and the DIAG
    event records the truncation honestly. */
export const COSMETIC_STYLE_CAP = 64 * 1024;

export interface CosmeticOutcome {
  /** Compiled stylesheet text, truncated to COSMETIC_STYLE_CAP when
      truncated=true. Empty when nothing applies. */
  styles: string;
  /** Matched hide/style filters the engine compiled into the styles
      arm (exception-free). Generic rules folded into the engine's
      precompiled base stylesheet do not arrive as per-call matches;
      the event wording says "+base stylesheet" for them. */
  applied: number;
  /** Matched but suppressed by an exception rule (@# / #@#). */
  skipped: number;
  /** Scriptlet (+js) and extended-selector matches: counted, never
      executed or compiled. */
  unsupported: number;
  truncated: boolean;
}

/** Structural engine surface this module uses; the real FiltersEngine
    satisfies it and tests can build one with FiltersEngine.parse. */
export interface CosmeticEngineLike {
  getCosmeticsFilters(opts: {
    url: string;
    hostname: string;
    domain: string | null | undefined;
    ancestors?: { domain: string; hostname: string }[];
    classes?: string[];
    hrefs?: string[];
    ids?: string[];
    getBaseRules?: boolean;
    getInjectionRules?: boolean;
    getExtendedRules?: boolean;
    getRulesFromDOM?: boolean;
    getRulesFromHostname?: boolean;
    callerContext?: unknown;
  }): { active?: boolean; styles?: string; scripts?: string[]; extended?: unknown[] };
  /* The adblocker EventEmitter types its callbacks per event-name
     generic; `any` keeps the seam structural for the real engine and
     stand-ins alike. */
  on?(event: string, cb: (match: any, ctx: any) => void): void;
  unsubscribe?(event: string, cb: (match: any, ctx: any) => void): void;
}

interface CosmeticFilterLike {
  isScriptInject: () => boolean;
  isExtended: () => boolean;
  getId: () => number;
}

interface CosmeticMatch {
  filter?: CosmeticFilterLike;
  exception?: unknown;
}

interface CosmeticMatchContext {
  url?: string;
  /* The adblocker versions this filterType as a numeric enum
     (COSMETIC = 2); number keeps the comparison honest. */
  filterType?: string | number;
}

/** Compute the cosmetic styles for one document URL against one
    engine. Returns null when the engine has no cosmetic data active.
    Counts ride the engine's own filter-matched events (filtered to
    this URL, deduplicated by filter id), so the engine's matching and
    exception logic stays the single source of truth - nothing here
    re-implements selector matching. The engine emits asynchronously
    (microtask), so the counts settle one microtask after the call. */
export async function computeCosmeticStyles(
  eng: CosmeticEngineLike,
  docUrl: string,
): Promise<CosmeticOutcome | null> {
  let u: URL;
  try {
    u = new URL(docUrl);
  } catch {
    return null;
  }
  const hostname = u.hostname.toLowerCase();
  if (!hostname) return null;
  /* tldts gives the eTLD+1 the engine's domain/entity constraints
     want (cookies.ts uses the same dependency). */
  const domain = getDomain(hostname) ?? "";
  const appliedIds = new Set<number>();
  const skippedIds = new Set<number>();
  const unsupportedIds = new Set<number>();
  const cb = (m: CosmeticMatch, ctx: CosmeticMatchContext): void => {
    /* filterType is a NUMERIC enum in this adblocker version
       (lists.js: NETWORK=1, COSMETIC=2); the URL filter scopes the
       counts to this document so a concurrent engine query cannot
       pollute them. */
    if (ctx?.filterType !== 2 || ctx?.url !== docUrl) return;
    if (m.exception !== undefined && m.exception !== null) {
      if (m.filter) skippedIds.add(m.filter.getId());
      return;
    }
    const f = m.filter;
    if (!f) return;
    /* Scriptlet and extended arms are counted, never compiled. */
    if (f.isScriptInject?.() || f.isExtended?.()) unsupportedIds.add(f.getId());
    else appliedIds.add(f.getId());
  };
  eng.on?.("filter-matched", cb);
  let out: { active?: boolean; styles?: string; scripts?: string[]; extended?: unknown[] };
  try {
    out = eng.getCosmeticsFilters({
      url: docUrl,
      hostname,
      domain,
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: true,
      /* No DOM at rewrite time: class/id/href-anchored rules stay
         dormant (honest limit of this slice, see header). */
      getRulesFromDOM: false,
      getRulesFromHostname: true,
      callerContext: "zl-cosmetics",
    });
    /* The engine dispatches filter-matched via queueMicrotask: the
       queued emits must run BEFORE the listener detaches (the
       dispatcher iterates the live listener array), so the settle
       await lives inside the try, ahead of the unsubscribe. One turn
       suffices: the engine's emit task was enqueued before this
       continuation. */
    await Promise.resolve();
  } finally {
    eng.unsubscribe?.("filter-matched", cb);
  }
  if (out.active === false) return null;
  let styles = typeof out.styles === "string" ? out.styles : "";
  let truncated = false;
  if (styles.length > COSMETIC_STYLE_CAP) {
    styles = styles.slice(0, COSMETIC_STYLE_CAP);
    truncated = true;
  }
  return {
    styles,
    applied: appliedIds.size,
    skipped: skippedIds.size,
    unsupported: unsupportedIds.size,
    truncated,
  };
}

/** The injected markup. The stylesheet text is engine output, but the
    splice is raw HTML: neutralize the one sequence that could escape
    the <style> element (`</style`), preserving the CSS bytes a
    selector like that would never legitimately contain. */
export function cosmeticStyleTag(styles: string): string {
  if (!styles.trim()) return "";
  const safe = styles.replace(/<\/(style)/gi, "<\\/$1");
  return `<style data-zl-cosmetic>${safe}</style>`;
}

/** The document-rewrite seam (#551): gate, compute, diagnose, and
    return the <style data-zl-cosmetic> markup to splice into the
    rewrite head, or "" when cosmetics do not apply. The gate mirrors
    rules.ts applyRules for the document host: the zl:adblock toggle,
    the per-site adblock override, and the captcha/anti-bot allowlist
    all refuse cosmetics exactly like they spare network requests. */
export async function ghosteryCosmeticsForDocument(
  engineRules: CompiledRules,
  docUrl: string,
  destination: string,
  traceId?: string,
): Promise<string> {
  if (!isRulesEnabled()) return "";
  /* Challenge-provider allowlists take precedence over cosmetics. */
  if (allowlistedHostFor(engineRules, docUrl, "document") !== null) return "";
  if (siteOverrideFor(docUrl)?.adblock === false) return "";
  const eng = ghosteryEngine();
  if (!eng) return "";
  const outcome = await computeCosmeticStyles(eng, docUrl);
  if (!outcome) return "";
  /* One bounded event per document, and only when something actually
     happened (a silent all-zero row per navigation would flood the
     512-event ring with noise). */
  if (outcome.applied > 0 || outcome.skipped > 0 || outcome.unsupported > 0 || outcome.truncated) {
    const rtype = requestType("document", destination);
    DIAG.emit({
      traceId,
      requestId: traceId,
      category: "REWRITE",
      cause: "rewrite",
      severity: "info",
      stage: "REWRITE_STARTED",
      message:
        "ghostery cosmetic styles for " + rtype + ": " +
        outcome.applied + " applied (+base stylesheet), " +
        outcome.skipped + " skipped by exception, " +
        outcome.unsupported + " unsupported (scriptlets/extended, never executed), " +
        outcome.styles.length + " bytes" +
        (outcome.truncated ? ", truncated at " + COSMETIC_STYLE_CAP + " bytes" : ""),
      url: docUrl,
    });
  }
  if (!outcome.styles.trim()) return "";
  return cosmeticStyleTag(outcome.styles);
}
