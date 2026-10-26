/* navigator.serviceWorker shim (Phase 6, 1.6 Hydride).

 A browser allows exactly one real service worker registration per
 scope, and the engine owns this scope. A proxied page's
 navigator.serviceWorker API is therefore virtualized: registrations
 are per-origin records kept in the site-scoped storage the bootstrap
 installs, and the state machine advances on microtasks so
 shape-matching libraries keep working.

 Honest limits, by design: no virtual worker script is ever fetched
 or executed, no fetch/message events reach a virtual registration,
 `controller` stays the engine's real worker, and the fake states skip
 the real waiting periods. */

export interface VirtualWorker {
  scriptURL: string;
  state: string;
}

export interface VirtualRegistration {
  scope: string;
  installing: VirtualWorker | null;
  active: VirtualWorker | null;
  unregister(): Promise<boolean>;
}

export interface SwShimStore {
  get(): string | null;
  set(v: string): void;
  clear(): void;
}

/* #474: exact-origin compare - the old startsWith(origin) prefix test
   admitted lookalike hosts (https://a.example.evil/). #473: the
   DEFAULT scope is the script directory, like the native container;
   an explicit scope resolves against the page. Cross-origin or
   malformed inputs throw TypeError like the native register. */
function scopeFor(pageUrl: string, scope: string | undefined, scriptHref: string): string {
  const pageOrigin = new URL(pageUrl).origin;
  if (scope === undefined) {
    const s = new URL("./", scriptHref);
    if (s.origin !== pageOrigin) {
      throw new TypeError("Worker scope must be same-origin");
    }
    return s.href;
  }
  let s: URL | null = null;
  try {
    s = new URL(scope, pageUrl);
  } catch {
    /* malformed below */
  }
  if (!s || s.origin !== pageOrigin) {
    throw new TypeError("Worker scope must be same-origin");
  }
  return s.href;
}

function registration(scriptURL: string, scope: string, store: SwShimStore, settled: boolean): VirtualRegistration {
  const worker: VirtualWorker = { scriptURL, state: settled ? "activated" : "installing" };
  const reg: VirtualRegistration = {
    scope,
    installing: settled ? null : worker,
    active: settled ? worker : null,
    unregister: () => {
      store.clear();
      return Promise.resolve(true);
    },
  };
  if (!settled) {
    void Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        worker.state = "activated";
        reg.installing = null;
        reg.active = worker;
      });
  }
  return reg;
}

/** register(): record the (per-origin) registration and return a live
    one whose worker settles installing -> activated. */
export function swShimRegister(
  store: SwShimStore,
  pageUrl: string,
  scriptURL: string | URL,
  options?: { scope?: string },
): VirtualRegistration {
  /* #474: a cross-origin or malformed script URL is a native-style
     TypeError, never a foreign registration. */
  let script: URL | null = null;
  try {
    script = new URL(scriptURL + "", pageUrl);
  } catch {
    /* malformed below */
  }
  if (!script || script.origin !== new URL(pageUrl).origin) {
    throw new TypeError("The Service Worker script is outside the page origin");
  }
  const rec = { scriptURL: script.href, scope: scopeFor(pageUrl, options?.scope, script.href) };
  store.set(JSON.stringify(rec));
  return registration(rec.scriptURL, rec.scope, store, false);
}

/** getRegistration(): the recorded registration in its settled shape.
    Undefined when this origin never registered, the record scopes a
    foreign origin, or the requested scope does not match. */
export function swShimGet(
  store: SwShimStore,
  pageUrl: string,
  scope?: string,
): VirtualRegistration | undefined {
  const raw = store.get();
  if (raw === null) return undefined;
  let rec: { scriptURL: string; scope: string };
  try {
    rec = JSON.parse(raw) as { scriptURL: string; scope: string };
  } catch {
    return undefined;
  }
  /* Defense in depth: a record that scopes a foreign origin is not
     this page's registration, even if it landed in this store.
     #474: exact-origin compare - a prefix test admitted lookalikes. */
  let scopeUrl: URL | null = null;
  try {
    scopeUrl = new URL(rec.scope);
  } catch {
    return undefined;
  }
  if (scopeUrl.origin !== new URL(pageUrl).origin) return undefined;
  if (scope != null) {
    try {
      if (rec.scope !== scopeFor(pageUrl, scope, rec.scriptURL)) return undefined;
    } catch {
      return undefined;
    }
  }
  return registration(rec.scriptURL, rec.scope, store, true);
}

/** Patch a real ServiceWorkerContainer in place: register,
    getRegistration and getRegistrations become virtual, `ready`
    resolves with the virtual registration when one exists (undefined
    otherwise: it never hangs). controller and events stay untouched:
    they belong to the engine's real worker. */
export function swShimApply(container: object, store: SwShimStore, pageUrl: string): void {
  const c = container as Record<string, unknown>;
  c.register = ((u: string | URL, o?: { scope?: string }) => {
    /* #474: a native-style rejected promise, not a sync throw. */
    try {
      return Promise.resolve(swShimRegister(store, pageUrl, u, o));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as unknown;
  c.getRegistration = ((s?: string) =>
    Promise.resolve(swShimGet(store, pageUrl, s))) as unknown;
  c.getRegistrations = (() => {
    const r = swShimGet(store, pageUrl);
    return Promise.resolve(r ? [r] : []);
  }) as unknown;
  try {
    Object.defineProperty(c, "ready", {
      configurable: true,
      get: () => Promise.resolve(swShimGet(store, pageUrl)),
    });
  } catch {
    /* ready stays native: some engines make it read-only */
  }
}
