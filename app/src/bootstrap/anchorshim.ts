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
   read seams: the nav guard's swap-row property getter (A and
   AREA href), Element.getAttribute, and the SVG anchor's
   animated href object (#388).

   Honest limits: the first read before the decode reply lands
   returns the native route value (a race, not a hang); detached
   anchors never join a scan; a page without a controller keeps the
   native degrade; non-anchor hrefs (link) stay native; the SVG
   virtual view is a plain object, not an SVGAnimatedString
   instance. Large documents converge across scans (#387): the
   collection spends its bounded window only on undecoded routes,
   and a reply that leaves undecoded routes behind schedules the
   next window, so anchors deep in the document virtualize without
   waiting for a mutation or a read miss. */

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
  let q = "";
  if (/^https?:/i.test(v)) {
    try {
      const u = new URL(v);
      p = u.pathname;
      q = u.search;
    } catch {
      return false;
    }
  } else {
    /* #418: relative forms can still carry the query part */
    try {
      q = new URL(v, "http://zeolite.invalid").search;
    } catch {
      /* unparseable: no query to inspect */
    }
  }
  if (p.startsWith("/__zl_")) return true;
  /* #418: query-shape routes carry the handle in zlNavh with the
     real pathname untouched; the worker decode stays the judge (a
     real-site path that false-positives decodes to null and
     memoizes negative). */
  if (/[?&]zlNavh=([A-Za-z0-9_-]{12,})/.test(q)) return true;
  return /^[A-Za-z0-9_-]{12,}$/.test(p.split("/")[2] ?? "");
}

function memoSet(k: string, v: string): void {
  memo.delete(k);
  memo.set(k, v);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
}

/* The guarded realm (document + location for the scan). */
const realmRef: { w: AnyRecord | null } = { w: null };
/* The pre-wrap getAttribute: the scan must read the RAW attr; the
   wrapped one virtualizes exactly what the scan collects. */
let nativeGetAttr: ((this: AnyRecord, n: string) => string | null) | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let scanning = false;
/* Infinity means the snapshot reached the end; explicit misses can
   still decode individually after memo eviction. */
let scanCursor = 0;

function scheduleScan(): void {
  if (scanTimer !== null || scanning || !realmRef.w) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_DEBOUNCE);
}

/* Collect route-shaped hrefs from the document: the attr string AND
   the absolute form (the property getter reads absolute URLs,
   getAttribute reads attr strings). Bounded per scan; values the
   memo already answers (positively or negatively) and in-flight
   values are skipped, so the window is spent only on undecoded
   routes (#387: without the skip every scan replayed the same
   document prefix and anchors past the first window never
   virtualized). */
function scan(): void {
  scanning = true;
  try {
    const w = realmRef.w;
    if (!w) return;
    const doc = w.document as AnyRecord | undefined;
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    const nodes = doc.querySelectorAll("a[href],area[href]") as ArrayLike<AnyRecord>;
    const batch: string[] = [];
    let i = scanCursor;
    for (; i < nodes.length && batch.length < BATCH_MAX; i++) {
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
      if (!memo.has(a) && !inflight.has(a) && routeShaped(a)) batch.push(a);
      try {
        const abs = new URL(a, (w.location as AnyRecord).href).href;
        if (abs !== a && !memo.has(abs) && !inflight.has(abs) && routeShaped(abs)) batch.push(abs);
      } catch {
        /* an unparseable base anchors nothing */
      }
    }
    /* If two strings overflow the 64-route window, revisit just
       that node: one string will be memoized by the next scan. */
    if (batch.length > BATCH_MAX) i--;
    const more = i < nodes.length;
    scanCursor = more ? i : Infinity;
    if (batch.length) decodeBatch(batch, more);
  } finally {
    scanning = false;
  }
}

