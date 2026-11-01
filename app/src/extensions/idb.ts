/* Zeolite extension subsystem: minimal promise-wrapped IndexedDB.

   Service workers have no localStorage, so IndexedDB is the persistence
   layer for installed extension packages, metadata and extension
   storage. Kept deliberately tiny: the upgrade path only creates
   missing stores, so a version bump never destroys existing data. */

const DB_NAME = "zl-extensions";
/* #541: v5 adds the download-handoffs store (extension download
   handoff persistence). The upgrade path below only CREATES missing
   stores, so every v4 store (meta/files/storage/cookies/downloads/
   download-partials) and its data survives untouched. */
const DB_VERSION = 5;
export const STORE_META = "meta";
export const STORE_FILES = "files";
export const STORE_STORAGE = "storage";
export const STORE_COOKIES = "cookies";
export const STORE_DOWNLOADS = "downloads";
/* #118: partial download bytes per registry entry id. */
export const STORE_PARTIALS = "download-partials";
/* #541: extension download handoff records (downloads.download() ->
   host zl:downloadState), keyed by handoff id. State only - never
   file bytes. */
export const STORE_HANDOFFS = "download-handoffs";

let dbp: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
      if (!db.objectStoreNames.contains(STORE_STORAGE)) db.createObjectStore(STORE_STORAGE);
      if (!db.objectStoreNames.contains(STORE_COOKIES)) db.createObjectStore(STORE_COOKIES);
      if (!db.objectStoreNames.contains(STORE_DOWNLOADS)) db.createObjectStore(STORE_DOWNLOADS);
      if (!db.objectStoreNames.contains(STORE_PARTIALS)) db.createObjectStore(STORE_PARTIALS);
      if (!db.objectStoreNames.contains(STORE_HANDOFFS)) db.createObjectStore(STORE_HANDOFFS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      /* #541: a failed open must not wedge every later call behind a
         cached rejection; the next open retries. */
      dbp = null;
      reject(req.error ?? new Error("zeolite: indexeddb open failed"));
    };
  });
  return dbp;
}

/* #541 (tests): drop the cached connection so a fresh open - or a
   stubbed open failure - can actually be exercised. */
export function resetDbForTests(): void {
  dbp = null;
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("zeolite: indexeddb request failed"));
  });
}

export async function idbGet(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return wrap(tx(db, store, "readonly").get(key));
}

export async function idbGetAll(db: IDBDatabase, store: string): Promise<unknown[]> {
  return wrap(tx(db, store, "readonly").getAll());
}

export async function idbGetAllKeys(db: IDBDatabase, store: string): Promise<string[]> {
  const req = tx(db, store, "readonly").getAllKeys();
  return (await wrap(req)) as string[];
}

export async function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  await wrap(tx(db, store, "readwrite").put(value, key));
}

export async function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  await wrap(tx(db, store, "readwrite").delete(key));
}

export async function idbClear(db: IDBDatabase, store: string): Promise<void> {
  await wrap(tx(db, store, "readwrite").clear());
}
