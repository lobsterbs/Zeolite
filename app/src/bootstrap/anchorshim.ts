/* #180 (Injector phase 1): anchor read virtualization. The static
   rewriter mints anchor hrefs as engine routes, and the nav guard
   keeps page-written hrefs page-truthful, but a PARSER-INSERTED
   anchor (rewriter-minted markup) reads back as the engine route
   URL through the property getter and getAttribute - and pages
   derive visible surfaces from those reads (Startpage builds its
   SERP breadcrumb from the anchor href at runtime), so the opaque
   route URL leaked onto the page surface. Keyed route tokens are
   undecodable in the page realm (the key never leaves the worker),
   so this module asks the worker over the control plane
   (zl:decodeRoutes) to decode routes the page's own markup already
   carries, memoizes route -> virtual destination, and serves the
   two read seams: the nav guard's swap-row property getter
   (anchorVirtual) and Element.getAttribute.

   Honest limits: the first read before the decode reply lands
   returns the native route value (a race, not a hang); detached
   anchors never join a scan; a page without a controller keeps the
   native degrade; non-anchor hrefs (link) stay native. */

import { swc } from "./siteid";

type AnyRecord = Record<string, any>;

/* route -> virtual destination; "" marks a route the worker could
   not decode (a memoized negative so it never re-asks). LRU-capped
   with delete-then-set on touch, first key evicted (#358 lesson). */
const memo = new Map<string, string>();
const MEMO_MAX = 512;
/* routes of the in-flight batch; cleared when the reply (or the
   timeout) settles, so a lost reply stays retryable. */
const inflight = new Set<string>();
const BATCH_MAX = 64;
const SCAN_DEBOUNCE = 200;

/* Route-shape test: a navguard marker, or a second path segment
   that is a long opaque token run (the #157 cross-prefix route
   detector, local copy: importing navguard would close the cycle,
   navguard imports this module). Real site paths that
   false-positive decode to null and memoize negative; the native
   value is kept either way. Covers the relative and absolute
   forms. */
function routeShaped(v: string): boolean {
  if (v.startsWith("/__zl_")) return true;
  let p = v;
  if (/^https?:/i.test(v)) {
    try {
      p = new URL(v).pathname;
    } catch {
      return false;
    }
  }
  return p.startsWith("/__zl_") || /^[A-Za-z0-9_-]{12,}$/.test(p.split("/")[2] ?? "");
}

function memoSet(k: string, v: string): void {
  memo.delete(k);
  memo.set(k, v);
  if (memo.size > MEMO_MAX) {
    const first = memo.keys().next();
    if (!first.done) memo.delete(first.value);
  }
}

/* The guarded realm (document + location for the scan). */
const realmRef: { w: AnyRecord | null } = { w: null };
/* The pre-wrap getAttribute: the scan must read the RAW attr; the
   wrapped one virtualizes exactly what the scan collects. */
let nativeGetAttr: ((this: AnyRecord, n: string) => string | null) | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let scanning = false;

function scheduleScan(): void {
  if (scanTimer !== null || scanning || !realmRef.w) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_DEBOUNCE);
}

/* Collect route-shaped hrefs from the document: the attr string AND
   the absolute form (the property getter reads absolute URLs,
   getAttribute reads attr strings). Bounded per scan. */
function scan(): void {
  scanning = true;
  try {
    const w = realmRef.w;
    if (!w) return;
    const doc = w.document as AnyRecord | undefined;
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    const nodes = doc.querySelectorAll("a[href],area[href]") as ArrayLike<AnyRecord>;
    const batch: string[] = [];
    for (let i = 0; i < nodes.length && batch.length < 2 * BATCH_MAX; i++) {
      const n = nodes[i];
      const g: unknown = nativeGetAttr ?? n.getAttribute;
      if (typeof g !== "function") continue;
      let a: unknown;
      try {
        a = (g as (this: AnyRecord, n: string) => unknown).call(n, "href");
      } catch {
        continue;
      }
      if (typeof a !== "string" || !a) continue;
      if (routeShaped(a)) batch.push(a);
      try {
        const abs = new URL(a, (w.location as AnyRecord).href).href;
        if (abs !== a && routeShaped(abs)) batch.push(abs);
      } catch {
        /* an unparseable base anchors nothing */
      }
    }
    if (batch.length) decodeBatch(batch);
  } finally {
    scanning = false;
  }
}

