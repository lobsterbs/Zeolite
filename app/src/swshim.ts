/* navigator.serviceWorker shim (Phase 6, 1.6 Hydride).

 A browser allows exactly one real service worker registration per
 scope, and the engine owns this scope. A proxied page's
 navigator.serviceWorker API is therefore virtualized: registrations
 are per-origin records kept in the site-scoped storage the bootstrap
 installs, and the state machine advances on microtasks so
 shape-matching libraries keep working.

 #576: the shim is truthful end to end. The JS-literal rewriter mints
 the page's URL literals into engine token routes, so register() can
 arrive with an opaque engine URL as its script or scope argument;
 engine-origin arguments are decoded back to the virtual destination
 over zl:decodeRoutes (page-admitted, bounded worker-side) before
 validation. A registration that runs before the virtual-origin
 marker lands is queued behind a bounded wait for the virtual base
 and fails closed with a native-style TypeError when it never
 arrives: it is never resolved against the raw engine route. The
 register forward rides a reply port, and the promise settles only
 when the kernel confirms the guest realm is running (or rejects
 with the kernel's stable failure reason), so a successful
 registration always means an executable guest worker exists.

 Honest limits, by design: controller stays the engine's real
 worker, and the fake states skip the real waiting periods. */
import { NativeURL } from "./bootstrap/anchorshim";

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

/* #477 wave 3: the virtual registration is now also forwarded, best
   effort, to the engine's real controller, which spawns the page's
   guest realm on the guest-host page. The forward never changes the
   virtual promise shape, and a missing or silent controller leaves
   the virtual semantics unchanged. The worker re-derives the page
   origin from the sender route, so the payload grants the page no
   power beyond its own registration. */
let guestCtl: { postMessage(m: unknown): void } | null = null;

function guestForward(m: Record<string, unknown>): void {
  try {
    if (guestCtl) guestCtl.postMessage(m);
  } catch {
    /* best-effort: the virtual registration stands either way */
  }
}

export interface SwShimStore {
  get(): string | null;
  set(v: string): void;
  clear(): void;
}

/* #576: page-realm dependencies the relay wires in: the engine
   origin (to recognize rewriter-minted token arguments), the bounded
   zl:decodeRoutes oracle, and the reply-port register forward. All
   optional: without them the shim keeps the wave-3 sync contract. */
export interface SwShimDeps {
  engineOrigin?: string;
  baseWaitMs?: number;
  decodeRoutes?: (routes: string[]) => Promise<(string | null)[] | null>;
  forwardRegister?: (payload: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string } | null>;
  forwardUnregister?: (payload: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string } | null>;
}

/* #474: exact-origin compare - the old startsWith(origin) prefix test
   admitted lookalike hosts. #473: the DEFAULT scope is the script
   directory, like the native container; an explicit scope resolves
   against the page. Cross-origin or malformed inputs throw TypeError
   like the native register. */
function scopeFor(pageUrl: string, scope: string | undefined, scriptHref: string): string {
  const pageOrigin = new NativeURL(pageUrl).origin;
  if (scope === undefined) {
    const s = new NativeURL("./", scriptHref);
    if (s.origin !== pageOrigin) {
      throw new TypeError("Origin");
    }
    return s.href;
  }
  let s: URL | null = null;
  try {
    s = new NativeURL(scope, pageUrl);
  } catch {
    /* malformed below */
  }
  if (!s || s.origin !== pageOrigin) {
    throw new TypeError("Origin");
  }
  return s.href;
}

type StoredRegistration = { scriptURL: string; scope: string };

function storedRecords(store: SwShimStore): StoredRegistration[] {
  const raw = store.get();
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.filter((r): r is StoredRegistration =>
      !!r && typeof r === "object" &&
      typeof r.scriptURL === "string" && typeof r.scope === "string"
    );
  } catch {
    return [];
  }
}

function writeStoredRecords(store: SwShimStore, records: StoredRegistration[]): void {
  if (records.length) store.set(JSON.stringify(records));
  else store.clear();
}

function putStoredRecord(store: SwShimStore, record: StoredRegistration): void {
  const records = storedRecords(store).filter((r) => r.scope !== record.scope);
  records.push(record);
  writeStoredRecords(store, records);
}

function removeStoredRecord(store: SwShimStore, scope: string, scriptURL: string): void {
  const records = storedRecords(store).filter((r) => r.scope !== scope || r.scriptURL !== scriptURL);
  writeStoredRecords(store, records);
}

