/* Zeolite extension subsystem: minimal promise-wrapped IndexedDB.

   Service workers have no localStorage, so IndexedDB is the persistence
   layer for installed extension packages, metadata and extension
   storage. Kept deliberately tiny: no schema migrations beyond a
   version bump with a recreate. */

const DB_NAME = "zl-extensions";
const DB_VERSION = 2;
export const STORE_META = "meta";
export const STORE_FILES = "files";
export const STORE_STORAGE = "storage";
export const STORE_COOKIES = "cookies";

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("zeolite: indexeddb open failed"));
  });
  return dbp;
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
