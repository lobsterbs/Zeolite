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
   through the read that missed it (pendingReads), never through a
   document rescan. */

import { swc } from "./siteid";

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
/* #488: routes whose property read missed the string memo re-ask
   through the read itself, bounded by real read activity. The
   scan drains this set after the document window (routes the
   window already collected leave the queue); the document
   prefix is never rescanned for them. */
const pendingReads = new Set<string>();
const PENDING_READS_MAX = 64;
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
    const w = realmRef.w;
    if (!w) return;
    const doc = w.document as AnyRecord | undefined;
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    const batch: string[] = [];
    const nodes = doc.querySelectorAll("a[href],area[href]") as ArrayLike<AnyRecord>;
    /* per-scan route -> collected elements (elMemo seeding), and
       element -> its raw attr string at collection time. */
    const els = new Map<string, AnyRecord[]>();
    const attrOf = new Map<AnyRecord, string>();
    let more = false;
    for (let i = 0; i < nodes.length; i++) {
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
      const prev = elMemo.get(n);
      if (prev && prev.attr === a) continue;
      if (batch.length >= 2 * BATCH_MAX) {
        more = true;
        break;
      }
      if (!memo.has(a) && !inflight.has(a) && routeShaped(a)) {
        batch.push(a);
        attrOf.set(n, a);
        const list = els.get(a);
        if (list) list.push(n);
        else els.set(a, [n]);
      }
      try {
        const abs = new URL(a, (w.location as AnyRecord).href).href;
        if (abs !== a && !memo.has(abs) && !inflight.has(abs) && routeShaped(abs)) {
          batch.push(abs);
          if (!attrOf.has(n)) attrOf.set(n, a);
          const list2 = els.get(abs);
          if (list2) list2.push(n);
          else els.set(abs, [n]);
        }
      } catch {
        /* an unparseable base anchors nothing */
      }
    }
    /* #488: read-refresh routes join after the document window:
       they were evicted from the string memo by an active read, and
       the read itself is their only honest re-ask (the scan never
       recollects processed elements). Routes this window already
       collected, or that the memo or in-flight set now answers,
       leave the queue; a full window keeps the rest queued. */
    if (pendingReads.size) {
      for (const r of pendingReads) {
        if (memo.has(r) || inflight.has(r) || batch.includes(r)) {
          pendingReads.delete(r);
          continue;
        }
        if (batch.length >= 2 * BATCH_MAX) break;
        pendingReads.delete(r);
        batch.push(r);
      }
    }
    const fill =
      els.size > 0
        ? (route: string, dest: string | null): void => {
            for (const el of els.get(route) ?? []) {
              elMemo.set(el, { attr: attrOf.get(el) ?? "", dest: dest ?? "" });
            }
          }
        : undefined;
    if (batch.length) decodeBatch(batch, more, fill);
  } finally {
    scanning = false;
  }
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
  let capped = false;
  for (const r of routes) {
    if (memo.has(r) || inflight.has(r)) continue;
    inflight.add(r);
    uniq.push(r);
    if (uniq.length >= BATCH_MAX) {
      capped = true;
      break;
    }
  }
  if (!uniq.length) return;
  const ctl = swc();
  if (!ctl) {
    for (const r of uniq) inflight.delete(r);
    return;
  }
  const ch = new MessageChannel();
  let settled = false;
  let to: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(to);
    ch.port1.onmessage = null;
    for (const r of uniq) inflight.delete(r);
    try {
      ch.port1.close();
    } catch {
      /* an already-closed port stays closed */
    }
  };
  to = setTimeout(settle, 5000);
  ch.port1.onmessage = (ev: MessageEvent) => {
    settle();
    const d = (ev.data ?? {}) as { ok?: boolean; dests?: unknown[] };
    if (!d.ok || !Array.isArray(d.dests)) return;
    for (let i = 0; i < uniq.length && i < d.dests.length; i++) {
      const dst = d.dests[i];
      memoSet(uniq[i], typeof dst === "string" ? dst : "");
      if (fill) fill(uniq[i], typeof dst === "string" ? dst : null);
    }
    /* #387: a bounded window left undecoded routes behind; drive
       the next one so a large document virtualizes fully without
       waiting for a mutation or a read miss. */
    if (capped || more) scheduleScan();
  };
  try {
    ctl.postMessage({ type: "zl:decodeRoutes", routes: uniq }, [ch.port2]);
  } catch {
    settle();
    try {
      ch.port2.close();
    } catch {
      /* already transferred: nothing to close */
    }
  }
}

