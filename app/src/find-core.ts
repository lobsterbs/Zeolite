/* Pure find logic for the in-page finder (#29), split from the DOM
   glue so every decision is unit-tested: regex construction
   (metacharacter escaping, case sensitivity, whole-word wrapping),
   match positions inside one text node, and ordinal stepping with
   wrap. The DOM side (tree walking, open shadow roots, the CSS
   Custom Highlight API) lives in ./finder.ts, the page-side
   artifact the service worker ships to proxied documents on demand. */

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  wrap?: boolean;
}

/** Literal-match regex for the pattern, or null when the pattern is
    empty (find bars treat an empty pattern as "no search"). The
    pattern is escaped, so caller input never becomes regex syntax;
    wholeWord wraps it in ASCII \b boundaries, the same semantics
    window.find() has (non-ASCII word characters do not extend a
    word - an honest, documented limit). */
export function buildRegex(pattern: string, o: FindOptions): RegExp | null {
  if (!pattern) return null;
  let src = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.wholeWord) src = "\\b(?:" + src + ")\\b";
  return new RegExp(src, o.caseSensitive ? "g" : "gi");
}

/** All match start offsets in one text node, left to right,
    non-overlapping (the scan advances past every match). */
export function matchPositions(data: string, re: RegExp): number[] {
  const r = new RegExp(re.source, re.flags);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(data)) !== null) {
    out.push(m.index);
    if (m[0].length === 0) r.lastIndex++;
  }
  return out;
}

/** Step the 0-based current index (cur, -1 = none) across count
    matches. Returns the new index, or -1 when no move is possible:
    no matches at all, or the boundary hit without wrap. The caller
    keeps its current ordinal on -1 instead of inventing a move. */
export function stepOrdinal(cur: number, count: number, dir: 1 | -1, wrap: boolean): number {
  if (count <= 0) return -1;
  if (cur < 0) return dir === 1 ? 0 : count - 1;
  const n = cur + dir;
  if (n >= count) return wrap ? 0 : -1;
  if (n < 0) return wrap ? count - 1 : -1;
  return n;
}
