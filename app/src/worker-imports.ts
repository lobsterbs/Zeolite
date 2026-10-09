/* Module-worker import specifier routing (Phase 13, 2.3 Selenide).

   Classic workers get importScripts routing in the prelude. Module
   workers cannot be patched that way: static import specifiers are
   resolved before the prelude (or any module code) runs, and import()
   is host syntax, not a patchable global. The service worker therefore
   rewrites import/export-from specifiers in the module worker body at
   serve time:

   - absolute http(s) specifiers become engine routes (otherwise they
     escape the engine as cross-origin requests that fail),
   - relative specifiers become engine routes too (they would resolve
     against the engine route and be recovered via the request
     referrer, but routing them here keeps every specifier one hop and
     consistent with the classic-worker story),
   - bare specifiers (node-style package names) pass through: without
     a resolver there is nothing honest to map them to (same
     documented limit as pages),
   - opaque (data:/blob:), engine-local and already-encoded engine
     routes pass through untouched (the decode-side unwrap peels any
     stale binding).

   #124: the matcher used to be one regex over the raw text, and its
   pattern could fire inside an ordinary string: "No matches from "
   .concat(w," payloads") - the regex paired the first string's
   closing quote with the next string's opening quote, swallowed the
   code between them as a "specifier" and replaced it with an engine
   route, which broke the whole script's parse (Twitch player-core
   ChunkLoadError). The matcher is now a quote-parity-aware scanner
   with the same context rules as the wasm literal pass (strings with
   escapes, line/block comments, the regex/division heuristic);
   specifiers are rewritten only in code context.

   Honest limits, all missed-rewrite (never corruption): template
   literals are opaque text to the pass (their ${...} expressions are
   not rewritten); from/import as property names (x.from = "...") are
   left alone; the regex/division discrimination is heuristic (same
   keyword/preceding-byte rule as the wasm scanner, tuned so false
   positives copy verbatim and false negatives only miss rewrites that
   the runtime bootstrap and decode-side referrer recovery still
   handle). */

import { encodeDest, isEnginePath, setScheme } from "./codec";

/** True for specifiers the pass must not touch. */
function passthrough(abs: URL, engineOrigin: string): boolean {
  if (abs.origin === engineOrigin) return true; // engine-local
  if (abs.protocol !== "http:" && abs.protocol !== "https:") return true; // opaque
  return false;
}

/** Route one module specifier into an engine route, or return it
    unchanged. Exported for tests. */
export function routeModuleSpecifier(
  prefix: string,
  workerUrl: string,
  engineOrigin: string,
  spec: string,
): string {
  /* Bare specifier: no scheme, not root- or dot-relative. */
  if (!/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith("/") && !spec.startsWith(".")) {
    return spec;
  }
  let abs: URL;
  try {
    abs = new URL(spec, workerUrl);
  } catch {
    return spec;
  }
  if (passthrough(abs, engineOrigin)) return spec;
  if (isEnginePath(abs.pathname)) return spec; // already a route: decode peels
  /* Encode in the LIVE prefix: this pass runs in the SW realm, where a
     zl:config rotation may have changed the shape; resetting to the
     default prefix here would flip every later encode (issue #20). */
  setScheme(prefix);
  return encodeDest(abs.href);
}

/* ---- #124: parity-aware scanner ------------------------------------ */

/* Keywords after which a '/' opens a regex literal, and the operator/
   punct bytes that allow one: the same discrimination the wasm
   literal pass uses (crates/rewriter/src/js/literals.rs). A false
   positive copies a span verbatim (missed rewrite); a false negative
   can corrupt parity, so the bias matches the wasm pass. */
const KEYWORDS = [
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "throw",
  "yield",
];
const REGEX_SIG = new Set(
  ["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "<", ">", "~"].map(
    (c) => c.charCodeAt(0),
  ),
);
const WS = new Set([" ", "\t", "\n", "\r", "\v", "\f"]);

function isIdStart(c: number): boolean {
  return c === 95 /* _ */ || c === 36 /* $ */ || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isIdPart(c: number): boolean {
  return isIdStart(c) || (c >= 48 && c <= 57);
}

/** Closing quote of the literal opened at `from` (exclusive start),
    or -1: EOF or a newline inside a normal string (malformed JS).
    Templates scan to their closing backtick: the whole template,
    including its substitutions, is opaque text. */
function findStringEnd(src: string, from: number, quote: number): number {
  for (let i = from; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 92 /* \\ */) {
      i++;
      continue;
    }
    if (c === quote) return i;
    if (quote !== 96 /* ` */ && (c === 10 || c === 13)) return -1;
  }
  return -1;
}

/** Closing '/' of a regex body starting after the opener, or -1 when a
    line break or EOF arrives first (division, not a regex). */
