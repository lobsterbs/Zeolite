import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idbPut, openDb, STORE_COOKIES } from "../extensions/idb";
import {
  cookiesResetForTests,
  cookieHeaderFor,
  documentCookieWrite,
  jarClearScope,
  jarEnumeration,
  jarLoad,
  setJarProfile,
} from "../cookies";

/* #365: jars persisted before the #267 client-isolation wave are keyed
   "<raw profile>\u0000<origin id>", which matches no namespace the new
   code computes. jarLoad must rekey them under the legacy namespace so
   the profile paths (header, enumeration, clear) reach them again. */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

const SEP = "\u0000";

describe("legacy pre-isolation jar keys (#365)", () => {
  it("loads an old raw-profile record under the legacy namespace and clears by name", async () => {
    /* Obtain one real stored-cookie shape through the live write path. */
    documentCookieWrite("https://old.example/", "old=v; Path=/");
    const cookie = jarEnumeration()[0]!.origins[0]!.cookies[0]!;
    const origin = "https://old.example/";
    const oldId = "pre-fnv-id"; /* any persisted id shape */
    const db = await openDb();
    await idbPut(db, STORE_COOKIES, "origins", [[oldId, origin]]);
    await idbPut(db, STORE_COOKIES, "jar", [["oldprof" + SEP + oldId, [cookie]]]);
    await jarLoad();
    /* The migrated record is reachable once the profile is the active
       global one (the clientless path the pre-isolation world used). */
    expect(setJarProfile("oldprof")).toEqual({ ok: true, profile: "oldprof" });
    expect(cookieHeaderFor(origin)).toBe("old=v");
    expect(jarEnumeration().find((p) => p.profile === "oldprof")?.cookies).toBe(1);
    /* zl:clearJar of the named profile actually deletes the migrated
       records instead of leaving them re-persisting forever. */
    expect(jarClearScope("oldprof", undefined, undefined)).toMatchObject({ ok: true, jars: 1, cookies: 1 });
    expect(cookieHeaderFor(origin)).toBe(null);
  });
});
