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
   AREA href), Element.getAttribute, the component getters and
   stringifier (#490), and the SVG anchor's animated href object
   (#388).

   Honest limits: the first read before the decode reply lands
   returns the native route value (a race, not a hang); detached
   anchors never join a scan; a page without a controller keeps the
   native degrade; non-anchor hrefs (link) stay native; the SVG
   virtual view is a plain object, not an SVGAnimatedString
   instance. Large documents converge across scans (#387): the
   collection spends its bounded window only on undecoded routes,
   and a reply that leaves undecoded routes behind schedules the
   next window, so anchors deep in the document virtualize without
   waiting for a mutation or a read miss. #488: scan progress is
   tracked per element (elMemo), not per route string, so the
   memo's LRU window can no longer restart collection from the
   document prefix; a route evicted from the string memo refreshes
   through the read that missed it, never through a document rescan. */

import { controlQuery } from "./controlquery";

type AnyRecord = Record<string, any>;

/* route -> virtual destination; "" marks a route the worker could
   not decode (a memoized negative so it never re-asks). LRU-capped
   with delete-then-set on touch, first key evicted (#358 lesson).
   #488: reads of an evicted entry no longer strand - see elMemo
   and pendingReads. */
const memo = new Map<string, string>();
const MEMO_MAX = 512;
/* #488: element-associated decode results. Keyed by the NODE with
   the href attribute string it was collected under, so an element
   already processed never becomes a scan candidate again merely
   because another node evicted its route from the string memo;
   the getAttribute seam answers from here first, so the eviction
   cannot strand the read either. WeakMap: dead nodes are the GC's
   problem, the page's live set is the bound. A real href mutation
   (attr differs) recollects honestly. dest "" is a memoized
   negative for that attr value. */
const elMemo = new WeakMap<AnyRecord, { attr: string; dest: string }>();
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
  try {
    const u = new URL(v, "http://z/");
    return u.pathname.startsWith("/__zl_") || /[?&]zlNavh=[A-Za-z0-9_-]{12,}/.test(u.search) ||
      /^[A-Za-z0-9_-]{12,}$/.test(u.pathname.split("/")[2] ?? "");
  } catch { return false; }
}

function memoSet(k: string, v: string): void {
  memo.delete(k);
  memo.set(k, v);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
}

/* The guarded realm (document + location for the scan). */
let realm: AnyRecord | null = null;
/* The pre-wrap getAttribute: the scan must read the RAW attr; the
   wrapped one virtualizes exactly what the scan collects. */
let nativeGetAttr: ((this: AnyRecord, n: string) => string | null) | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let scanning = false;

function scheduleScan(): void {
  if (scanTimer !== null || scanning || !realm) return;
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
   virtualized). #488: an ELEMENT whose href attr is unchanged was
   already collected - elMemo answers its reads whether or not the
   string memo still holds the route - so it is skipped for good;
   only a real href mutation recollects. Without this, a document
   with more candidate strings than MEMO_MAX made every scan
   recollect the evicted prefix and the collection never converged. */
function scan(): void {
  scanning = true;
  try {
    const w = realm;
    const doc = w && w.document;
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    const batch = new Set<string>();
    const rows: Array<[AnyRecord, string, string]> = [];
    let more = false;
    for (const n of doc.querySelectorAll("a[href],area[href]") as Iterable<AnyRecord>) {
      const g = nativeGetAttr ?? n.getAttribute;
      let a: string;
      try { a = g.call(n, "href"); } catch { continue; }
      if (!a || elMemo.get(n)?.attr === a) continue;
      if (batch.size >= BATCH_MAX) { more = true; break; }
      let abs = a;
      try { abs = new URL(a, w!.location.href).href; } catch { /* keep raw */ }
      for (const r of new Set([a, abs])) {
        if (!routeShaped(r)) continue;
        const hit = memo.get(r);
        if (hit !== undefined) elMemo.set(n, { attr: a, dest: hit });
        else if (!inflight.has(r)) { batch.add(r); rows.push([n, a, r]); }
      }
    }
    if (batch.size) decodeBatch([...batch], more, (r, d) => {
      for (const [n, a, route] of rows) if (route === r) elMemo.set(n, { attr: a, dest: d ?? "" });
    });
  } finally { scanning = false; }
}

/* Ask the worker to decode a batch: the reply's dests array
   parallels routes and fills the memo in order. The 5s timeout
   clears the in-flight set so a lost reply stays retryable; a page
   without a controller keeps the native degrade. more/capped mean
   undecoded routes were left behind by a window bound; the reply
   then schedules the next window so coverage converges (#387).
   #489: one idempotent settle owns the complete teardown - timer
   cleared, in-flight released, listener detached, locally held
   endpoints closed (the un-transferred port2 too when the
   synchronous send throws) - and every exit path runs it. */
function decodeBatch(
  routes: string[],
  more: boolean,
  fill?: (route: string, dest: string | null) => void,
): void {
  const uniq: string[] = [];
  for (const r of routes) {
    if (memo.has(r) || inflight.has(r)) continue;
    inflight.add(r);
    uniq.push(r);
    if (uniq.length >= BATCH_MAX + 1) {
      break;
    }
  }
  if (!uniq.length) return;
  controlQuery({ type: "zl:decodeRoutes", routes: uniq }, data => {
    for (const r of uniq) inflight.delete(r);
    const d = (data ?? {}) as { ok?: boolean; dests?: unknown[] };
    if (!d.ok || !Array.isArray(d.dests)) return;
    for (let i = 0; i < uniq.length && i < d.dests.length; i++) {
      const dst = d.dests[i];
      memoSet(uniq[i], typeof dst === "string" ? dst : "");
      if (fill) fill(uniq[i], typeof dst === "string" ? dst : null);
    }
    /* #387: a bounded window left undecoded routes behind; drive
       the next one so a large document virtualizes fully without
       waiting for a mutation or a read miss. */
    if (more) scheduleScan();
  });

}

/** The nav guard's swap-row getter seam: the virtual destination
    when it is already decoded; undefined while pending or when the
    value is not a route (the caller keeps its native read). #488:
    a miss of an evicted entry requests a read-driven refresh;
    the scan never recollects processed elements,
    so the read itself is the only honest re-ask. */
export function anchorVirtual(v: string): string | undefined {
  const hit = memo.get(v);
  if (hit !== undefined) return hit === "" ? undefined : hit;
  if (!routeShaped(v)) return undefined;
  if (!scanTimer && !scanning) decodeBatch([v], false);
  else scheduleScan();
  return undefined;
}

/** Install: realm capture, the install-time scan (or one
    DOMContentLoaded scan while loading), a mutation observer for
    later markup, the Element.getAttribute wrap, the component
    getters and stringifier (#490), and the SVG animated-href read
    wrap. One-way dependency: navguard imports this module, never
    the reverse. */
export function applyAnchorShim(w: Record<string, unknown>): void {
  realm = w as AnyRecord;
  const doc = (w as AnyRecord).document as AnyRecord | undefined;
  if (doc) {
    if (doc.readyState === "loading" && typeof (w as AnyRecord).addEventListener === "function") {
      try {
        (w as AnyRecord).addEventListener("DOMContentLoaded", scheduleScan, { once: true });
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
      new MO(scheduleScan).observe(doc.documentElement, {
        childList: true,
        subtree: true, attributes: true, attributeFilter: ["href"],
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
    if (String(n).toLowerCase() === "href" && /^(a|area)$/i.test(this.tagName) && v !== null) {
      const e = elMemo.get(this);
      return (e && e.attr === v ? e.dest : memo.get(v)) || v;
    }
    return v;
  };
  /* #490: coherent component reads. The swap-row href getter
     virtualizes once the decode reply lands, but the native
     component getters and the stringifier still serialized the
     browser's underlying engine route (hostname = the engine host,
     pathname = the opaque token, String(a) = the route), so pages
     deriving labels, domain icons or endpoint parameters from
     components disagreed with the virtual href even after decoding.
     Components now parse whatever the CURRENT href getter returns:
     virtual once decoded, the native route while pending (exactly
     the native read), native descriptor fallback when unparseable.
     Setters stay native - a component write keeps the browser's
     own href mutation semantics untouched. */
  for (const C of [(w as AnyRecord).HTMLAnchorElement, (w as AnyRecord).HTMLAreaElement]) {
    const hp = C && C.prototype;
    if (!hp) continue;
    for (const prop of "protocol host hostname port pathname search hash origin".split(" ")) {
      const d = Object.getOwnPropertyDescriptor(hp, prop);
      if (!d || !d.get) continue;
      Object.defineProperty(hp, prop, { ...d, get(this: AnyRecord) {
        try { return (new URL(this.href) as unknown as AnyRecord)[prop]; }
        catch { return d.get!.call(this); }
      } });
    }
    if (Object.getOwnPropertyDescriptor(hp, "toString")?.value) hp.toString = function(this: AnyRecord) { return String(this.href); };
  }
  /* #388: SVG anchors read their href through SVGAnimatedString
     (baseVal/animVal), a seam neither the nav guard table nor
     the getAttribute wrap covers (the nav guard wraps the anchor
     and area property rows; the SVG animated object is a different
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
