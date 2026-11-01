/* Zeolite extension subsystem: browsingData (#520 slice, #593).

   Firefox's browser.browsingData removes the BROWSER's stored site
   data. This engine owns five such stores service-worker side, and
   they all get real, permission-gated clears:

   - the HTTP/page CacheStorage (removeCache),
   - the virtual cookie jar (removeCookies),
   - the attachment download ring plus the extension handoff
     registry's terminal records (removeDownloads, #593),
   - the virtual-site IndexedDB partition: every `zl:<token>:`
     database on the engine origin (removeIndexedDB, #593),
   - the running guest service-worker realms (removeServiceWorkers,
     #593).

   The download ring and the guest kernel live outside the extensions
   leaf (the request pipeline and the kernel), so their clears mount
   through host-wired hooks - the cacheDropper pattern; the control
   plane wires them at boot. Unwired, those two removers reject
   honestly instead of pretending.

   The remaining Firefox data types (form data, history, localStorage,
   passwords, plugin data) live in stores this engine does not reach
   from the worker - page realms own the engine origin's localStorage
   (a service worker has no localStorage), and the host browser owns
   history, passwords, form data and plugins - so those removers mount
   and REJECT honestly instead of resolving as if they had cleared
   something.

   Shape notes:
   - settings() reports the engine's real capability booleans; the
     types it cannot remove answer false, per Firefox's contract that
     dataTypes tells the caller what remove* will act on.
   - removeCookies honors Firefox's origins filter through the jar's
     scoped clear (one origin at a time, default profile namespace);
     no origins means the whole active profile's jar, exactly like
     Firefox's unfiltered clear. `since` is accepted: the jar keeps no
     per-entry timestamps to filter by, so the clear is whole-store –
     the same documented coarsening the storage quotas carry. A jar
     clear also drops the page cache afterwards, the same safety the
     zl:clearJar control op applies (#179: a cleared jar means cached
     pages may be another session's).
   - removeCache purges every CacheStorage bucket the worker can see
     (the page cache, the profile cache, any future bucket): Firefox's
     removeCache has no origin filter either, and the engine's caches
     all serve proxied content.
   - removeIndexedDB (#593) clears the `zl:<token>:` partition (the
     colon in the prefix is the safety line: engine-own databases like
     `zl-extensions` never match it) and honors the origins filter by
     mapping each origin through the same siteToken() the pages'
     storage scoping uses, in this same worker realm. `since` is
     accepted whole-store, the jar's documented coarsening.
   - removeDownloads (#593) drops terminal ring entries (and the
     handoff registry's terminal records); active streams stay
     tracked, exactly like Firefox keeping an in-progress download.
     The origins and since filters are honored against each entry's
     source origin and end time.
   - removeServiceWorkers (#593) terminates every running guest realm
     (their kernel-side caches die with them). Page-realm
     registration shims are per-page state and are not proactively
     invalidated - the kernel teardown is the truth.
   - The "browsingData" permission gates the whole namespace; without
     it the namespace does not mount, so feature detection answers
     honestly (the notifications/cookies mounting pattern). */

import { jarClear, jarClearScope } from "../cookies";
import { siteToken } from "../pageload";
import { DOWNLOADS } from "./downloads";

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

/* #593: the attachment download ring (app/src/downloads.ts) and the
   guest kernel (kernel/guests/executor.ts) live outside the extensions
   leaf; the control plane wires their clears here the same way. Each
   hook returns how many things it cleared so honest logs (and tests)
   can assert the effect; unwired, the remover rejects honestly. */
let downloadClearer: ((filter: { origins?: string[]; since?: number }) => number) | null = null;
export function setBrowsingDataDownloadClear(
  fn: ((filter: { origins?: string[]; since?: number }) => number) | null,
): void {
  downloadClearer = fn;
}

let guestTerminator: (() => number) | null = null;
export function setBrowsingDataGuestTerminator(fn: (() => number) | null): void {
  guestTerminator = fn;
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

/** Validate Firefox's origins/excludeOrigins pair once for every
    scoped remover: returns the kept plain origins, or null when the
    call is the whole-store clear. Throws Firefox-style TypeErrors on
    malformed input before anything is touched. */
function keptOrigins(options: BrowsingDataOptions): string[] | null {
  const origins = options.origins ?? null;
  if (origins === null) {
    if (options.excludeOrigins) throw new TypeError("zeolite: excludeOrigins requires origins");
    return null;
  }
  if (!Array.isArray(origins)) throw new TypeError("zeolite: origins must be an array");
  const exclude = new Set(options.excludeOrigins ?? []);
  const kept: string[] = [];
  for (const o of origins) {
    if (!isPlainOrigin(o)) throw new TypeError("zeolite: origins entries must be http(s) origins");
    if (!exclude.has(o)) kept.push(o);
  }
  return kept;
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
    downloads: true,
    formData: false,
    history: false,
    /* Reported honestly at call time: the partition clear needs
       indexedDB.databases(), which not every host factory provides
       (never faked, the storage.md rule). */
    indexedDB:
      typeof (globalThis as { indexedDB?: { databases?: unknown } }).indexedDB?.databases === "function",
    localStorage: false,
    passwords: false,
    pluginData: false,
    serviceWorkers: true,
  },
});