function findRegexEnd(src: string, from: number): number {
  let inClass = false;
  for (let i = from; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 92 /* \\ */) {
      i++;
      continue;
    }
    if (c === 91 /* [ */) inClass = true;
    else if (c === 93 /* ] */) inClass = false;
    else if ((c === 10 || c === 13) && !inClass) return -1;
    else if (c === 47 /* / */ && !inClass) return i;
  }
  return -1;
}

/** Can a '/' at the current position start a regex literal? Mirrors
    the wasm pass's last-significant-byte + keyword rule. */
function regexAllowed(lastSig: number, lastWord: string): boolean {
  return KEYWORDS.includes(lastWord) || REGEX_SIG.has(lastSig);
}

/** Position of the specifier's opening quote after a from/import
    keyword in code context, or -1. import may be followed by "(";
    whitespace (including newlines) may sit between. */
function peekSpecifierQuote(src: string, after: number, kw: string): number {
  let k = after;
  while (k < src.length && WS.has(src[k])) k++;
  if (kw === "import" && src.charCodeAt(k) === 40 /* ( */) {
    k++;
    while (k < src.length && WS.has(src[k])) k++;
  }
  const c = k < src.length ? src.charCodeAt(k) : 0;
  return c === 34 /* " */ || c === 39 /* ' */ ? k : -1;
}

/** Rewrite every import/export specifier in a module worker body.
    Pure: same input, same output. Parity-aware: string, comment,
    regex and template bodies are skipped verbatim, so a head keyword
    inside a string can never bridge two literals. */
export function rewriteModuleWorkerImports(
  prefix: string,
  workerUrl: string,
  engineOrigin: string,
  src: string,
): string {
  if (!src.includes("import") && !src.includes("from")) return src;
  const n = src.length;
  let out = "";
  let i = 0;
  let lastSig = 59; /* ';' - a regex may open a script */
  let lastWord = "";
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 47 /* / */) {
      const next = i + 1 < n ? src.charCodeAt(i + 1) : 0;
      if (next === 47 /* / */) {
        const nl = src.indexOf("\n", i);
        if (nl === -1) {
          out += src.slice(i);
          break;
        }
        out += src.slice(i, nl);
        i = nl;
        continue;
      }
      if (next === 42 /* * */) {
        const end = src.indexOf("*/", i + 2);
        if (end === -1) {
          out += src.slice(i);
          break;
        }
        out += src.slice(i, end + 2);
        i = end + 2;
        continue;
      }
      if (regexAllowed(lastSig, lastWord)) {
        const end = findRegexEnd(src, i + 1);
        if (end !== -1) {
          out += src.slice(i, end + 1);
          i = end + 1;
          lastSig = 120; /* 'x' - a regex literal is a value */
          lastWord = "";
          continue;
        }
        /* No closing '/' before a line break: not a regex. The probed
           bytes were only looked at; fall through as division. */
      }
      out += src[i];
      i++;
      lastSig = c;
      lastWord = "";
      continue;
    }
    if (c === 34 || c === 39 || c === 96) {
      const end = findStringEnd(src, i + 1, c);
      if (end !== -1) {
        out += src.slice(i, end + 1);
        i = end + 1;
        lastSig = 120; /* a string literal is a value */
        lastWord = "";
        continue;
      }
      if (c === 96) {
        /* Unterminated template: the remainder is the template's text;
           nothing after it can be rewritten. */
        out += src.slice(i);
        break;
      }
      /* Unterminated normal quote: treat the opener as a plain byte
         (the wasm scanner's recover) so one malformed literal cannot
         poison the rest of the file. */
      out += src[i];
      i++;
      lastSig = c;
      lastWord = "";
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src.charCodeAt(j))) j++;
      const run = src.slice(i, j);
      /* Property access (x.from, x.import) is not an import head. */
      if ((run === "from" || run === "import") && lastSig !== 46 /* . */) {
        const q = peekSpecifierQuote(src, j, run);
        if (q !== -1) {
          const end = findStringEnd(src, q + 1, src.charCodeAt(q));
          if (end !== -1) {
            const spec = src.slice(q + 1, end);
            const routed = routeModuleSpecifier(prefix, workerUrl, engineOrigin, spec);
            if (routed !== spec) {
              out += src.slice(i, q) + src[q] + routed + src[q];
              i = end + 1;
              lastSig = 120;
              lastWord = "";
              continue;
            }
          }
        }
      }
      out += run;
      lastSig = 120; /* an identifier is a value */
      lastWord = run.length <= 12 ? run : "";
      i = j;
      continue;
    }
    out += src[i];
    i++;
    if (!WS.has(src[i - 1])) {
      lastSig = c;
      lastWord = "";
    }
  }
  return out;
}