function recordsForOrigin(store: SwShimStore, pageUrl: string): StoredRegistration[] {
  const origin = new NativeURL(pageUrl).origin;
  return storedRecords(store).filter((record) => {
    try {
      const script = new NativeURL(record.scriptURL);
      const scope = new NativeURL(record.scope);
      const badPath = /%(?:2f|5c)/i;
      return script.origin === origin && scope.origin === origin &&
        /^https?:$/.test(script.protocol) && /^https?:$/.test(scope.protocol) &&
        script.href === record.scriptURL && scope.href === record.scope &&
        !badPath.test(script.pathname) && !badPath.test(scope.pathname) &&
        !script.hash && !scope.hash && !scope.search &&
        !script.username && !script.password;
    } catch {
      return false;
    }
  });
}

function registration(
  scriptURL: string,
  scope: string,
  store: SwShimStore,
  settled: boolean,
  deps?: SwShimDeps,
): VirtualRegistration {
  const worker: VirtualWorker = { scriptURL, state: settled ? "activated" : "installing" };
  const reg: VirtualRegistration = {
    scope,
    installing: settled ? null : worker,
    active: settled ? worker : null,
    unregister: async () => {
      if (deps?.forwardUnregister) {
        const result = await deps.forwardUnregister({
          type: "zl:guestUnregister",
          scriptURL,
          scope,
        }).catch(() => null);
        if (!result || result.ok !== true) return false;
      } else {
        guestForward({ type: "zl:guestUnregister", scriptURL, scope });
      }
      removeStoredRecord(store, scope, scriptURL);
      return true;
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

/** Validate and canonicalize a registration WITHOUT storing it.
    #576: the store is written only after the kernel confirms the
    guest realm, so a rejected registration leaves prior records
    intact. */
export function swShimRecord(
  pageUrl: string,
  scriptURL: string | URL,
  options?: { scope?: string },
): { scriptURL: string; scope: string } {
  /* #474: a cross-origin or malformed script URL is a native-style
     TypeError, never a foreign registration. */
  let script: URL | null = null;
  try {
    script = new NativeURL(scriptURL + "", pageUrl);
  } catch {
    /* malformed below */
  }
  if (!script || script.origin !== new NativeURL(pageUrl).origin) {
    throw new TypeError("Origin");
  }
  return { scriptURL: script.href, scope: scopeFor(pageUrl, options?.scope, script.href) };
}

/** register(): record the (per-origin) registration and return a live
    one whose worker settles installing -> activated. */
export function swShimRegister(
  store: SwShimStore,
  pageUrl: string,
  scriptURL: string | URL,
  options?: { scope?: string },
): VirtualRegistration {
  const rec = swShimRecord(pageUrl, scriptURL, options);
  putStoredRecord(store, rec);
  return registration(rec.scriptURL, rec.scope, store, false);
}

/** Native getRegistration takes a client URL, not a scope URL. The
    longest same-origin scope containing that client wins. */
export function swShimGet(
  store: SwShimStore,
  pageUrl: string,
  clientUrl?: string,
  deps?: SwShimDeps,
): VirtualRegistration | undefined {
  let target: URL;
  try {
    target = new NativeURL(clientUrl ?? pageUrl, pageUrl);
  } catch {
    return undefined;
  }
  const origin = new NativeURL(pageUrl).origin;
  if (target.origin !== origin) return undefined;
  const rec = recordsForOrigin(store, pageUrl)
    .filter((candidate) => {
      try {
        const scope = new NativeURL(candidate.scope);
        return scope.origin === origin && target.pathname.startsWith(scope.pathname);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.scope.length - a.scope.length)[0];
  return rec ? registration(rec.scriptURL, rec.scope, store, true, deps) : undefined;
}

function swShimGetAll(
  store: SwShimStore,
  pageUrl: string,
  deps?: SwShimDeps,
): VirtualRegistration[] {
  return recordsForOrigin(store, pageUrl)
    .sort((a, b) => a.scope.localeCompare(b.scope))
    .map((r) => registration(r.scriptURL, r.scope, store, true, deps));
}

/** #538: the page-URL basis for the shim. Wave 3 captured the raw
    engine route at bootstrap, so a page's register("sw.js") resolved
    against the opaque route base and the kernel could never
    canonicalize the result - the guest never spawned. The basis is
    now supplied lazily: relay.ts resolves the page's virtual origin
    (__zlVO, installed by the virtual-origin marker) plus the injected
    vpath at call time and falls back to the captured raw URL while
    either is still unknown. An empty resolution fails closed: register
    rejects with a native-style TypeError and the getters resolve
    undefined instead of trusting a foreign record. */
export type SwShimPageBase = string | (() => string);

function shimPageBase(pageUrl: SwShimPageBase): string {
  let v = "";
  try {
    v = typeof pageUrl === "function" ? pageUrl() : pageUrl;
  } catch {
    v = "";
  }
  return typeof v === "string" && v ? v : "";
}

function originOf(u: string): string | null {
  try {
    return new NativeURL(u).origin;
  } catch {
    return null;
  }
}

/* #576: engine-origin arguments are rewriter-minted token routes:
   ask the worker to decode them back to the virtual destination.
   Anything else passes through untouched; a token that fails to
   decode fails closed with a native-style TypeError. */
async function decodeEngineArg(deps: SwShimDeps | undefined, value: string): Promise<string> {
  if (!deps || !deps.engineOrigin || !deps.decodeRoutes) return value;
  if (originOf(value) !== deps.engineOrigin) return value;
  const dests = await deps.decodeRoutes([value]).catch(() => null);
  const d = dests && dests[0];
  if (typeof d !== "string" || !d) throw new TypeError("Origin");
  return d;
}

/* #576: the virtual base may not be ready at the earliest moment
   page JavaScript can run (the marker lands asynchronously). Wait a
   bounded time for it; the raw engine route is never handed back for
   a registration, and a base that never lands fails closed as empty
   (which swShimRecord rejects). */
async function readyVirtualBase(pageUrl: SwShimPageBase, deps: SwShimDeps | undefined): Promise<string> {
  let b = shimPageBase(pageUrl);
  if (!deps || !deps.engineOrigin || originOf(b) !== deps.engineOrigin) return b;
  const deadline = Date.now() + (deps.baseWaitMs ?? 2000);
  while (originOf(b) === deps.engineOrigin) {
    if (Date.now() >= deadline) return "";
    await new Promise((r) => setTimeout(r, 25));
    b = shimPageBase(pageUrl);
  }
  return b;
}

export function swShimApply(
  container: object,
  store: SwShimStore,
  pageUrl: SwShimPageBase,
  deps?: SwShimDeps,
): void {
  const c = container as Record<string, unknown>;
  try {
    const ctl = c.controller;
    guestCtl = ctl && typeof (ctl as { postMessage?: unknown }).postMessage === "function"
      ? (ctl as { postMessage(m: unknown): void })
      : null;
  } catch {
    guestCtl = null;
  }
  c.register = ((u: string | URL, o?: { scope?: string }) => {
    /* #474: a native-style rejected promise, not a sync throw. */
    return (async () => {
      const script = await decodeEngineArg(deps, u + "");
      const scope = o && o.scope != null ? await decodeEngineArg(deps, o.scope + "") : undefined;
      const base = await readyVirtualBase(pageUrl, deps);
      const rec = swShimRecord(base, script, scope === undefined ? undefined : { scope });
      if (deps?.forwardRegister) {
        /* #576: settle from the kernel reply only: ok means the guest
           realm is running; a rejection carries the stable failure
           reason and stores nothing. */
        const fwd = await deps.forwardRegister({
          type: "zl:guestRegister",
          scriptURL: rec.scriptURL,
          scope: rec.scope,
        }).catch(() => null);
        if (!fwd || fwd.ok !== true) {
          const reason = fwd && typeof fwd.error === "string" && fwd.error
            ? fwd.error
            : "service worker registration failed";
          throw new TypeError(reason);
        }
        putStoredRecord(store, rec);
      } else {
        /* Wave-3 best-effort forward for callers without deps. */
        putStoredRecord(store, rec);
        guestForward({ type: "zl:guestRegister", scriptURL: rec.scriptURL, scope: rec.scope });
      }
      return registration(rec.scriptURL, rec.scope, store, false, deps);
    })();
  }) as unknown;
  c.getRegistration = ((s?: string) => {
    return (async () => {
      const scope = s != null ? await decodeEngineArg(deps, s) : undefined;
      const b = await readyVirtualBase(pageUrl, deps);
      return b ? swShimGet(store, b, scope, deps) : undefined;
    })();
  }) as unknown;
  c.getRegistrations = (() => {
    return (async () => {
      const b = await readyVirtualBase(pageUrl, deps);
      return b ? swShimGetAll(store, b, deps) : [];
    })();
  }) as unknown;
  try {
    Object.defineProperty(c, "ready", {
      configurable: true,
      get: () => readyVirtualBase(pageUrl, deps).then((b) => (b ? swShimGet(store, b) : undefined)),
    });
  } catch {
    /* ready stays native: some engines make it read-only */
  }
}
