import { describe, expect, it } from "vitest";
import { applyStorage } from "../bootstrap/storage";

/* Fake page globals for applyStorage: plain objects standing in for
   Storage, IDBFactory and CacheStorage. Only the seams the shim
   touches are implemented. */

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
  } as Storage;
}

describe("applyStorage scoped shims (#262 #263 #264)", () => {
  it("scopes localStorage/sessionStorage and reports installed", () => {
    const w: Record<string, unknown> = {};
    const ls = fakeStorage();
    const ss = fakeStorage();
    w.localStorage = ls;
    w.sessionStorage = ss;
    const st = applyStorage(w, "p1");
    expect(st.installed).toBe(true);
    const scoped = st.scopedLocal!;
    scoped.setItem("k", "v");
    expect(ls.getItem("p1k")).toBe("v");
    expect(scoped.getItem("k")).toBe("v");
    expect(scoped.length).toBe(1);
    scoped.removeItem("k");
    expect(scoped.length).toBe(0);
  });

  it("named properties persist, delete and enumerate like native Storage (#273)", () => {
    const w: Record<string, unknown> = {};
    const ls = fakeStorage();
    const ss = fakeStorage();
    w.localStorage = ls;
    w.sessionStorage = ss;
    const st = applyStorage(w, "p1");
    const scoped = st.scopedLocal!;
    const s = scoped as unknown as Record<string, unknown>;
    s.theme = "dark";
    expect(scoped.getItem("theme")).toBe("dark");
    expect(ls.getItem("p1theme")).toBe("dark");
    expect(s.theme).toBe("dark");
    expect("theme" in scoped).toBe(true);
    expect(Object.keys(scoped)).toEqual(["theme"]);
    expect(scoped.length).toBe(1);
    expect(scoped.key(0)).toBe("theme");
    delete s.theme;
    expect(scoped.getItem("theme")).toBe(null);
    expect(s.theme).toBe(undefined);
    expect(Object.keys(scoped)).toEqual([]);
    /* methods still resolve, absent names read undefined */
    expect(typeof s.getItem).toBe("function");
    expect(s.absent).toBe(undefined);
  });

  it("prefixes db and cache names but not cmp keys (#263)", () => {
    const w: Record<string, unknown> = {};
    const opened: string[] = [];
    const cmpCalls: unknown[][] = [];
    w.localStorage = fakeStorage();
    w.sessionStorage = fakeStorage();
    w.indexedDB = {
      open: (n: string) => { opened.push(n); return {} as IDBOpenDBRequest; },
      deleteDatabase: () => ({} as IDBOpenDBRequest),
      cmp: (a: unknown, b: unknown) => { cmpCalls.push([a, b]); return 0; },
    };
    const st = applyStorage(w, "p2");
    expect(st.installed).toBe(true);
    const idb = w.indexedDB as Record<string, (a: unknown, b?: unknown) => unknown>;
    idb.open("sitedb", 1);
    expect(opened).toEqual(["p2sitedb"]);
    /* #263: cmp receives raw keys; no prefixing, no string coercion */
    idb.cmp(2, 10);
    expect(cmpCalls).toEqual([[2, 10]]);
  });

  it("match with an explicit cacheName only searches that site cache (#264)", async () => {
    const w: Record<string, unknown> = {};
    w.localStorage = fakeStorage();
    w.sessionStorage = fakeStorage();
    const openedNames: string[] = [];
    const caches = {
      open: async (n: string) => ({
        match: async (rq: unknown) => new Response("hit:" + n),
      }),
      delete: async () => true,
      has: async (n: string) => n === "p3v1",
      keys: async () => ["p3v1", "p3other", "engine-own"],
      match: async () => undefined,
    };
    w.caches = caches;
    const st = applyStorage(w, "p3");
    expect(st.installed).toBe(true);
    const shim = w.caches as Record<string, unknown>;
    const keys = (await (shim.keys as () => Promise<string[]>)());
    expect(keys).toEqual(["v1", "other"]);
    const hit = await (shim.match as (r: unknown, o?: { cacheName?: string }) => Promise<Response | undefined>)(
      "https://a.example/", { cacheName: "v1" },
    );
    expect(hit).not.toBeNull();
    expect(await hit!.text()).toBe("hit:p3v1");
    /* A cache the site never created: undefined, and nothing opened */
    const miss = await (shim.match as (r: unknown, o?: { cacheName?: string }) => Promise<Response | undefined>)(
      "https://a.example/", { cacheName: "missing" },
    );
    expect(miss).toBeUndefined();
    expect(openedNames).toEqual([]);
  });

  it("reports installed=false when a shim install fails (#262)", () => {
    const w: Record<string, unknown> = {};
    w.localStorage = fakeStorage();
    w.sessionStorage = fakeStorage();
    /* Non-configurable accessor: Object.defineProperty throws, so the
       raw unscoped IndexedDB stays and installed must say so. */
    const rawIdb = { open: () => ({}), deleteDatabase: () => ({}) };
    Object.defineProperty(w, "indexedDB", {
      get: () => rawIdb,
      configurable: false,
    });
    const st = applyStorage(w, "p4");
    expect(st.installed).toBe(false);
    expect(w.indexedDB).toBe(rawIdb);
  });
});
