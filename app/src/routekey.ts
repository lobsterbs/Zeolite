/* SW-realm storage for the opaque route key (issue #55).
   #606 settled the honest trust model: the bootstrap's storage shim is
   namespacing, not isolation. A same-origin proxied script can always
   reach an unwrapped storage factory through window.parent, window.top
   or an about:blank iframe it creates itself (which inherits the
   engine origin), so this record must be treated as readable by
   proxied code. No client-side mechanism can seal origin storage
   against same-origin scripts; the alternative custodies fail
   analysis: a backend escrow needs an auth model an anonymous engine
   does not have, memory-only custody strands every route on the
   ~30s SW idle termination (the exact #55 strand class), and
   split-origin hosting does not block the about:blank path. The
   key's secrecy targets are therefore the browser UI, history and
   cross-origin observers, never the proxied page's own scripts.
   Storage unavailable = no key = the legacy codec stays active. That
   is the documented degraded mode, never a silent failure: routes are
   then decodable by the browser, which is what #55 exists to stop.
   Decode keeps a key HISTORY (the "history" record): a restart that
   mints a fresh key prepends it, and decode accepts every key minted
   this deployment, so already-handed routes survive a rotation
   instead of stranding (the rotated-route half of #55). A pre-history
   record store migrates: the lone "route" record becomes the
   one-entry history. Transient IDB failures get one retry each read:
   a flaky read must not mint a fresh key and strand old routes. */
const DB_NAME = "zl-route";
const STORE = "keys";
const KEY_ID = "route";
const HIST_ID = "history";
/* Decode accepts the newest KEY_HISTORY_LIMIT keys; minting always
   uses the newest. */
const KEY_HISTORY_LIMIT = 16;

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

function getBytes(db: IDBDatabase, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("zl-route get failed"));
  });
}

function putBytes(db: IDBDatabase, id: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("zl-route put failed"));
    tx.onabort = () => reject(tx.error ?? new Error("zl-route put aborted"));
  });
}

/* One retry on a failed read: a transient IDB failure must not be
   mistaken for a missing record (a fresh mint would strand every
   route minted so far). */
async function getBytesRetry(db: IDBDatabase, id: string): Promise<unknown> {
  try {
    return await getBytes(db, id);
  } catch {
    return await getBytes(db, id);
  }
}

/** The persisted 16-byte route key, or null (first boot, storage
    unavailable, or a corrupt record: all degrade to legacy). */
export async function loadRouteKey(): Promise<Uint8Array | null> {
  try {
    const db = await openDb();
    const got = await getBytesRetry(db, KEY_ID);
    return got instanceof Uint8Array && got.byteLength === 16 ? got : null;
  } catch {
    return null;
  }
}

/** Every key this deployment minted, newest first. Decode accepts all
    of them, so a restart that mints a fresh key keeps routes minted
    under old keys working. A pre-history record store migrates: the
    lone "route" record becomes the one-entry history. Storage
    unavailable degrades to null (#399: a failed read is NOT first
    boot - [] would make the caller mint over it and strand every
    route minted before the restart; null tells the caller to keep
    its in-memory keys and retry). */
export async function loadRouteHistory(): Promise<Uint8Array[] | null> {
  try {
    const db = await openDb();
    const raw = await getBytesRetry(db, HIST_ID);
    if (Array.isArray(raw)) {
      return raw.filter((k): k is Uint8Array => k instanceof Uint8Array && k.byteLength === 16);
    }
    const cur = await getBytesRetry(db, KEY_ID);
    return cur instanceof Uint8Array && cur.byteLength === 16 ? [cur] : [];
  } catch {
    /* #399: a transient storage failure is not first boot. [] here
       made routeRestore mint a fresh key and replace the in-memory
       decode set with it alone. */
    return null;
  }
}

/** Persist the 16-byte route key as current and prepend it to the
    decode history. Rejects when storage is unavailable; the caller
    keeps the legacy codec then. */
export async function saveRouteKey(bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  let hist: Uint8Array[] = [];
  if (bytes instanceof Uint8Array && bytes.byteLength === 16) {
    const raw = await getBytesRetry(db, HIST_ID);
    if (Array.isArray(raw)) {
      hist = raw.filter((k): k is Uint8Array => k instanceof Uint8Array && k.byteLength === 16);
    }
    if (hist[0] !== bytes) hist.unshift(bytes);
    if (hist.length > KEY_HISTORY_LIMIT) hist.length = KEY_HISTORY_LIMIT;
  }
  await putBytes(db, KEY_ID, bytes);
  await putBytes(db, HIST_ID, hist);
}
