/* #554: import-map awareness for module workers (the TS side).

   The wasm rewriter rewrites import map BODIES (values and
   URL-like keys ride engine routes), so resolution keeps
   working for specifiers the page itself imports. But a MODULE
   WORKER created by the page resolves its own bare specifiers
   against the import map of the owning page, and the worker
   script serve seam has no map: the browser fails the load
   natively. This module records the imports map of each served
   document (keyed by the page-space URL of the page, the string
   the browser commits and later reports as the referrer of the
   worker request) and resolves bare worker specifiers through
   it at the serve seam.

   Honest limits:
   - Only top-level imports is honored. Scope resolution needs
     the URL of the importing module, which the serve seam does
     not know for a worker body; scoped bare specifiers stay
     bare and fail natively, exactly as before #554.
   - The registry is memory-only per SW lifetime; a worker
     restart loses the maps and later workers fall back to the
     native failure.
   - Resolution is exact-key first, then the longest
     trailing-slash prefix key, mirroring the spec order for
     string values. A mapped target that fails to resolve (or
     is the block form null) leaves the specifier bare: native
     failure, no invented resolution. */

/** Document scan bounds, mirroring sri.ts. */
export const IMPORTMAP_SCAN_TEXT_MAX = 256 * 1024;
export const IMPORTMAP_BODY_CAP = 256 * 1024;
export const IMPORTMAP_PAGES_CAP = 64;
export const IMPORTMAP_ENTRIES_CAP = 256;

/** Attribute value of one open tag, or null. Cheap regex
    parse: the type check only needs the attribute text, and a
    type value never carries spaces before its parameters. */
function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp("(?:^|\\s)" + name + "[\\s]*=[\\s]*([^\\s>]+)", "i"));
  if (!m) return null;
  let v = m[1];
  if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** The page-space key for a served document or a worker
    referrer: the absolute URL with the fragment stripped (a
    navigation request never carries one; the committed URL a
    worker sees as referrer may). */
export function pageKeyOf(url: string, origin: string): string | null {
  try {
    const u = new URL(url, origin);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export interface ImportmapScanner {
  feed(text: string): void;
}

/** Incremental scan of the decoded upstream text of a served
    document, the same walking shape as sriScanner:
    chunk-boundary safe, bounded. Fires the note callback once
    per import map BODY (raw text: JSON bodies carry no
    attributes, so no entity decoding). The upstream body is
    pre-rewrite, so the recorded map keeps its upstream URLs;
    the serve seam encodes at resolve time with the LIVE
    prefix. */
export function importmapScanner(note: (body: string) => void): ImportmapScanner {
  let pending = "";
  let fed = 0;
  let capturing = false;
  let truncated = false;
  let body = "";
  let done = false;
  return {
    feed(text: string): void {
      if (done) return;
      pending += text;
      fed += text.length;
      for (;;) {
        if (!capturing) {
          const lt = pending.indexOf("<");
          if (lt === -1) {
            pending = "";
            break;
          }
          const gt = pending.indexOf(">", lt);
          if (gt === -1) {
            pending = pending.slice(lt);
            if (pending.length > 65536) pending = "";
            break;
          }
          const tag = pending.slice(lt, gt + 1);
          if (/^<\s*script\b/i.test(tag)) {
            const tv = attrValue(tag, "type");
            const t = tv ? tv.split(";")[0].trim().toLowerCase() : "";
            if (t === "importmap") {
              capturing = true;
              truncated = false;
              body = "";
            }
          }
          pending = pending.slice(gt + 1);
          continue;
        }
        const m = /<\/script/i.exec(pending);
        if (m) {
          body += pending.slice(0, m.index);
          pending = pending.slice(m.index);
          if (!truncated && body.length <= IMPORTMAP_BODY_CAP) note(body);
          capturing = false;
          body = "";
          continue;
        }
        /* No close tag yet: capture, but hold back the tail
           that could still grow into a close tag. */
        const hold = Math.min(8, pending.length);
        body += pending.slice(0, pending.length - hold);
        if (body.length > IMPORTMAP_BODY_CAP) truncated = true;
        pending = pending.slice(pending.length - hold);
        break;
      }
      if (fed >= IMPORTMAP_SCAN_TEXT_MAX) done = true;
    },
  };
}

/* ---- per-page registry (memory-only, SW lifetime) ---- */

/** One mapped target: null is the block form; an array is the
    fallback-addresses form (the first http(s) address resolves,
    no probing). */
export type MappedTarget = string | string[] | null;

/** A page's merged import-map state: the top-level imports plus
    every scope's map, keyed by the RESOLVED absolute scope
    prefix (always trailing "/"). */
export interface PageImportmap {
  imports: Map<string, MappedTarget>;
  scopes: Map<string, Map<string, MappedTarget>>;
}

export interface ImportmapRegistry {
  /** pageKey -> merged map state */
  pages: Map<string, PageImportmap>;
}

/** Scope-map cap: the merged per-page scope count. */
export const IMPORTMAP_SCOPES_CAP = 32;

export function newImportmapRegistry(): ImportmapRegistry {
  return { pages: new Map() };
}

/** A string the URL grammar treats as hierarchical rather than as
    a bare package name: absolute, scheme-relative, root- or
    dot-relative, or a same-document reference. Chromium ignores
    an import map rule whose value is a bare specifier ("Ignored
    an import map value of ...: Bare specifier", observed in a
    direct-browser probe); the registry mirrors that instead of
    resolving a bare value against the page and inventing a URL
    the browser would never load. */
function isUrlLike(s: string): boolean {
  return /^[a-z][a-z0-9+.\-]*:/i.test(s) || s.startsWith("/") || s.startsWith(".") ||
    s.startsWith("#") || s.startsWith("?");
}

/** Validate one mapped target. Returns undefined for a shape the
    browser would ignore (bare-specifier value, empty fallback
    array, non-string members). */
function mapTarget(v: unknown): MappedTarget | undefined {
  if (v === null) return null;
  if (typeof v === "string") return isUrlLike(v) ? v : undefined;
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && isUrlLike(x as string))) {
    return v as string[];
  }
  return undefined;
}