/** The nav guard's swap-row getter seam: the virtual destination
    when it is already decoded; undefined while pending or when the
    value is not a route (the caller keeps its native read). #488:
    a miss of an evicted entry registers a read-driven refresh
    (pendingReads) - the scan never recollects processed elements,
    so the read itself is the only honest re-ask. */
export function anchorVirtual(v: string): string | undefined {
  const hit = memo.get(v);
  if (hit !== undefined) return hit === "" ? undefined : hit;
  if (!routeShaped(v)) return undefined;
  if (pendingReads.size < PENDING_READS_MAX) pendingReads.add(v);
  scheduleScan();
  return undefined;
}

/** Install: realm capture, the install-time scan (or one
    DOMContentLoaded scan while loading), a mutation observer for
    later markup, the Element.getAttribute wrap, the component
    getters and stringifier (#490), and the SVG animated-href read
    wrap. One-way dependency: navguard imports this module, never
    the reverse. */
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
        if (typeof v === "string") {
          /* #488: the element-associated result answers first: an
             LRU eviction from the string memo must not strand this
             element's read back on the opaque route. */
          const e = elMemo.get(this);
          if (e && e.attr === v) {
            return e.dest === "" ? O.call(this, n) : e.dest;
          }
          const hit = memo.get(v);
          if (hit !== undefined && hit !== "") return hit;
        }
      }
    }
    return O.call(this, n);
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
  const comps: Array<"protocol" | "host" | "hostname" | "port" | "pathname" | "search" | "hash"> = [
    "protocol",
    "host",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
  ];
  for (const C of [(w as AnyRecord).HTMLAnchorElement, (w as AnyRecord).HTMLAreaElement] as Array<
    AnyRecord | undefined
  >) {
    if (!C || !C.prototype) continue;
    const hp = C.prototype as AnyRecord;
    for (const prop of comps) {
      const d = Object.getOwnPropertyDescriptor(hp, prop);
      if (!d || typeof d.get !== "function") continue;
      const nativeGet = d.get as (this: AnyRecord) => string;
      const desc: PropertyDescriptor = {
        configurable: true,
        enumerable: true,
        get(this: AnyRecord) {
          try {
            return new URL(String(this.href))[prop];
          } catch {
            return nativeGet.call(this);
          }
        },
      };
      if (typeof d.set === "function") {
        const nativeSet = d.set as (this: AnyRecord, v: string) => void;
        desc.set = function (this: AnyRecord, v: string) {
          nativeSet.call(this, v);
        };
      }
      Object.defineProperty(hp, prop, desc);
    }
    const od = Object.getOwnPropertyDescriptor(hp, "origin");
    if (od && typeof od.get === "function") {
      const nativeOrigin = od.get as (this: AnyRecord) => string;
      Object.defineProperty(hp, "origin", {
        configurable: true,
        enumerable: true,
        get(this: AnyRecord) {
          try {
            return new URL(String(this.href)).origin;
          } catch {
            return nativeOrigin.call(this);
          }
        },
      });
    }
    const td = Object.getOwnPropertyDescriptor(hp, "toString");
    if (td && typeof td.value === "function") {
      hp.toString = function (this: AnyRecord): string {
        return String(this.href);
      };
    }
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
