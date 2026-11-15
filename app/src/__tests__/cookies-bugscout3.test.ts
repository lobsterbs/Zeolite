/* Cookie-jar bug-scout #3 (#614 family): the restore/clear seams.
   Two defects found by the third sweep; each pin asserts the honest
   behavior, the fix rides the same PR.

   1. zl:clearJar(origin) only deletes the origin's own bucket: a
      Domain cookie set by a sibling origin lives in the SIBLING's
      bucket while still attaching to the cleared origin (#337/#49
      class - jarRemoveIdentities already spans buckets for the same
      reason). Clearing example.com left sid=1 attaching to it.
   2. isStoredCookie shape-checks restored/imported records but never
      their content: a CR/LF in a name/value/domain/path of a
      persisted or host-imported record bypasses the #349 admission
      gate entirely and re-opens the poisoned Cookie-header class
      from inside the store. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  jarClearScope,
  jarLoad,
  jarMerge,
  jarReplace,
  registerOrigin,
} from "../cookies";
import { openDb, idbPut, STORE_COOKIES } from "../extensions/idb";

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

function rec(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "clean",
    value: "1",
    domain: "a.example",
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: null,
    expires: 0,
    created: 1_735_689_600_000,
    ...over,
  };
}

describe("bugscout3: a scope clear spans buckets (the #337/#49 cross-bucket class)", () => {
  it("clears a sibling-stored Domain cookie of the cleared origin", () => {
    applySetCookie("https://sub.example.com/", resp(["sid=1; Domain=example.com; Path=/"]));
    applySetCookie("https://example.com/", resp(["own=2"]));
    /* pre-fix the Domain cookie lives in sub's bucket and survives a
       clear of example.com: the header still attaches it. */
    const r = jarClearScope(undefined, "https://example.com/");
    expect(r.ok).toBe(true);
    expect(r.cookies).toBe(2);
    expect(cookieHeaderFor("https://example.com/")).toBeNull();
    /* record-level semantics: the Domain cookie is gone everywhere */
    expect(cookieHeaderFor("https://sub.example.com/")).toBeNull();
  });

  it("keeps scopes that do not apply to the cleared origin", () => {
    applySetCookie("https://sub.example.com/", resp(["sub=3"]));
    applySetCookie("https://sub.example.com/", resp(["dsc=5; Domain=sub.example.com; Path=/"]));
    const r = jarClearScope(undefined, "https://example.com/");
    expect(r.ok).toBe(true);
    expect(r.cookies).toBe(0);
    expect(cookieHeaderFor("https://sub.example.com/")).toBe("sub=3; dsc=5");
    expect(cookieHeaderFor("https://example.com/")).toBeNull();
  });

  it("a bare-id scope keeps the bucket clear (unchanged)", () => {
    applySetCookie("https://x.example/", resp(["x=1"]));
    const id = registerOrigin("https://x.example").id;
    const r = jarClearScope(undefined, id);
    expect(r).toMatchObject({ ok: true, jars: 1, cookies: 1 });
    expect(cookieHeaderFor("https://x.example/")).toBeNull();
  });

  it("the whole-profile clear is unchanged", () => {
    applySetCookie("https://a.example/", resp(["a=1"]));
    applySetCookie("https://sub.a.example/", resp(["b=1; Domain=a.example; Path=/"]));
    const r = jarClearScope(undefined, undefined);
    expect(r).toMatchObject({ ok: true, cookies: 2 });
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });
});

describe("bugscout3: restored and imported records are content-gated (the #349 class behind admission)", () => {
  it("jarMerge drops a control-character value", () => {
    const aId = registerOrigin("https://a.example").id;
    const r = jarMerge(
      [[aId, [rec({ name: "sid", value: "1\r\nX-Evil: 1" }), rec({ name: "tab", value: "a\tb" })]]],
      "import-wins",
    );
    expect(r.cookies).toBe(0);
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("jarMerge drops control characters in the name and domain", () => {
    const aId = registerOrigin("https://a.example").id;
    const r = jarMerge([[aId, [rec({ name: "a\r\nb" }), rec({ name: "d", domain: "a.exa\r\nmple" })]]], "import-wins");
    expect(r.cookies).toBe(0);
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("jarMerge keeps clean records in the same import", () => {
    const aId = registerOrigin("https://a.example").id;
    const r = jarMerge([[aId, [rec({ name: "bad", value: "x\x00y" }), rec({ name: "good", value: "1" })]]], "import-wins");
    expect(r.cookies).toBe(1);
    expect(cookieHeaderFor("https://a.example/")).toBe("good=1");
  });

  it("jarReplace drops a control-character record", () => {
    const aId = registerOrigin("https://a.example").id;
    jarReplace([[aId, [rec({ name: "sid", value: "1\nEvil: 1" })]]]);
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("jarLoad drops a poisoned persisted record and keeps its clean neighbors", async () => {
    const aId = registerOrigin("https://a.example").id;
    const db = await openDb();
    await idbPut(db, STORE_COOKIES, "jar", [
      [aId, [rec({ name: "clean" }), rec({ name: "sid", value: "1\r\nX-Evil: 1" })]],
    ]);
    await idbPut(db, STORE_COOKIES, "origins", [[aId, "https://a.example"]]);
    await jarLoad();
    expect(cookieHeaderFor("https://a.example/")).toBe("clean=1");
  });
});
