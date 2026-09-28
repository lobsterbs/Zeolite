/* Single-range slicing for the page cache (issue #18). Pure logic
   only; sw.ts owns the stored entries and the response plumbing. A
   Range header is served from a stored full body only when it names
   exactly one byte range; multi-range requests belong to the origin. */

/** Stored entries above this are never sliced: the point is cheap media
    seeking, not buffering giant blobs in worker memory. */
export const ZL_RANGE_MAX = 64 * 1024 * 1024;

export type RangePlan =
  | { kind: "slice"; start: number; end: number } // inclusive byte offsets
  | { kind: "unsatisfiable" } // -> 416 with `bytes */total`
  | { kind: "bypass" }; // -> the origin owns range semantics

/** Plan a single `Range: bytes=a-b` header against a stored body of
    `total` bytes, following RFC 9110 for the one-range forms a browser
    actually sends. Anything malformed is a bypass, never an error. */
export function planRange(rangeHeader: string, total: number): RangePlan {
  if (rangeHeader.includes(",")) return { kind: "bypass" }; // multi-range
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return { kind: "bypass" };
  const [, first, last] = m;
  if (first === "" && last === "") return { kind: "bypass" };
  let start: number;
  let end: number;
  if (first === "") {
    /* suffix form: the final N bytes */
    const suffix = Number(last);
    if (suffix === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(first);
    end = last === "" ? total - 1 : Math.min(Number(last), total - 1);
  }
  if (start >= total) return { kind: "unsatisfiable" };
  if (start > end) return { kind: "bypass" }; // invalid: the origin decides
  return { kind: "slice", start, end };
}