export async function browsingDataRemoveCache(_options: BrowsingDataOptions = {}): Promise<void> {
  await purgeAllCaches();
}

export async function browsingDataRemoveCookies(options: BrowsingDataOptions = {}): Promise<void> {
  const kept = keptOrigins(options);
  if (kept !== null) {
    for (const o of kept) {
      const r = jarClearScope(undefined, o);
      if (!r.ok) throw new Error("zeolite: browsingData.removeCookies refused an origin: " + r.error);
    }
  } else {
    jarClear();
  }
  /* #179 safety, shared with zl:clearJar: cached pages could outlive
     the cookies they were captured under. Skipped only if the control
     plane never wired the dropper (see above). */
  if (cacheDropper) await cacheDropper();
}

/** #593: the engine's download history is the attachment ring (plus
    the extension handoff registry's records). Firefox's
    removeDownloads clears the list, not the files the host browser
    already wrote; this is the same shape. Active streams stay
    tracked; the origins/since filters run against each entry's
    source origin and end time. */
export async function browsingDataRemoveDownloads(options: BrowsingDataOptions = {}): Promise<void> {
  if (!downloadClearer) {
    throw new Error("zeolite: no download registry attached to this engine; nothing was cleared");
  }
  const kept = keptOrigins(options);
  downloadClearer({ ...(kept === null ? {} : { origins: kept }), ...(typeof options.since === "number" ? { since: options.since } : {}) });
  /* The handoff registry is worker-side extension state; its terminal
     records drop with the same filter shape. */
  DOWNLOADS.clearHistory({ since: options.since });
}

/** #593: virtual-site IndexedDB lives as `zl:<site-token>:<name>`
    databases on the engine origin (docs/storage.md); the worker
    shares that origin, so the partition is enumerable and deletable
    from here. The colon in the prefix is the safety line: engine-own
    databases (`zl-extensions`) never match it. The origins filter
    maps through siteToken() - the same function, in the same worker
    realm, that minted the tokens the pages' storage shims use, so a
    keyed realm and the degraded keyless mode both match. A database a
    page still holds open blocks natively; the deletion stays queued
    and lands when the connection closes (documented coarsening, not
    a fake success). `since` is accepted whole-store, the jar's
    documented coarsening. */
export async function browsingDataRemoveIndexedDB(options: BrowsingDataOptions = {}): Promise<void> {
  const idb = (
    globalThis as {
      indexedDB?: {
        databases?: () => Promise<Array<{ name?: string }>>;
        deleteDatabase(name: string): IDBOpenDBRequest;
      };
    }
  ).indexedDB;
  if (!idb || typeof idb.databases !== "function") {
    throw new Error("zeolite: indexedDB.databases() is not available in this context; nothing was cleared");
  }
  const kept = keptOrigins(options);
  const prefixes = kept === null ? null : kept.map((o) => "zl:" + siteToken(o) + ":");
  const names = (await idb.databases()).map((d) => d.name).filter((n): n is string => typeof n === "string");
  const targets = names.filter(
    (n) => n.startsWith("zl:") && (prefixes === null || prefixes.some((p) => n.startsWith(p))),
  );
  await Promise.all(
    targets.map(
      (n) =>
        new Promise<void>((resolve, reject) => {
          const req = idb.deleteDatabase(n);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error ?? new Error("zeolite: indexeddb delete failed for " + n));
          /* a live page connection blocks the delete; it stays queued
             and completes when the connection closes */
          req.onblocked = () => resolve();
        }),
    ),
  );
}

/** #593: the engine's "service worker registrations" for proxied
    sites are the running guest realms (kernel-side, session-scoped;
    their caches die with them). Terminating them is the honest engine
    equivalent of Firefox's removeServiceWorkers. Wired by the host
    (the kernel lives outside the extensions leaf); unwired it rejects
    honestly. */
export function browsingDataRemoveServiceWorkers(): Promise<void> {
  if (!guestTerminator) {
    return Promise.reject(
      new Error("zeolite: no guest kernel attached to this engine; nothing was cleared"),
    );
  }
  guestTerminator();
  return Promise.resolve();
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
