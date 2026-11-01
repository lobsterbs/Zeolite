/* Page-realm mint client + re-emission patch (#54 residuals 2-3).

   The zl:mint seam (#60) lets the engine mint a keyed engine route
   for a destination, the key never leaving the worker realm. This
   module is the page-side consumer half:

   - mintRoute(dest) asks the engine controller for an opaque route.
     Every caller falls back to the legacy-decodable route when the
     mint fails (no controller, timeout, refusal): the fallback is the
     documented degrade, never a hang.
   - applyReemit(w) wraps the page's subresource seams (fetch,
     navigator.sendBeacon, XMLHttpRequest, EventSource) so their
     inputs are minted routes and the plaintext destination leaves no
     browser-visible request record (CDP, devtools, performance
     entries). The engine's fetch handler intercepts cross-origin
     subresources from controlled pages regardless; re-emission's
     value is the records. Honest residuals stay classified: sync
     XHR, Request-object inputs, mint-failure fallbacks.

   Successes memoize per destination (in-flight calls share one
   request); a failed mint is deleted from the memo so a retry after
   the worker settles can succeed. */

import { makeRel, tokenShaped } from "./navguard";
import { NativeURL } from "./anchorshim";
import { controlQuery } from "./controlquery";

type AnyRecord = Record<string, any>;

/* #294: the worker realm's exact class (#229) - a long-lived SPA
   mints keyed/query-stringed endpoints and the memo grew without
   bound for the document's lifetime. Capped, LRU eviction; a
   dropped entry only costs a re-mint round trip. */
const MINT_MEMO_CAP = 256;
const memo = new Map<string, Promise<string | null>>();

/** Mint an engine route for an absolute http(s) destination. Resolves
    the route, or null when no controller exists, the reply is
    malformed, or the engine refuses. */
export function mintRoute(dest: string, nav = false, timeout = 5000): Promise<string | null> {
  /* #511: the two callers need different shapes for the same dest -
     a navigation write wants the query handle, a re-emission input
     must stay opaque - so the memo key carries the shape. */
  const key = nav ? "nav:" + dest : dest;
  const hit = memo.get(key);
  if (hit) {
    // LRU by recency: re-insert so eviction order tracks usage.
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const p = new Promise<string | null>((resolve) => {
    controlQuery(nav ? { type: "zl:mint", dest, nav: true } : { type: "zl:mint", dest }, (m) => {
      resolve(typeof m?.route === "string" ? m.route : null);
    }, timeout);
  });
  if (memo.size >= MINT_MEMO_CAP) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, p);
  p.then((route) => {
    /* #459: delete only OUR entry - an evicted promise settling
       after a newer mint for the same dest must not drop it. */
    if (!route && memo.get(key) === p) memo.delete(key);
  });
  return p;
}

/** #54 residual 2: wrap the page's subresource seams so cross-origin
    inputs ride minted engine routes instead of plaintext URLs. */
/** #157: the top-level proxied page anchors its own re-emissions
    the same way the nav guard anchors a child realm. Only an
    engine-route-shaped pathname anchors (a /__zl_ marker route or
    a token-bearing scheme route); a non-route same-origin context
    (the demo page, devtools) stays inert. */
export function routeAnchor(loc: string): string | undefined {
  let p: string;
  try {
    p = new NativeURL(loc).pathname;
  } catch {
    return undefined;
  }
  return p.startsWith("/__zl_") || tokenShaped(p) ? p : undefined;
}