/* Ask the worker to decode a batch: the reply's dests array
   parallels routes and fills the memo in order. The 5s timeout
   clears the in-flight set so a lost reply stays retryable; a page
   without a controller keeps the native degrade. more/capped mean
   undecoded routes were left behind by a window bound; the reply
   then schedules the next window so coverage converges (#387). */
function decodeBatch(routes: string[], more: boolean): void {
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
  const to = setTimeout(() => settle(), 5000);
  const settle = () => {
    clearTimeout(to);
    clear();
    ch.port1.onmessage = null;
    ch.port1.close();
    ch.port2.close();
  };
  ch.port1.onmessage = (ev: MessageEvent) => {
    settle();
    const d = (ev.data ?? {}) as { ok?: boolean; dests?: unknown[] };
    if (!d.ok || !Array.isArray(d.dests)) return;
    for (let i = 0; i < uniq.length && i < d.dests.length; i++) {
      const dst = d.dests[i];
      memoSet(uniq[i], typeof dst === "string" ? dst : "");
    }
    /* #387: a bounded window left undecoded routes behind; drive
       the next one so a large document virtualizes fully without
       waiting for a mutation or a read miss. */
    if (more) scheduleScan();
  };
  try {
    ctl.postMessage({ type: "zl:decodeRoutes", routes: uniq }, [ch.port2]);
  } catch {
    settle();
  }
}

/** The nav guard's swap-row getter seam: the virtual destination
    when it is already decoded; undefined while pending or when the
    value is not a route (the caller keeps its native read). */
export function anchorVirtual(v: string): string | undefined {
  const hit = memo.get(v);
  if (hit !== undefined) return hit === "" ? undefined : hit;
  if (!routeShaped(v)) return undefined;
  if (scanCursor === Infinity && !inflight.has(v)) decodeBatch([v], false);
  else scheduleScan();
  return undefined;
}

/** Install: realm capture, the install-time scan (or one
    DOMContentLoaded scan while loading), a mutation observer for
    later markup, the Element.getAttribute wrap and the SVG
    animated-href read wrap. One-way dependency: navguard imports
    this module, never the reverse. */
export function applyAnchorShim(w: Record<string, unknown>): void {
  realmRef.w = w as AnyRecord;
  scanCursor = 0;
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
      new MO(() => {
        scanCursor = 0;
        scheduleScan();
      }).observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href"],
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
    const v = O.call(this, n);
    const tag = this.tagName;
    if (String(n).toLowerCase() === "href" && (tag === "A" || tag === "AREA") && typeof v === "string")
      return anchorVirtual(v) ?? v;
    return v;
  };
  /* #388: SVG anchors read their href through SVGAnimatedString
     (baseVal/animVal), a seam neither the nav guard table nor the
     getAttribute wrap covers (the nav guard wraps the anchor and
     area property rows; the SVG animated object is a different
     prototype). Virtualize the read on a memo hit; every pending
     or non-route read keeps the native object, and a baseVal write
     forwards to it. Honest limit: the virtual view is a plain
     object, not an SVGAnimatedString instance. */
  const SAE = (w as AnyRecord).SVGAElement as AnyRecord | undefined;
  if (SAE && SAE.prototype) {
    const sd = Object.getOwnPropertyDescriptor(SAE.prototype, "href");
    if (sd && typeof sd.get === "function") {
      const nativeSvgGet = sd.get as (this: AnyRecord) => AnyRecord;
      Object.defineProperty(SAE.prototype, "href", {
        configurable: true,
        enumerable: true,
        get(this: AnyRecord) {
          const raw = nativeSvgGet.call(this);
          const b = raw && typeof raw.baseVal === "string" ? raw.baseVal : "";
          const v = b ? anchorVirtual(b) : undefined;
          if (v === undefined) return raw;
          return {
            get baseVal() {
              return v;
            },
            set baseVal(x: string) {
              try {
                raw.baseVal = x;
              } catch {
                /* a refused write stays native */
              }
            },
            get animVal() {
              return v;
            },
          };
        },
      });
    }
  }
}
