import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fnv1a } from "../bootstrap/siteid";
import {
  cookieHeaderFor,
  cookiesResetForTests,
  jarLoad,
  jarPersist,
  registerOrigin,
} from "../cookies";
import { openDb, idbGet, idbPut, STORE_COOKIES } from "../extensions/idb";

/* #270: the site/origin hash used double-precision multiplication,
   which collided for distinct origins (both hashed to "sgb2js"),
   merging two virtual sites into one storage scope. */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

/* The OLD (colliding) implementation, kept here to build
   pre-migration records in tests. */
function fnv1aLegacy(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h * 0x01000193;
  }
  return h.toString(36);
}

describe("site id hashing (#270)", () => {
  it("does not collide on the known colliding pair", () => {
    const a = "https://c221470sg.test";
    const b = "https://eto8f6qoq.test";
    expect(fnv1aLegacy(a)).toBe(fnv1aLegacy(b)); /* the old bug */
    expect(fnv1a(a)).not.toBe(fnv1a(b));
  });

  it("gives distinct registerOrigin ids to distinct origins", () => {
    const a = registerOrigin("https://c221470sg.test");
    const b = registerOrigin("https://eto8f6qoq.test");
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(registerOrigin("https://c221470sg.test/path").id);
  });

  it("migrates old-hash jar keys via the persisted origins record", async () => {
    const origin = "https://migrate.example";
    const oldId = fnv1aLegacy(origin);
    const cookie = {
      name: "m",
      value: "1",
      domain: "migrate.example",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      expires: 4102444800000,
      created: Date.now(),
      sameSite: "no_restriction",
    };
    const db = await openDb();
    await idbPut(db, STORE_COOKIES, "jar", [[oldId, [cookie]]]);
    await idbPut(db, STORE_COOKIES, "origins", [[oldId, origin]]);
    await jarLoad();
    expect(cookieHeaderFor(origin)).toBe("m=1");
    /* and the re-persisted record carries the new id */
    await jarPersist();
    const rec = (await idbGet(db, STORE_COOKIES, "jar")) as Array<[string, unknown[]]>;
    expect(rec[0][0]).toBe(registerOrigin(origin).id);
  });
});
