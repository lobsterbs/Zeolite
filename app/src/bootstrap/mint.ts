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

import { swc } from "./siteid";

type AnyRecord = Record<string, any>;

const memo = new Map<string, Promise<string | null>>();

/** Mint an engine route for an absolute http(s) destination. Resolves
    the route, or null when no controller exists, the reply is
    malformed, or the engine refuses. */
export function mintRoute(dest: string, timeout = 5000): Promise<string | null> {
  const hit = memo.get(dest);
  if (hit) return hit;
  const p = new Promise<string | null>((resolve) => {
    const ctl = swc();
    if (!ctl) {
      resolve(null);
      return;
    }
    const ch = new MessageChannel();
    let done = false;
    const fin = (route: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(route);
    };
    const timer = setTimeout(() => fin(null), timeout);
    ch.port1.onmessage = (ev) => {
      const m = ev.data as { ok?: boolean; route?: unknown };
      fin(typeof m?.route === "string" ? m.route : null);
    };
    try {
      ctl.postMessage({ type: "zl:mint", dest }, [ch.port2]);
    } catch {
      fin(null);
    }
  });
  memo.set(dest, p);
  p.then((route) => {
    if (!route) memo.delete(dest);
  });
  return p;
}

/** #54 residual 2: wrap the page's subresource seams so cross-origin
    inputs ride minted engine routes instead of plaintext URLs. */
export function applyReemit(w: Record<string, unknown>): void {
  const loc = w.location as { href: string; origin: string } | undefined;
  if (!loc || typeof loc.href !== "string") return;
  /* Absolute http(s) URL off the page origin, resolved against the
     page URL - or null (engine-local, relative, opaque, garbage). */
  const crossDest = (v: string): string | null => {
    let u: URL;
    try {
      u = new URL(v, loc.href);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.origin === loc.origin) return null;
    return u.href;
  };

  /* fetch(): string/URL inputs re-emit through the minted route;
     Request objects carry one-shot bodies (native, documented
     residual); engine-local inputs stay native. */
  const OF = w.fetch as typeof fetch | undefined;
  if (typeof OF === "function") {
    w.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
      if (url === null) return OF(input, init);
      const d = crossDest(url);
      if (!d) return OF(input, init);
      /* #77 runtime half: the SW returns the rewritten body, which
         never matches the upstream hash; SRI in the init would fail
         the re-emitted fetch as a network error. Request objects
         stay native (documented one-shot-body residual). */
      if (init?.integrity) init = { ...init, integrity: undefined };
      return mintRoute(d).then((route) => OF((route ?? url) as RequestInfo, init));
    };
  }

  /* sendBeacon(): the native contract queues and returns true, it
     does not deliver; the shim keeps the optimistic true and posts
     on the minted route (keepalive). A refused mint or a rejected
     POST falls back to the native beacon, and so does a beacon
     fired during unload: a deferred mint cannot land once the page
     is torn down, but the native beacon is queued past it. */
  /* pagehide (not unload: also covers the back/forward cache). */
  let unloading = false;
  const wadd = (w as { addEventListener?: (t: string, l: () => void) => void })
    .addEventListener;
  if (typeof wadd === "function") wadd.call(w, "pagehide", () => { unloading = true; });
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
      if (s === null) return native(u, d);
      const dest = crossDest(s);
      if (!dest || unloading) return native(u, d);
      mintRoute(dest).then((route) => {
        if (!route || !OF || unloading) {
          native(u, d);
          return;
        }
        OF(route, { method: "POST", body: d ?? null, keepalive: true }).catch(() => native(u, d));
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
      const dest = a[2] === undefined || a[2] === true ? crossDest(s) : null;
      if (!dest) {
        pend.delete(this);
        delete this.readyState;
        return OOpen.apply(this, a);
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
      const listen: Record<string, Array<(e: unknown) => void>> = {};
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
          for (const type of Object.keys(listen))
            for (const cb of listen[type])
              (real as AnyRecord).addEventListener(type, (e: unknown) => {
                try {
                  cb.call(es, e);
                } catch {
                  /* contained */
                }
              });
      };
      const nativeAdd = es.addEventListener.bind(es) as (...a: unknown[]) => void;
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
      es.addEventListener = function (this: AnyRecord, ...a: unknown[]) {
        const type = String(a[0]);
        if (typeof a[1] === "function") {
          (listen[type] ?? (listen[type] = [])).push(a[1] as (e: unknown) => void);
          if (real && typeof (real as AnyRecord).addEventListener === "function")
            (real as AnyRecord).addEventListener(type, (e: unknown) => {
              try {
                (a[1] as (e: unknown) => void).call(es, e);
              } catch {
                /* contained */
              }
            });
        }
        return nativeAdd(...a);
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
      if (!dest) attach(target0);
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
