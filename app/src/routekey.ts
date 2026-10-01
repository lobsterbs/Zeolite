/* SW-realm storage for the opaque route key (issue #55).

   The key must never leave the service worker realm. The route shape
   persists in Cache Storage (sw.ts), but a cache entry is readable by
   any same-origin context that can construct a fetch, so the key uses
   an IndexedDB record instead: the bootstrap's storage isolation keeps
   proxied pages off engine-owned databases, and the host page has no
   reason to look - it mints opaque routes through zl:mint instead.

   Storage unavailable = no key = the legacy codec stays active. That
   is the documented degraded mode, never a silent failure: routes are
   then decodable by the browser, which is what #55 exists to stop. */

const DB_NAME = "zl-route";
const STORE = "keys";
const KEY_ID = "route";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("zl-route open failed"));
  });
}

/** The persisted 16-byte route key, or null (first boot, storage
    unavailable, or a corrupt record: all degrade to legacy). */
export async function loadRouteKey(): Promise<Uint8Array | null> {
  try {
    const db = await openDb();
    const got = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY_ID);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("zl-route get failed"));
    });
    return got instanceof Uint8Array && got.byteLength === 16 ? got : null;
  } catch {
    return null;
  }
}

/** Persist the 16-byte route key. Rejects when storage is
    unavailable; the caller keeps the legacy codec then. */
export async function saveRouteKey(bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(bytes, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("zl-route put failed"));
    tx.onabort = () => reject(tx.error ?? new Error("zl-route put aborted"));
  });
}
