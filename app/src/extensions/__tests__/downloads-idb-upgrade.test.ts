import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

/* #541: the extension DB version bump 4 -> 5 adds the
   download-handoffs store. The upgrade path only CREATES missing
   stores, so a v4 database's stores and data must survive untouched.
   This lives in its own file because the upgrade needs a fresh
   fake-indexeddb universe where the DB has never been opened at v5. */

import { openDb, idbGet, idbGetAllKeys, STORE_DOWNLOADS, STORE_HANDOFFS, STORE_META } from "../idb";

describe("the v5 upgrade path (#541)", () => {
  it("adds download-handoffs without touching existing v4 stores or data", async () => {
    /* first contact: create the DB exactly as a v4 build would have,
       then let openDb() upgrade it. */
    const v4 = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("zl-extensions", 4);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ["meta", "files", "storage", "cookies", "downloads", "download-partials"]) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = v4.transaction(STORE_META, "readwrite");
      tx.objectStore(STORE_META).put("keep-me", "installed");
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    });
    v4.close();
    const db = await openDb();
    expect([...db.objectStoreNames]).toContain(STORE_HANDOFFS);
    /* pre-existing data survives */
    expect(await idbGet(db, STORE_META, "installed")).toBe("keep-me");
    /* the engine's own store is present and untouched */
    expect(await idbGetAllKeys(db, STORE_DOWNLOADS)).toEqual([]);
  });
});