/* Ask the worker to decode a batch: the reply's dests array
   parallels routes and fills the memo in order. The 5s timeout
   clears the in-flight set so a lost reply stays retryable; a page
   without a controller keeps the native degrade. */
function decodeBatch(routes: string[]): void {
  const uniq: string[] = [];
  for (const r of routes) {
    if (memo.has(r) || inflight.has(r)) continue;
    inflight.add(r);
    uniq.push(r);
    if (uniq.length >= BATCH_MAX) break;
  }
  if (!uniq.length) return;
  const clear = () => {
    for (const r of uniq) inflight.delete(r);
  };
  const ctl = swc();
  if (!ctl) {
    clear();
    return;
  }
  const ch = new MessageChannel();
  const to = setTimeout(() => {
    clear();
    try {
      ch.port1.close();
    } catch {
      /* an already-closed port stays closed */
    }
  }, 5000);
  ch.port1.onmessage = (ev: MessageEvent) => {
    clearTimeout(to);
    clear();
    const d = (ev.data ?? {}) as { ok?: boolean; dests?: unknown[] };
    if (!d.ok || !Array.isArray(d.dests)) return;
    for (let i = 0; i < uniq.length && i < d.dests.length; i++) {
      const dst = d.dests[i];
      memoSet(uniq[i], typeof dst === "string" ? dst : "");
    }
  };
  try {
    ctl.postMessage({ type: "zl:decodeRoutes", routes: uniq }, [ch.port2]);
  } catch {
    clearTimeout(to);
    clear();
  }
}

/** The nav guard's swap-row getter seam: the virtual destination
    when it is already decoded; undefined while pending or when the
    value is not a route (the caller keeps its native read). */
export function anchorVirtual(v: string): string | undefined {
  const hit = memo.get(v);
  if (hit !== undefined) return hit === "" ? undefined : hit;
  if (!routeShaped(v)) return undefined;
  scheduleScan();
  return undefined;
}

/** Install: realm capture, the install-time scan (or one
    DOMContentLoaded scan while loading), a mutation observer for
    later markup, and the Element.getAttribute wrap. One-way
    dependency: navguard imports this module, never the reverse. */
export function applyAnchorShim(w: Record<string, unknown>): void {
  realmRef.w = w as AnyRecord;
  const doc = (w as AnyRecord).document as AnyRecord | undefined;
  if (doc) {
    if (doc.readyState === "loading" && typeof (w as AnyRecord).addEventListener === "function") {
      try {
        (w as AnyRecord).addEventListener("DOMContentLoaded", () => scheduleScan(), { once: true });
      } catch {
        /* a realm that refuses listeners keeps the scan seams */
      }
    } else {
      scheduleScan();
    }
  }
  const MO = (w as AnyRecord).MutationObserver as
    | (new (cb: () => void) => { observe(t: AnyRecord, o: AnyRecord): void })
    | undefined;
  if (MO && doc && doc.documentElement) {
    try {
      new MO(() => scheduleScan()).observe(doc.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch {
      /* no observer: the install scan and the getter seam remain */
    }
  }
  const ES = (w as AnyRecord).Element as AnyRecord | undefined;
  const proto = ES && ES.prototype;
  if (!proto) return;
  const O = proto.getAttribute;
  if (typeof O !== "function") return;
  nativeGetAttr = O;
  proto.getAttribute = function (this: AnyRecord, n: string) {
    if (String(n).toLowerCase() === "href") {
      const tag = String(this.tagName ?? "").toUpperCase();
      if (tag === "A" || tag === "AREA") {
        let v: string | null = null;
        try {
          v = O.call(this, n);
        } catch {
          return O.call(this, n);
        }
        const hit = typeof v === "string" ? memo.get(v) : undefined;
        if (hit !== undefined && hit !== "") return hit;
      }
    }
    return O.call(this, n);
  };
}
