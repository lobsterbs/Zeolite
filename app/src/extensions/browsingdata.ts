/* Zeolite extension subsystem: browsingData (#520 slice).

   Firefox's browser.browsingData removes the BROWSER's stored site
   data. This engine owns exactly two such stores service-worker
   side: the HTTP/page CacheStorage and the virtual cookie jar. Those
   two get real, permission-gated clears. Every other Firefox data
   type (downloads, form data, history, IndexedDB, localStorage,
   passwords, plugin data, service worker registrations) lives in a
   store this engine does not reach from the worker — page realms own
   their storage, the download/history surfaces are host-side — so
   the remaining documented removers mount and REJECT honestly instead
   of resolving as if they had cleared something.

   Shape notes:
   - settings() reports the engine's real capability booleans; the
     types it cannot remove answer false, per Firefox's contract that
     dataTypes tells the caller what remove* will act on.
   - removeCookies honors Firefox's origins filter through the jar's
     scoped clear (one origin at a time, default profile namespace);
     no origins means the whole active profile's jar, exactly like
     Firefox's unfiltered clear. `since` is accepted: the jar keeps no
     per-entry timestamps to filter by, so the clear is whole-store —
     the same documented coarsening the storage quotas carry. A jar
     clear also drops the page cache afterwards, the same safety the
     zl:clearJar control op applies (#179: a cleared jar means cached
     pages may be another session's).
   - removeCache purges every CacheStorage bucket the worker can see
     (the page cache, the profile cache, any future bucket): Firefox's
     removeCache has no origin filter either, and the engine's caches
     all serve proxied content.
   - The "browsingData" permission gates the whole namespace; without
     it the namespace does not mount, so feature detection answers
     honestly (the notifications/cookies mounting pattern). */

import { jarClear, jarClearScope } from "../cookies";

/** Firefox's documented browsingData.RemovalOptions, as far as this
    slice can honor it. */
export interface BrowsingDataOptions {
  since?: number;
  origins?: string[];
  excludeOrigins?: string[];
}

/** The data types Firefox's settings() reports. */
export interface BrowsingDataTypes {
  cache: boolean;
  cookies: boolean;
  downloads: boolean;
  formData: boolean;
  history: boolean;
  indexedDB: boolean;
  localStorage: boolean;
  passwords: boolean;
  pluginData: boolean;
  serviceWorkers: boolean;
}

/* The #179 safety (a cleared jar means cached pages may be another
   session's) needs the engine's page-cache clear, but this module must
   not drag the whole request pipeline into the extension graph (the
   extensions subsystem stays a leaf the worker can load and test
   alone). The control plane - which already imports both worlds -
   wires the real dropper at boot; unwired, the clear still runs and
   the drop is skipped, which the compat entry documents. */
let cacheDropper: (() => Promise<void>) | null = null;
export function setBrowsingDataCacheDropper(fn: (() => Promise<void>) | null): void {
  cacheDropper = fn;
}

const UNREACHABLE_REASON =
  "zeolite: this browsingData type lives in a store the engine's worker cannot reach (page realms or host UI own it); nothing was cleared";

function isPlainOrigin(o: unknown): o is string {
  if (typeof o !== "string" || o.length === 0 || o.length > 512) return false;
  try {
    const u = new URL(o);
    return (u.protocol === "https:" || u.protocol === "http:") && u.pathname === "/" && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** Drop every CacheStorage bucket the worker can see; resolves with
    the number of buckets removed so tests (and honest logs) can
    assert the effect. Storage failures propagate: a clear that could
    not run rejects instead of pretending. */
export async function purgeAllCaches(): Promise<number> {
  const cs = (globalThis as { caches?: { keys(): Promise<string[]>; delete(n: string): Promise<boolean> } }).caches;
  if (!cs) throw new Error("zeolite: no CacheStorage in this context");
  const names = await cs.keys();
  await Promise.all(names.map((n) => cs.delete(n)));
  return names.length;
}

export const browsingDataSettings = (): { options: Record<string, never>; dataTypes: BrowsingDataTypes } => ({
  options: {},
  dataTypes: {
    cache: true,
    cookies: true,
    downloads: false,
    formData: false,
    history: false,
    indexedDB: false,
    localStorage: false,
    passwords: false,
    pluginData: false,
    serviceWorkers: false,
  },
});

export async function browsingDataRemoveCache(_options: BrowsingDataOptions = {}): Promise<void> {
  await purgeAllCaches();
}

export async function browsingDataRemoveCookies(options: BrowsingDataOptions = {}): Promise<void> {
  const origins = options.origins ?? null;
  if (origins !== null) {
    if (!Array.isArray(origins)) throw new TypeError("zeolite: origins must be an array");
    const exclude = new Set(options.excludeOrigins ?? []);
    for (const o of origins) {
      if (!isPlainOrigin(o)) throw new TypeError("zeolite: origins entries must be http(s) origins");
      if (exclude.has(o)) continue;
      const r = jarClearScope(undefined, o);
      if (!r.ok) throw new Error("zeolite: browsingData.removeCookies refused an origin: " + r.error);
    }
  } else {
    if (options.excludeOrigins) throw new TypeError("zeolite: excludeOrigins requires origins");
    jarClear();
  }
  /* #179 safety, shared with zl:clearJar: cached pages could outlive
     the cookies they were captured under. Skipped only if the control
     plane never wired the dropper (see above). */
  if (cacheDropper) await cacheDropper();
}

/** The documented removers whose stores the worker cannot reach. They
    exist so an extension's call shape matches Firefox (no TypeError
    on a documented method) and reject with the reason instead of
    resolving as if data had been cleared. */
export function browsingDataUnreachable(kind: string): () => Promise<never> {
  return async () => {
    throw new Error(UNREACHABLE_REASON + " (" + kind + ")");
  };
}