/** Collect one map object's entries (top-level imports or one
    scope's map) under the entries cap. First valid definition
    wins within the object; invalid rules are skipped. */
function collectEntries(obj: Record<string, unknown>, cap: number): Map<string, MappedTarget> {
  const m = new Map<string, MappedTarget>();
  for (const [k, v] of Object.entries(obj)) {
    const t = mapTarget(v);
    if (t === undefined) continue;
    m.set(k, t);
    if (m.size >= cap) break;
  }
  return m;
}

/** Resolve a scope key the way the browser normalizes one: parse
    against the document base, require http(s), force the
    trailing slash. Null when the key cannot normalize. */
function normalizeScopeKey(pageKey: string, raw: string): string | null {
  try {
    const u = new URL(raw, pageKey);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.href.endsWith("/")) return u.href + "/";
    return u.href;
  } catch {
    return null;
  }
}

/** Forget one page's merged map state. request.ts calls this when
    a navigation for the page key starts, so a re-served document
    rebuilds its maps from scratch instead of merging with the
    previous document's leftovers (a fresh document owns fresh
    maps; multiple maps WITHIN one document merge below). */
export function importmapReset(reg: ImportmapRegistry, pageKey: string): void {
  reg.pages.delete(pageKey);
}

/** Record one import map body into the page's merged state.
    Multiple maps within one document MERGE (direct-Chromium
    probe: a later map's NEW keys resolve; a redefined key keeps
    the FIRST mapping with a console warning; an invalid map
    never poisons later maps). The registry drops the oldest
    page at the cap. */
export function importmapNote(reg: ImportmapRegistry, pageKey: string, bodyText: string): void {
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return;
  const d = doc as { imports?: unknown; scopes?: unknown };
  const importsObj = d.imports;
  const scopesObj = d.scopes;
  const hasImports = typeof importsObj === "object" && importsObj !== null && !Array.isArray(importsObj);
  const hasScopes = typeof scopesObj === "object" && scopesObj !== null && !Array.isArray(scopesObj);
  if (!hasImports && !hasScopes) return;
  let page = reg.pages.get(pageKey);
  if (!page) {
    if (reg.pages.size >= IMPORTMAP_PAGES_CAP) {
      const oldest = reg.pages.keys().next().value;
      if (oldest !== undefined) reg.pages.delete(oldest);
    }
    page = { imports: new Map(), scopes: new Map() };
    reg.pages.set(pageKey, page);
  }
  if (hasImports) {
    for (const [k, v] of collectEntries(importsObj as Record<string, unknown>, IMPORTMAP_ENTRIES_CAP)) {
      if (!page.imports.has(k)) {
        if (page.imports.size >= IMPORTMAP_ENTRIES_CAP) break;
        page.imports.set(k, v);
      }
    }
  }
  if (hasScopes) {
    for (const [rawScope, mapObj] of Object.entries(scopesObj as Record<string, unknown>)) {
      if (page.scopes.size >= IMPORTMAP_SCOPES_CAP) break;
      /* The scope KEY must be a URL (resolved against the map
         base); its value must be a map object. */
      if (typeof mapObj !== "object" || mapObj === null || Array.isArray(mapObj)) continue;
      const prefix = normalizeScopeKey(pageKey, rawScope);
      if (!prefix) continue;
      /* First registration of a scope wins; a later map that
         redefines the whole scope is ignored, like a redefined
         top-level key. */
      if (page.scopes.has(prefix)) continue;
      page.scopes.set(prefix, collectEntries(mapObj as Record<string, unknown>, IMPORTMAP_ENTRIES_CAP));
    }
  }
}

