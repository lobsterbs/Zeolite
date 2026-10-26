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

type StoredRegistration = { scriptURL: string; scope: string };

/** Read old single-record storage and new multi-scope storage alike.
    A page-controlled store must never forge cross-origin registrations.
    Keep parsing and enumeration bounded; a corrupt record is ignored. */
function registrations(store: SwShimStore, pageUrl: string): StoredRegistration[] {
  const raw = store.get();
  if (!raw || raw.length > 131072) return [];
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return []; }
  const candidates = Array.isArray(value) ? value.slice(0, 64) : [value];
  const origin = new URL(pageUrl).origin;
  const byScope = new Map<string, StoredRegistration>();
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.scriptURL !== "string" || typeof r.scope !== "string") continue;
    try {
      const script = new URL(r.scriptURL);
      const scope = new URL(r.scope);
      if (script.origin !== origin || scope.origin !== origin ||
          scope.search || scope.hash) continue;
      byScope.set(scope.href, { scriptURL: script.href, scope: scope.href });
    } catch { /* invalid or foreign registration */ }
  }
  return [...byScope.values()];
}

function registration(scriptURL: string, scope: string, store: SwShimStore, settled: boolean): VirtualRegistration {
  const worker: VirtualWorker = { scriptURL, state: settled ? "activated" : "installing" };
  const reg: VirtualRegistration = {
    scope,
    installing: settled ? null : worker,
    active: settled ? worker : null,
    unregister: () => {
      const list = registrations(store, scriptURL);
      const remaining = list.filter(r => r.scope !== scope);
      const removed = remaining.length !== list.length;
      if (removed) {
        if (remaining.length) store.set(JSON.stringify(remaining));
        else store.clear();
      }
      return Promise.resolve(removed);
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

/** Each virtual origin can own multiple independent scopes, like a
    native ServiceWorkerContainer. Re-registering one scope updates it
    without deleting unrelated registrations. */
export function swShimRegister(
  store: SwShimStore,
  pageUrl: string,
  scriptURL: string | URL,
  options?: { scope?: string },
): VirtualRegistration {
  let script: URL | null = null;
  try { script = new URL(scriptURL + "", pageUrl); }
  catch { /* malformed below */ }
  if (!script || script.origin !== new URL(pageUrl).origin) {
    throw new TypeError("The Service Worker script is outside the page origin");
  }
  const rec = { scriptURL: script.href, scope: scopeFor(pageUrl, options?.scope, script.href) };
  const existing = registrations(store, pageUrl).filter(r => r.scope !== rec.scope);
  if (existing.length >= 64) throw new TypeError("Virtual worker registration limit reached");
  store.set(JSON.stringify([...existing, rec]));
  return registration(rec.scriptURL, rec.scope, store, false);
}

/** Native getRegistration(clientURL) selects the longest *covering*
    registration scope, not a record whose scope equals clientURL.
    Same-origin URL resolution and scope comparison are both required. */
export function swShimGet(
  store: SwShimStore,
  pageUrl: string,
  clientURL?: string,
): VirtualRegistration | undefined {
  let url: URL;
  try { url = new URL(clientURL ?? pageUrl, pageUrl); }
  catch { return undefined; }
  if (url.origin !== new URL(pageUrl).origin) return undefined;
  const requested = url.origin + url.pathname;
  const match = registrations(store, pageUrl)
    .filter(r => requested.startsWith(new URL(r.scope).origin + new URL(r.scope).pathname))
    .sort((a, b) => b.scope.length - a.scope.length)[0];
  return match ? registration(match.scriptURL, match.scope, store, true) : undefined;
}

/** Native getRegistrations() enumerates *all* same-origin scopes.
    This API is separate from current-page coverage checks. */
export function swShimList(store: SwShimStore, pageUrl: string): VirtualRegistration[] {
  return registrations(store, pageUrl).map(r => registration(r.scriptURL, r.scope, store, true));
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
  c.getRegistrations = (() =>
    Promise.resolve(swShimList(store, pageUrl))) as unknown;
  try {
    Object.defineProperty(c, "ready", {
      configurable: true,
      get: () => Promise.resolve(swShimGet(store, pageUrl)),
    });
  } catch {
    /* ready stays native: some engines make it read-only */
  }
}
