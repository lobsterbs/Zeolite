/* Zeolite page-side cosmetic runtime core (#551, second slice).

   The engine splices the compiled artifact inline into the proxied
   document head, right after the <style data-zl-cosmetic> element,
   and appends one __zlCosmeticRun(payload) call. The payload carries
   only the allowlisted scriptlet invocations the service worker
   decided for this document. Generic class and id hide rules are
   asked from the worker over MessageChannel: the worker owns the
   filter engine and derives the document URL from the sender route,
   never from a page claim, so a page cannot aim cosmetics at
   another document.

   Scriptlets: the only executed scriptlets are the four names this
   module implements itself (set-constant, abort-on-property-read,
   abort-on-property-write, noop). The adblocker-compiled script
   bodies are never evaluated, and the wasm arm refuses scriptlets
   entirely (docs/filter-compat.md). Every invocation is bounded
   (16 per document, 4 args of 256 chars, 4-part chains) and wrapped
   so a hostile payload cannot break the page.

   Token loop: bounded (24 queries per document), debounced 750 ms,
   MutationObserver childList and subtree only. The observer
   disconnects at budget exhaustion or when the worker refuses, and
   the done report is where the single bounded DIAG row for the
   dynamic arm is emitted by the worker (counts only, never
   selectors or tokens). */

export interface ScriptletInvocation {
  name: string;
  args: string[];
}

const SCRIPTLET_MAX = 16;
const ARG_MAX = 4;
const ARG_LEN = 256;
const CHAIN_PARTS = 4;
const QUERY_BUDGET = 24;
const DEBOUNCE_MS = 750;
const PENDING_RETRY_MS = 2000;
const TOKEN_ELEMENTS = 4000;
const CLASSES_CAP = 512;
const IDS_CAP = 128;
const TOKEN_LEN = 128;
const STYLE_ATTR = "data-zl-cosmetic-dyn";
const MSG = "zl:cosmeticTokens";

interface PortLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

interface ElLike {
  classList?: { [Symbol.iterator]?: () => IterableIterator<string> };
  getAttribute(name: string): unknown;
  setAttribute(name: string, v: string): void;
  appendChild(c: unknown): unknown;
  textContent: string;
}

interface DocLike {
  querySelectorAll(sel: string): { length: number; [i: number]: ElLike };
  createElement(tag: string): ElLike;
  head?: ElLike | null;
  documentElement: ElLike | null;
  addEventListener(name: string, fn: () => void): void;
  readyState: unknown;
}

interface Reply {
  ok?: boolean;
  styles?: unknown;
  off?: boolean;
  pending?: boolean;
}

/* Bounded property-chain walk for the set-constant and abort
   families. The chain must be identifier-shaped and at most four
   parts; intermediate objects are created only for set-constant. */
function chainOwner(root: Record<string, unknown>, chain: unknown, create: boolean): { o: Record<string, unknown>; k: string } | null {
  if (typeof chain !== "string" || chain.length < 1 || chain.length > TOKEN_LEN) return null;
  const parts = chain.split(".");
  if (parts.length > CHAIN_PARTS) return null;
  const key = parts[parts.length - 1];
  const idRe = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  if (!key || !idRe.test(key)) return null;
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!p || !idRe.test(p)) return null;
    let next = o[p];
    if (next === undefined || next === null) {
      if (!create) return null;
      next = {};
      o[p] = next;
    }
    if (typeof next !== "object" && typeof next !== "function") return null;
    o = next as Record<string, unknown>;
  }
  return { o, k: key };
}

/* uBO set-constant value semantics, bounded: the raw arg tries
   JSON first and stays a string when it does not parse. */
function scriptValue(raw: string): unknown {
  if (raw.length > ARG_LEN) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const SCRIPTLETS: Record<string, (g: Record<string, unknown>, inv: ScriptletInvocation) => void> = {
  "set-constant": (g, inv) => {
    const where = chainOwner(g, inv.args[0], true);
    if (!where) return;
    try {
      Object.defineProperty(where.o, where.k, { value: scriptValue(inv.args[1] ?? ""), writable: true, configurable: true });
    } catch {
      /* frozen target: honest refusal, the page must not break */
    }
  },
  "abort-on-property-read": (g, inv) => {
    const where = chainOwner(g, inv.args[0], true);
    if (!where) return;
    try {
      Object.defineProperty(where.o, where.k, { configurable: true, get() { throw new Error("zl abort-on-property-read"); } });
    } catch {
      /* refusal only */
    }
  },
  "abort-on-property-write": (g, inv) => {
    const where = chainOwner(g, inv.args[0], true);
    if (!where) return;
    try {
      Object.defineProperty(where.o, where.k, { configurable: true, set() { throw new Error("zl abort-on-property-write"); } });
    } catch {
      /* refusal only */
    }
  },
  noop: () => {
    /* intentionally does nothing */
  },
};

/* Runs the allowlisted scriptlets against the page realm. Anything
   unknown, oversized, or hostile is counted as refused by the
   worker and never evaluated here. */
export function runScriptlets(g: Record<string, unknown>, list: unknown): void {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length && i < SCRIPTLET_MAX; i++) {
    const inv = list[i] as ScriptletInvocation | null;
    if (!inv || typeof inv !== "object" || typeof inv.name !== "string") continue;
    const base = inv.name.replace(/\.js$/, "");
    const fn = SCRIPTLETS[base];
    if (!fn) continue;
    const args = Array.isArray(inv.args)
      ? inv.args.slice(0, ARG_MAX).map((a) => (typeof a === "string" ? a.slice(0, ARG_LEN) : ""))
      : [];
    try {
      fn(g, { name: base, args });
    } catch {
      /* a scriptlet must never break the page */
    }
  }
}