/** Resolve one specifier inside ONE map. Three-state result:
    the ABSOLUTE target URL on a resolved hit; null when a rule
    MATCHED but is the block form or failed to resolve (the map
    spoke: the answer is "fail natively"); undefined when no key
    in the map matches (the caller may cascade to the next map). */
function resolveIn(m: Map<string, MappedTarget>, spec: string, pageKey: string): string | null | undefined {
  const resolveTarget = (v: MappedTarget, append: string): string | null => {
    if (v === null) return null;
    const list = Array.isArray(v) ? v : [v];
    for (const s of list) {
      try {
        const u = new URL(s + append, pageKey);
        if (u.protocol === "http:" || u.protocol === "https:") return u.href;
      } catch {
        /* try the next fallback */
      }
    }
    return null;
  };
  const exact = m.get(spec);
  if (exact !== undefined) return resolveTarget(exact, "");
  let bestKey = "";
  let bestVal: MappedTarget | undefined;
  for (const [k, v] of m) {
    if (k.endsWith("/") && k.length > bestKey.length && spec.startsWith(k)) {
      bestKey = k;
      bestVal = v;
    }
  }
  if (!bestKey) return undefined;
  return resolveTarget(bestVal as MappedTarget, spec.slice(bestKey.length));
}

/** Resolve a bare specifier the way the browser would for a module
    whose importing URL is importerUrl, through the owning page's
    recorded map (direct-Chromium probe, suite scripts/
    importmap-scopes probe):

    - scopes whose resolved prefix contains the importer apply,
      LONGEST first (a /sub/deep/ importer resolves through
      /sub/deep/, then /sub/, then top-level - verified cascade);
    - within one map: exact key, then longest prefix key;
    - a matched rule decides: a block form or an unresolvable
      target ends the try with null (the most specific map spoke;
      a less specific map never resurrects a blocked specifier);
    - NO matching scope, or every matched map missing the key,
      falls through to the top-level imports;
    - scope maps never leak upward: a root importer never sees a
      scope-only key (probe: root import of a scope-only key
      fails natively).

    importerUrl may be empty/unknown: top-level imports only (the
    pre-#554-scopes behavior). Returns the ABSOLUTE target URL or
    null: the caller leaves the specifier bare and the load fails
    natively, never an invented route. */
export function resolveBareImportFor(
  reg: ImportmapRegistry,
  pageKey: string,
  importerUrl: string | null,
  spec: string,
): string | null {
  const page = reg.pages.get(pageKey);
  if (!page) return null;
  if (importerUrl) {
    /* Matching scopes longest-first; a scope whose map holds NO
       matching key cascades to the next scope, then top-level. */
    const prefixes = [...page.scopes.keys()]
      .filter((p) => importerUrl.startsWith(p))
      .sort((a, b) => b.length - a.length);
    for (const p of prefixes) {
      const hit = resolveIn(page.scopes.get(p) as Map<string, MappedTarget>, spec, pageKey);
      if (hit !== undefined) return hit;
    }
  }
  return resolveIn(page.imports, spec, pageKey) ?? null;
}

/** Resolve a bare specifier through the recorded page map's
    TOP-LEVEL imports only (the importer-unknown path; no scope
    application). Kept for callers and tests that predate
    importer-aware resolution. */
export function resolveBareImport(reg: ImportmapRegistry, pageKey: string, spec: string): string | null {
  const page = reg.pages.get(pageKey);
  if (!page) return null;
  return resolveIn(page.imports, spec, pageKey) ?? null;
}
