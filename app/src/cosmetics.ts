/* Ghostery cosmetic CSS selector injection (#551, first slice).

   Scope of this slice: the `styles` arm of the engine's
   getCosmeticsFilters for the DOCUMENT URL only, computed in the
   service worker at document-rewrite time and spliced into the
   rewritten stream head as a single <style data-zl-cosmetic> element
   (the same after-doctype splice the bootstrap init script rides).

   Second slice (#551): the page runtime (cosmetic-page.ts, compiled
   to cosmetics-runtime.js) rides inline right after the style tag
   with one __zlCosmeticRun(payload) call, so:
   - scriptlets: the four allowlisted names (set-constant,
     abort-on-property-read, abort-on-property-write, noop) run in
     the page, bounded (16 per document, 4 args of 256 chars,
     4-part property chains); every other scriptlet stays counted
     and refused. The wasm arm refuses ALL scriptlets
     (docs/filter-compat.md);
   - extended/HTML filters (:has()-style AST arms, :-abp-contains,
     element removal): still counted, refused;
   - class/id-anchored generic hides: the runtime collects DOM tokens
     and asks the worker (zl:cosmeticTokens, cosmetic-tokens.ts),
     which re-applies every gate and answers from the same engine
     instance; the worker derives the document URL from the sender
     route, never a page claim;
   - re-injection on dynamic DOM mutations: the runtime's bounded
     MutationObserver loop (24 queries per document, 750 ms debounce);
   - frame-ancestor-constrained rules: the frame chain is not tracked
     SW-side, so ancestors stays empty.

   The gate mirrors network blocking exactly (rules.ts applyRules):
   the zl:adblock toggle, the per-site zl:rules adblock override, and
   the shipped captcha/anti-bot allowlist (challenge-provider
   allowlists take precedence over cosmetics - the same single
   compiled allow list the block evaluation consults, never a copy).

   #613 wasm arm: when the Rust/WASM adblock engine installed, the
   decision comes from its cosmetic(url) JSON (page-specific hide
   selectors, generichide, scriptlet refusal counts). Generic
   class/id hides (the crate hidden_css) stay dormant in this
   slice: the SW has no DOM tokens at head-splice time, the same
   honest limit as the TS arm DOM-anchored rules, and the TS
   fallback keeps its precompiled generic base stylesheet.

   Diagnostics: at most ONE bounded REWRITE event per document per
   arm (the static row at rewrite time, the dynamic row at the page
   runtime's done report) with aggregate counts only - no selectors,
   no page content; anything URL-shaped passes through redactSecrets
   on emit. */

import { getDomain } from "tldts";
import type { FiltersEngine } from "@ghostery/adblocker";
import { DIAG } from "./diag";
import {
  allowlistedHostFor,
  isRulesEnabled,
  siteOverrideFor,
  type CompiledRules,
} from "./rules";
import { ghosteryEngine, requestType, wasmAdblockEngine } from "./ghostery";
import type { WasmAdblockLike } from "./adblockwasm";

/** Cap for the injected stylesheet (#551). A compiled EasyList-scale
    stylesheet for one site is a few KiB; 64 KiB is generous headroom.
    A larger stylesheet truncates at a rule boundary is NOT attempted -
    CSS error recovery drops the incomplete tail rule, and the DIAG
    event records the truncation honestly. */
export const COSMETIC_STYLE_CAP = 64 * 1024;

/** One allowlisted scriptlet for the page runtime (#551 second
    slice). The worker parses and validates; the page core
    (cosmetic-page.ts) owns its own copy of the shape so the page
    artifact never imports service-worker modules. */
export interface ScriptletInvocation {
  name: string;
  args: string[];
}

/* The only scriptlet names the page runtime implements, and the
   only ones this module forwards. The adblocker-compiled script
   bodies are never evaluated: this allowlist is the threat boundary
   (docs/filter-compat.md). */
const SCRIPTLET_ALLOWLIST: ReadonlySet<string> = new Set([
  "set-constant",
  "abort-on-property-read",
  "abort-on-property-write",
  "noop",
]);
const SCRIPTLET_ARG_MAX = 4;
const SCRIPTLET_ARG_LEN = 256;

/** Parse one +js body ("set-constant, name, 1") into a bounded
    invocation, or null for any non-allowlisted name (the caller
    counts those unsupported). */
export function parseScriptlet(text: unknown): ScriptletInvocation | null {
  if (typeof text !== "string" || !text) return null;
  const parts = text.split(",").map((p) => p.trim());
  let name = parts.shift() ?? "";
  if (name.endsWith(".js")) name = name.slice(0, -3);
  if (!SCRIPTLET_ALLOWLIST.has(name)) return null;
  const args = parts.slice(0, SCRIPTLET_ARG_MAX).map((a) => a.slice(0, SCRIPTLET_ARG_LEN));
  return { name, args };
}

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
      executed or compiled. Non-allowlisted scriptlets and all
      extended selectors stay here; allowlisted names move to the
      scriptlets array. */
  unsupported: number;
  /** Allowlisted scriptlet invocations for the page runtime (the TS
      arm parses them; the wasm arm refuses all scriptlets). */
  scriptlets: ScriptletInvocation[];
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
  /* For a script-inject filter this carries the raw +js body
     ("set-constant, name, 1"); the scriptlet tests pin the
     behavior against the installed engine. */
  getSelector?: () => string;
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
  const scriptletMap = new Map<number, ScriptletInvocation>();
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
    /* Allowlisted scriptlets move to the runtime payload; every
       other scriptlet and every extended selector stays counted,
       never compiled. */
    if (f.isScriptInject?.()) {
      const inv = parseScriptlet(f.getSelector?.());
      if (inv) scriptletMap.set(f.getId(), inv);
      else unsupportedIds.add(f.getId());
    } else if (f.isExtended?.()) {
      unsupportedIds.add(f.getId());
    } else {
      appliedIds.add(f.getId());
    }
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
    scriptlets: [...scriptletMap.values()],
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

