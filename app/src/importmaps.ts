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

export interface ImportmapRegistry {
  /** pageKey -> (specifier -> mapped target) */
  pages: Map<string, Map<string, string | string[] | null>>;
}

export function newImportmapRegistry(): ImportmapRegistry {
  return { pages: new Map() };
}

/** Record the import map body of one document (raw upstream
    JSON). A re-served page replaces its own entry; the registry
    drops the oldest page at the cap. Invalid JSON, a non-object
    root, or an imports member that is not an object records
    nothing. */
export function importmapNote(reg: ImportmapRegistry, pageKey: string, bodyText: string): void {
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return;
  const imports = (doc as { imports?: unknown }).imports;
  if (typeof imports !== "object" || imports === null || Array.isArray(imports)) return;
  const entries = new Map<string, string | string[] | null>();
  for (const [k, v] of Object.entries(imports)) {
    if (v === null) entries.set(k, null);
    else if (typeof v === "string") entries.set(k, v);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) entries.set(k, v as string[]);
    else continue;
    if (entries.size >= IMPORTMAP_ENTRIES_CAP) break;
  }
  if (entries.size === 0) return;
  if (reg.pages.has(pageKey)) reg.pages.delete(pageKey);
  else if (reg.pages.size >= IMPORTMAP_PAGES_CAP) {
    const oldest = reg.pages.keys().next().value;
    if (oldest !== undefined) reg.pages.delete(oldest);
  }
  reg.pages.set(pageKey, entries);
}

/** Resolve a bare specifier through the recorded page map:
    exact key first, then the longest trailing-slash prefix key
    with the remainder appended to the mapped value (spec order
    for string values). Returns the ABSOLUTE target URL, or
    null (no match, the block form, or every fallback failed to
    resolve): the caller leaves the specifier bare and the load
    fails natively. */
export function resolveBareImport(reg: ImportmapRegistry, pageKey: string, spec: string): string | null {
  const m = reg.pages.get(pageKey);
  if (!m) return null;
  const resolveTarget = (v: string | string[] | null, append: string): string | null => {
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
  let bestVal: string | string[] | null = null;
  for (const [k, v] of m) {
    if (k.endsWith("/") && k.length > bestKey.length && spec.startsWith(k)) {
      bestKey = k;
      bestVal = v;
    }
  }
  if (!bestKey) return null;
  return resolveTarget(bestVal, spec.slice(bestKey.length));
}