export function applyReemit(w: Record<string, unknown>, parentRoutePath?: string): void {
  const loc = w.location as { href: string; origin: string } | undefined;
  if (!loc || typeof loc.href !== "string") return;
  /* Absolute http(s) URL off the page origin, resolved against the
     page URL - or null (engine-local, relative, opaque, garbage). */
  const crossDest = (v: string): string | null => {
    let u: URL;
    try {
      u = new NativeURL(v, loc.href);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.origin === loc.origin) return null;
    return u.href;
  };

  /* #101: a same-origin child realm (an about:blank iframe the
     page's own JS created) carries no virtual context and its
     about:blank referrer is undecodable, so root-relative and
     relative inputs used to escape to the engine origin and 404.
     Anchored to the parent page's engine route path, such inputs
     re-emit as <parent route>/<NAVP>/<encodeURIComponent(input)>:
     the SW decodes the parent route and resolves the tail against
     its destination. Absolute and scheme inputs are unchanged
     (crossDest / native), engine-route-shaped paths stay native,
     and without an anchor nothing changes. */
  const relRoute = makeRel(parentRoutePath, loc.origin);

  /* Internal label stays on engine-routed requests. */
  const mark = (init: RequestInit | undefined, kind: string): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("x-zl-i", kind);
    return { ...init, headers };
  };

  /* Request-object inputs keep their one-shot/native semantics; URL
     inputs can be labeled after an engine route is known. */
  const OF = w.fetch as typeof fetch | undefined;
  if (typeof OF === "function") {
    w.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
      if (url === null) return OF(input, init);
      const rel = relRoute(url);
      const d = rel ? null : crossDest(url);
      if ((rel || d) && init?.integrity) init = { ...init, integrity: undefined };
      if (rel) return OF(rel, init);
      if (!d) return OF(input, init);
      return mintRoute(d).then((route) =>
        OF((route ?? url) as RequestInfo, route ? mark(init, "fetch") : init),
      );
    };
  }

  /* sendBeacon(): the native contract queues and returns true, it
     does not deliver; the shim keeps the optimistic true and posts
     on the minted route (keepalive). A refused mint falls back to
     the native beacon (no first request left the page), and so does
     a beacon fired during unload: a deferred mint cannot land once
     the page is torn down, but the native beacon is queued past it.
     A rejected POST is never replayed (#457): delivery uncertain. */
  /* pagehide (not unload: also covers the back/forward cache). */
  let unloading = false;
  const wadd = (w as { addEventListener?: (t: string, l: () => void) => void })
    .addEventListener;
  if (typeof wadd === "function") wadd.call(w, "pagehide", () => { unloading = true; });
  /* #458: pageshow clears the latch - a bfcache-restored page keeps
     minting instead of falling back to the native beacon forever. */
  if (typeof wadd === "function") wadd.call(w, "pageshow", () => { unloading = false; });
  const navg = w.navigator as
    | { sendBeacon?: (u: string | URL, d?: BodyInit | null) => boolean }
    | undefined;
  const OB = navg && typeof navg.sendBeacon === "function" ? navg.sendBeacon : undefined;
  if (navg && OB) {
    const native = (u: string | URL, d?: BodyInit | null): boolean => {
      try {
        return OB.call(navg, u, d ?? null);
      } catch {
        return false;
      }
    };
    navg.sendBeacon = function (u: string | URL, d?: BodyInit | null): boolean {
      const s = typeof u === "string" ? u : u instanceof URL ? u.href : null;
      if (s === null || unloading) return native(u, d);
      /* one POST helper for the minted and the #101 parent-relative
         path: optimistic true, native fallback on a refused POST */
      const post = (t: string): boolean => {
        if (!OF) return false;
        OF(t, mark({ method: "POST", body: d ?? null, keepalive: true }, "beacon")).catch(() => {
          /* #457: a rejected POST may already be accepted upstream;
             replaying a non-idempotent beacon natively risks a double
             write. One attempt: the beacon is honestly lost on
             uncertain delivery. */
        });
        return true;
      };
      const rel = relRoute(s);
      if (rel) return post(rel) || native(u, d);
      const dest = crossDest(s);
      if (!dest) return native(u, d);
      mintRoute(dest).then((route) => {
        if (!route || unloading || !post(route)) native(u, d);
      });
      return true;
    };
  }

  /* XMLHttpRequest: the open is deferred to send() and re-opened on
     the minted route; queued headers flush in order. Sync XHR cannot
     wait (native, documented residual); engine-local opens go
     native. A second open cancels a pending re-emit. */
  const OX = w.XMLHttpRequest as AnyRecord | undefined;
  if (OX && typeof OX.prototype.open === "function") {
    type Pend = {
      method: string;
      url: string;
      user: string | null;
      pw: string | null;
      headers: Array<[string, string]>;
    };
    const OOpen = OX.prototype.open as (...a: unknown[]) => unknown;
    const OHdr = OX.prototype.setRequestHeader as (...a: unknown[]) => unknown;
    const OSend = OX.prototype.send as (...a: unknown[]) => unknown;
    const pend = new WeakMap<object, Pend>();
    OX.prototype.open = function (this: AnyRecord, ...a: unknown[]) {
      const s =
        typeof a[1] === "string" ? a[1] : a[1] instanceof URL ? (a[1] as URL).href : String(a[1] ?? "");
      const isAsync = a[2] === undefined || a[2] === true;
      const dest = isAsync ? crossDest(s) : null;
      if (!dest) {
        pend.delete(this);
        delete this.readyState;
        /* #101: a parent-relative open rewrites the URL directly;
           no mint, no deferred re-open - the SW decodes the parent
           route. Sync opens stay native (the async flag is a[2]). */
        const rel = isAsync ? relRoute(s) : null;
        const result = rel
          ? OOpen.call(this, a[0], rel, a[2], a[3], a[4])
          : OOpen.apply(this, a);
        return result;
      }
      pend.set(this, {
        method: String(a[0]),
        url: dest,
        user: a[3] == null ? null : String(a[3]),
        pw: a[4] == null ? null : String(a[4]),
        headers: [],
      });
      /* Native open() reports OPENED synchronously; the deferred
         re-open would leave readyState at UNSENT until the mint
         lands, a visible drift for apps polling it. An own getter
         shadows the prototype's until the minted re-open, a
         canceling open() or an abort() deletes it. The rest of the
         response surface (status, responseText) keeps its native
         UNSENT behavior, a documented residual. */
      Object.defineProperty(this, "readyState", {
        configurable: true,
        enumerable: false,
        get: () => 1,
      });
    };
    OX.prototype.setRequestHeader = function (this: AnyRecord, ...a: unknown[]) {
      const st = pend.get(this);
      if (st) {
        st.headers.push([String(a[0]), String(a[1])]);
        return;
      }
      return OHdr.apply(this, a);
    };
    OX.prototype.send = function (this: AnyRecord, ...a: unknown[]) {
      const st = pend.get(this);
      if (!st) return OSend.apply(this, a);
      const self = this;
      mintRoute(st.url).then((route) => {
        if (pend.get(self) !== st) return;
        pend.delete(self);
        delete self.readyState;
        OOpen.call(self, st.method, route ?? st.url, true, st.user, st.pw);
        if (route) OHdr.call(self, "x-zl-i", "xhr");
        for (const h of st.headers) OHdr.call(self, h[0], h[1]);
        OSend.apply(self, a);
      });
    };
    /* abort() during a pending re-emit cancels it: without this the
       mint would resolve and re-open a request the app aborted. The
       own OPENED patch above is removed first, so the native abort
       sees the real UNSENT state; deleting an absent own prop is a
       no-op. The native abort is optional: the wrapped constructor
       may lack one (the test realm's fake does), and the cancel
       itself must not throw. */
    const OAbort = OX.prototype.abort as ((...a: unknown[]) => unknown) | undefined;
    OX.prototype.abort = function (this: AnyRecord, ...a: unknown[]) {
      pend.delete(this);
      delete this.readyState;
      return OAbort?.apply(this, a);
    };
  }

  /* EventSource: the constructor defers to the minted route; a close
     before the mint lands constructs nothing (no request at all,
     not a native one). on* handlers and listeners forward to the
     real source when it exists. */
  const OES = w.EventSource as
    | (new (u: string, o?: { withCredentials?: boolean }) => EventSource)
    | undefined;
  if (OES) {
    const CES = OES;
    const SHIM = function (this: AnyRecord, target0: string, o?: { withCredentials?: boolean }) {
      const es = new EventTarget() as AnyRecord;
      const on: Record<string, ((e: unknown) => unknown) | undefined> = {};
      /* #274: a removable registry maps every shim listener (function or
         EventListener object, keyed by type+listener+capture like the
         native list) to one native wrapper on the real source. */
      type Reg = {
        type: string;
        l: EventListenerOrEventListenerObject;
        o?: unknown;
        cap: boolean;
        w: (e: unknown) => void;
      };
      const regs: Reg[] = [];
      let real: EventSource | null = null;
      let closed = false;
      const creds = !!(o && o.withCredentials);
      const bindOn = (type: string) => {
        if (real)
          (real as AnyRecord)["on" + type] = (e: unknown) => {
            try {
              on[type]?.call(es, e);
            } catch {
              /* contained, like a native handler */
            }
          };
      };
      const attach = (u: string) => {
        real = new CES(u, { withCredentials: creds });
        for (const type of Object.keys(on)) bindOn(type);
        if (typeof (real as AnyRecord).addEventListener === "function")
          for (const r of regs) (real as AnyRecord).addEventListener(r.type, r.w, r.o);
      };
      const nativeAdd = es.addEventListener.bind(es) as (...a: unknown[]) => void;
      const nativeRemove = es.removeEventListener.bind(es) as (...a: unknown[]) => void;
      /* instanceof parity: the EventTarget keeps its internal slots
         and adopts the real prototype (SHIM.prototype is that same
         prototype); the own on-handler, readyState, url and close
         props below shadow its brand-checked accessors. The swap
         lands after the native listener is bound: until the own
         patches exist the EventTarget methods are only reachable
         through the prototype chain, and a replaced constructor's
         prototype need not extend EventTarget (the test realm's
         does not). */
      Object.setPrototypeOf(es, CES.prototype);
      const isListener = (l: unknown): l is EventListenerOrEventListenerObject =>
        typeof l === "function" ||
        (!!l && typeof (l as { handleEvent?: unknown }).handleEvent === "function");
      const capOf = (o: unknown) =>
        !!(o === true || (o && typeof o === "object" && (o as AnyRecord).capture));
      const run = (l: EventListenerOrEventListenerObject, e: unknown) => {
        try {
          if (typeof l === "function") (l as (ev: unknown) => void).call(es, e);
          else (l as { handleEvent: (ev: unknown) => void }).handleEvent(e);
        } catch {
          /* contained */
        }
      };
      const drop = (r: Reg) => {
        const i = regs.indexOf(r);
        if (i >= 0) regs.splice(i, 1);
        if (real && typeof (real as AnyRecord).removeEventListener === "function")
          (real as AnyRecord).removeEventListener(r.type, r.w, r.o);
      };
      es.addEventListener = function (this: AnyRecord, ...a: unknown[]) {
        const type = String(a[0]);
        if (isListener(a[1])) {
          const o = a[2];
          const once = !!(o && typeof o === "object" && (o as AnyRecord).once);
          const sig = o && typeof o === "object" ? (o as AnyRecord).signal : undefined;
          if (sig && (sig as AbortSignal).aborted) return nativeAdd(...a);
          if (!regs.some((r) => r.type === type && r.l === a[1] && r.cap === capOf(o))) {
            const l = a[1] as EventListenerOrEventListenerObject;
            const r: Reg = { type, l, o, cap: capOf(o), w: (e) => run(l, e) };
            if (once) r.w = (e) => { run(l, e); drop(r); };
            if (sig) (sig as AbortSignal).addEventListener("abort", () => drop(r), { once: true });
            regs.push(r);
            if (real && typeof (real as AnyRecord).addEventListener === "function")
              (real as AnyRecord).addEventListener(type, r.w, o);
          }
        }
        return nativeAdd(...a);
      };
      es.removeEventListener = function (this: AnyRecord, ...a: unknown[]) {
        const type = String(a[0]);
        if (isListener(a[1])) {
          const i = regs.findIndex(
            (r) => r.type === type && r.l === a[1] && r.cap === capOf(a[2]),
          );
          if (i >= 0) {
            const [r] = regs.splice(i, 1);
            if (real && typeof (real as AnyRecord).removeEventListener === "function")
              (real as AnyRecord).removeEventListener(r.type, r.w, r.o);
          }
        }
        return nativeRemove(...a);
      };
      for (const type of ["open", "message", "error"]) {
        Object.defineProperty(es, "on" + type, {
          configurable: true,
          enumerable: true,
          get: () => on[type],
          set: (fn: unknown) => {
            on[type] = fn as (e: unknown) => unknown | undefined;
            bindOn(type);
          },
        });
      }
      Object.defineProperties(es, {
        readyState: {
          get: () => (real ? (real as AnyRecord).readyState : closed ? 2 : 0),
          configurable: true,
          enumerable: true,
        },
        url: {
          get: () => (real ? (real as AnyRecord).url : target0),
          configurable: true,
          enumerable: true,
        },
        withCredentials: { get: () => creds, configurable: true, enumerable: true },
        close: {
          value: () => {
            closed = true;
            if (real) (real as AnyRecord).close?.();
          },
          configurable: true,
          enumerable: true,
        },
      });
      const dest = crossDest(target0);
      const rel = relRoute(target0);
      if (rel) attach(rel);
      else if (!dest) attach(target0);
      else
        mintRoute(dest).then((route) => {
          if (!closed) attach(route ?? target0);
        });
      return es;
    } as unknown as new (u: string, o?: { withCredentials?: boolean }) => EventSource;
    (SHIM as AnyRecord).CONNECTING = 0;
    (SHIM as AnyRecord).OPEN = 1;
    (SHIM as AnyRecord).CLOSED = 2;
    (SHIM as AnyRecord).prototype = CES.prototype;
    w.EventSource = SHIM;
  }
}