/* Applies the worker-provided dynamic hide styles. The css string is
   trusted because the worker built it from filter rules, and the
   count is capped for the DIAG report. */
function applyCss(doc: DocLike, state: { style: ElLike | null; lastCss: string; applied: number }, css: string): void {
  if (typeof css !== "string" || !css || css === state.lastCss) return;
  state.lastCss = css;
  const n = css.split("{").length - 1;
  state.applied += Math.min(n, 4096);
  try {
    if (!state.style) {
      const el = doc.createElement("style");
      el.setAttribute(STYLE_ATTR, "");
      state.style = el;
      const host = doc.head || doc.documentElement;
      if (host) host.appendChild(el);
    }
    state.style.textContent = css;
  } catch {
    /* headless or hostile document: the next reply retries */
  }
}

/* One full page-side session. Referenced only by the compiled
   artifact entry (cosmetics-runtime.ts) and by the vitest stand-in
   realm, so the shape is a plain record of well-known globals. */
export function applyCosmeticPage(w: Record<string, unknown>, payload: unknown): void {
  const g = w;
  try {
    runScriptlets(g, (payload as { s?: unknown } | null)?.s);
  } catch {
    /* hostile payload: ignore */
  }
  const nav = g.navigator as { serviceWorker?: { controller?: unknown } } | undefined;
  const ctl = nav?.serviceWorker?.controller as { postMessage(d: unknown, t: unknown[]): void } | undefined;
  if (!ctl || typeof ctl.postMessage !== "function") return;
  const doc = g.document as DocLike | undefined;
  if (!doc || typeof doc.querySelectorAll !== "function") return;
  const MC = g.MessageChannel as (new () => { port1: PortLike; port2: PortLike }) | undefined;
  if (!MC) return;

  const state = { style: null as ElLike | null, lastCss: "", applied: 0 };
  let queries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retriedPending = false;
  let stopped = false;
  let observer: { observe(t: unknown, o: unknown): void; disconnect(): void } | null = null;
  let ask: () => void;

  const collect = (): { classes: string[]; ids: string[] } => {
    const classes = new Set<string>();
    const ids = new Set<string>();
    let els: { length: number; [i: number]: ElLike };
    try {
      els = doc.querySelectorAll("[class],[id]");
    } catch {
      return { classes: [], ids: [] };
    }
    const n = typeof els.length === "number" ? els.length : 0;
    for (let i = 0; i < n && i < TOKEN_ELEMENTS && (classes.size < CLASSES_CAP || ids.size < IDS_CAP); i++) {
      const el = els[i];
      try {
        const it = el.classList?.[Symbol.iterator];
        if (typeof it === "function") {
          for (const c of it.call(el.classList)) {
            if (typeof c === "string" && c.length > 0 && c.length <= TOKEN_LEN) {
              classes.add(c);
              if (classes.size >= CLASSES_CAP) break;
            }
          }
        }
        const id = el.getAttribute("id");
        if (typeof id === "string" && id.length > 0 && id.length <= TOKEN_LEN && ids.size < IDS_CAP) ids.add(id);
      } catch {
        /* hostile element: skip its tokens */
      }
    }
    return { classes: [...classes], ids: [...ids] };
  };

  const send = (msg: Record<string, unknown>): Promise<Reply | null> => new Promise((resolve) => {
    let mc: { port1: PortLike; port2: PortLike };
    try {
      mc = new MC();
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (r: Reply | null) => {
      if (settled) return;
      settled = true;
      try { mc.port1.close(); } catch { /* already closed */ }
      resolve(r);
    };
    mc.port1.onmessage = (ev: { data: unknown }) => done(ev.data as Reply);
    try {
      ctl.postMessage({ type: MSG, ...msg }, [mc.port2]);
    } catch {
      done(null);
      return;
    }
    setTimeout(() => done(null), 5000);
  });

  const teardown = (): void => {
    stopped = true;
    if (observer) {
      try { observer.disconnect(); } catch { /* already gone */ }
      observer = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      if (state.style && state.style.setAttribute) state.style.setAttribute("data-zl-cosmetic-dyn", "off");
    } catch { /* leave the last styles in place */ }
  };

  const finish = (): void => {
    teardown();
    void send({ applied: state.applied, done: true });
  };

  const schedule = (ms: number): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      ask();
    }, ms);
  };

  ask = (): void => {
    if (stopped) return;
    if (queries >= QUERY_BUDGET) {
      finish();
      return;
    }
    queries += 1;
    const toks = collect();
    void send({ classes: toks.classes, ids: toks.ids, applied: state.applied }).then((r) => {
      if (!r || r.ok !== true) return;
      if (r.off === true) {
        teardown();
        return;
      }
      if (r.pending === true) {
        if (!retriedPending) {
          retriedPending = true;
          schedule(PENDING_RETRY_MS);
        }
        return;
      }
      applyCss(doc, state, typeof r.styles === "string" ? r.styles : "");
    });
  };

  const MO = g.MutationObserver as (new (cb: () => void) => { observe(t: unknown, o: unknown): void; disconnect(): void }) | undefined;
  if (MO) {
    try {
      observer = new MO(() => schedule(DEBOUNCE_MS));
      const target = doc.documentElement || doc.head;
      if (target) observer.observe(target, { childList: true, subtree: true });
    } catch {
      observer = null;
    }
  }
  try {
    const addEv = g.addEventListener as ((n: string, fn: () => void) => void) | undefined;
    addEv?.("pagehide", () => finish());
  } catch { /* page without events */ }

  if (doc.readyState === "loading") {
    try {
      doc.addEventListener("DOMContentLoaded", () => ask());
    } catch {
      ask();
    }
  } else {
    ask();
  }
}