/* The compiled page runtime (#551 second slice), fetched once per
   worker lifetime; worker-own fetches never re-enter the fetch
   handler (the dominspect.js pattern). */
let runtimeSource: Promise<string | null> | null = null;
function loadCosmeticRuntime(): Promise<string | null> {
  /* Promise.resolve first: in non-worker contexts (vitest) self or
     self.location may be undefined and the URL constructor throws
     synchronously; the chain then resolves null and the tag is
     omitted, exactly like an unavailable artifact. */
  runtimeSource ??= Promise.resolve()
    .then(() => fetch(new URL("cosmetics-runtime.js", self.location.href)))
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  return runtimeSource;
}

/** The inline runtime tag: the artifact body plus one
    __zlCosmeticRun(payload) call. Every "<" in the JSON payload is
    escaped (a scriptlet arg could otherwise close the element
    early); the body is our own esbuild output, and a body that
    somehow contains a script-closing sequence is dropped whole
    rather than spliced. Returns "" when the artifact is
    unavailable: the static arm then still ships alone. */
export async function cosmeticRuntimeTag(scriptlets: ScriptletInvocation[]): Promise<string> {
  const src = await loadCosmeticRuntime();
  if (src === null) return "";
  if (src.toLowerCase().includes("</" + "script")) return "";
  const BS = String.fromCharCode(92);
  const payload = JSON.stringify({ s: scriptlets }).split("<").join(BS + "u003c");
  return "<script data-zl-cosmetic-run>" + src + ";__zlCosmeticRun(" + payload + ");</script>";
}

/* #613 wasm arm: the Rust engine answers one cosmetic query per
    document URL; its JSON crosses the boundary once. Exception-
    skipped selectors are already folded out by the engine, so
    skipped stays 0. */
export function wasmCosmeticOutcome(
  wasm: WasmAdblockLike,
  docUrl: string,
): CosmeticOutcome | null {
  let dec: { active?: boolean; style?: string; unsupported?: number };
  try {
    dec = JSON.parse(wasm.cosmetic(docUrl));
  } catch {
    return null;
  }
  if (dec.active !== true) return null;
  let styles = typeof dec.style === "string" ? dec.style : "";
  let truncated = false;
  if (styles.length > COSMETIC_STYLE_CAP) {
    styles = styles.slice(0, COSMETIC_STYLE_CAP);
    truncated = true;
  }
  /* Every compiled rule ends with the literal hide body, so the
     applied count needs no selector parsing. */
  const applied = styles.split("{display:none!important}").length - 1;
  return {
    styles,
    applied,
    skipped: 0,
    unsupported: dec.unsupported ?? 0,
    /* The wasm arm refuses all scriptlets; they are already counted
       in dec.unsupported (docs/filter-compat.md). */
    scriptlets: [],
    truncated,
  };
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
  const wasm = wasmAdblockEngine();
  let outcome: CosmeticOutcome | null;
  if (wasm) {
    outcome = wasmCosmeticOutcome(wasm, docUrl);
  } else {
    const eng = ghosteryEngine();
    if (!eng) {
      /* Lists not loaded yet: the static arm stays silent, but the
         runtime still rides, so the dynamic arm can pick the
         document up once the lists land (its first query answers
         pending and it retries once). */
      return cosmeticRuntimeTag([]);
    }
    outcome = await computeCosmeticStyles(eng, docUrl);
  }
  if (!outcome) {
    /* No cosmetic data for this URL (engine not loaded, inactive,
       or a bad URL): the runtime still rides, because generic
       class/id rules are decided per DOM token at runtime, not at
       rewrite time; with an empty payload it only runs the token
       loop. */
    return cosmeticRuntimeTag([]);
  }
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
        (wasm ? "adblock wasm" : "ghostery") + " cosmetic styles for " + rtype + ": " +
        outcome.applied + (wasm ? " applied, " : " applied (+base stylesheet), ") +
        outcome.skipped + " skipped by exception, " +
        outcome.unsupported + " unsupported, " +
        outcome.scriptlets.length + " allowlisted scriptlets" +
        (wasm ? " (wasm arm refuses scriptlets), " : ", ") +
        outcome.styles.length + " bytes" +
        (outcome.truncated ? ", truncated at " + COSMETIC_STYLE_CAP + " bytes" : ""),
      url: docUrl,
    });
  }
  const styleTag = cosmeticStyleTag(outcome.styles);
  const runtimeTag = await cosmeticRuntimeTag(outcome.scriptlets);
  return styleTag + runtimeTag;
}
