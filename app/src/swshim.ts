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
  waiting: VirtualWorker | null;
  active: VirtualWorker | null;
  update(): Promise<VirtualRegistration>;
  unregister(): Promise<boolean>;
}

export interface SwShimStore {
  get(): string | null;
  set(v: string): void;
  clear(): void;
}

function scopeFor(pageUrl: string, scope?: string): string {
  const origin = new URL(pageUrl).origin;
  try {
    const s = new URL(scope ?? "", pageUrl).href;
    return s.startsWith(origin) ? s : origin + "/";
  } catch {
    return origin + "/";
  }
}

function registration(scriptURL: string, scope: string, store: SwShimStore, settled: boolean): VirtualRegistration {
  const worker: VirtualWorker = { scriptURL, state: settled ? "activated" : "installing" };
  const reg: VirtualRegistration = {
    scope,
    installing: settled ? null : worker,
    waiting: null,
    active: settled ? worker : null,
    update: () => Promise.resolve(reg),
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
  const rec = { scriptURL: new URL(String(scriptURL), pageUrl).href, scope: scopeFor(pageUrl, options?.scope) };
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
     this page's registration, even if it landed in this store. */
  if (!rec.scope.startsWith(new URL(pageUrl).origin)) return undefined;
  if (scope !== undefined && rec.scope !== scopeFor(pageUrl, scope)) return undefined;
  return registration(rec.scriptURL, rec.scope, store, true);
}

/** Patch a real ServiceWorkerContainer in place: register,
    getRegistration and getRegistrations become virtual, `ready`
    resolves with the virtual registration (a synthetic one when
    nothing was registered, so awaiting ready never hangs). controller
    and events stay untouched: they belong to the engine's real
    worker. */
export function swShimApply(container: object, store: SwShimStore, pageUrl: string): void {
  const c = container as Record<string, unknown>;
  c.register = ((u: string | URL, o?: { scope?: string }) =>
    Promise.resolve(swShimRegister(store, pageUrl, u, o))) as unknown;
  c.getRegistration = ((s?: string) =>
    Promise.resolve(swShimGet(store, pageUrl, s))) as unknown;
  c.getRegistrations = (() => {
    const r = swShimGet(store, pageUrl);
    return Promise.resolve(r ? [r] : []);
  }) as unknown;
  try {
    const origin = new URL(pageUrl).origin;
    Object.defineProperty(c, "ready", {
      configurable: true,
      get: () =>
        Promise.resolve(
          swShimGet(store, pageUrl) ?? registration(origin + "/zl-synthetic.js", origin + "/", store, true),
        ),
    });
  } catch {
    /* ready stays native: some engines make it read-only */
  }
}
