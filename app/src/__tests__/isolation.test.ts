/* Issue #37: virtual browser API isolation beyond storage/cookies.
   Node-env tests against plain fake windows/stores - no DOM, no real
   BroadcastChannel/StorageEvent constructors, so the duck-typed
   fallbacks in isolation.ts are what these tests exercise. The
   browser E2E suite covers the real constructors. */

import { describe, expect, it } from "vitest";
import { applyStorage } from "../bootstrap/storage";
import { applyIsolation } from "../bootstrap/isolation";

/* A minimal Storage over a Map, with the same read semantics the
   engine shims rely on. */
function fakeStore(): { store: Storage; map: Map<string, string> } {
  const map = new Map<string, string>();
  const s = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
  return { store: s as unknown as Storage, map };
}

type Fn = (...a: unknown[]) => unknown;

/* A minimal window: plain object, own add/removeEventListener that a
   test can inspect so the REAL listener applyIsolation registers is
   reachable. */
function fakeWindow(local?: Storage, session?: Storage) {
  const listeners: { t: string; l: Fn }[] = [];
  class FakeBC {
    static built: string[] = [];
    static sent: unknown[][] = [];
    onmessage: Fn | null = null;
    onmessageerror: Fn | null = null;
    constructor(public name: string) {
      FakeBC.built.push(name);
    }
    postMessage(m: unknown) {
      FakeBC.sent.push([this.name, m]);
    }
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return true;
    }
  }
  const w: Record<string, unknown> = {
    localStorage: local,
    sessionStorage: session,
    cookieStore: { get: () => null },
    location: { href: "https://engine.example/route" },
    addEventListener: (t: string, l: Fn) => {
      listeners.push({ t, l });
    },
    removeEventListener: (t: string, l: Fn) => {
      const i = listeners.findIndex((e) => e.t === t && e.l === l);
      if (i >= 0) listeners.splice(i, 1);
    },
    BroadcastChannel: FakeBC,
  };
  return { w, listeners, FakeBC };
}

function isolate(w: Record<string, unknown>, P: string) {
  const st = applyStorage(w, P);
  applyIsolation(w, P, st);
  return st;
}

/* The single real "storage" listener applyIsolation installs (it uses
   the ORIGINAL addEventListener, so it is the last one in the list
   the fake window recorded). */
function realStorageListener(listeners: { t: string; l: Fn }[]): Fn {
  const all = listeners.filter((e) => e.t === "storage");
  const l = all[all.length - 1];
  if (!l) throw new Error("no real storage listener installed");
  return l.l;
}

const ev = (key: string | null, area: unknown) =>
  ({ key, newValue: "1", oldValue: null, storageArea: area }) as unknown;

describe("#37 isolation", () => {
  it("storage events: only this site's keys, prefix stripped, scoped area", () => {
    const { w, listeners } = fakeWindow(fakeStore().store, fakeStore().store);
    const P = "zl:aaa:";
    const st = isolate(w, P);
    const seen: unknown[] = [];
    (w.addEventListener as Fn)("storage", (e: unknown) => seen.push(e));
    const fire = realStorageListener(listeners);

    // Another virtual site's key: dropped.
    fire(ev("zl:bbb:k", null));
    expect(seen).toHaveLength(0);
    // Engine-own key: dropped.
    fire(ev("enginekey", null));
    expect(seen).toHaveLength(0);

    // Own key: delivered exactly once, prefix stripped, scoped area.
    fire(ev(P + "k", st.realLocal));
    expect(seen).toHaveLength(1);
    const e = seen[0] as { key: string | null; storageArea: unknown; type: string };
    expect(e.key).toBe("k");
    expect(e.type).toBe("storage");
    expect(e.storageArea).toBe(st.scopedLocal);
  });

  it("storage events: session writes map to the scoped session store", () => {
    const { w, listeners } = fakeWindow(fakeStore().store, fakeStore().store);
    const P = "zl:aaa:";
    const st = isolate(w, P);
    let got: unknown = null;
    (w.addEventListener as Fn)("storage", (e: unknown) => {
      got = e;
    });
    realStorageListener(listeners)(ev(P + "k", st.realSession));
    expect((got as { storageArea: Storage }).storageArea).toBe(st.scopedSession);
  });

  it("storage events: removeEventListener stops delivery; other types pass through", () => {
    const { w, listeners } = fakeWindow(fakeStore().store, fakeStore().store);
    const P = "zl:aaa:";
    const st = isolate(w, P);
    const seen: unknown[] = [];
    const h = (e: unknown) => seen.push(e);
    (w.addEventListener as Fn)("storage", h);
    (w.addEventListener as Fn)("click", h);
    (w.removeEventListener as Fn)("storage", h);
    realStorageListener(listeners)(ev(P + "k", st.realLocal));
    expect(seen).toHaveLength(0);
    // Non-storage registrations reached the real addEventListener.
    expect(listeners.some((e) => e.t === "click")).toBe(true);
  });

  it("storage events: onstorage gets the filtered event", () => {
    const { w, listeners } = fakeWindow(fakeStore().store, fakeStore().store);
    const P = "zl:aaa:";
    const st = isolate(w, P);
    let got: unknown = null;
    (w as { onstorage: unknown }).onstorage = (e: unknown) => {
      got = e;
    };
    realStorageListener(listeners)(ev(P + "k", st.realLocal));
    expect((got as { key: string }).key).toBe("k");
    expect((got as { storageArea: Storage }).storageArea).toBe(st.scopedLocal);
  });

  it("window.name is scoped per site and survives same-site reloads", () => {
    const session = fakeStore();
    const a1 = fakeWindow(undefined, session.store);
    const P = "zl:aaa:";
    isolate(a1.w, P);
    (a1.w as { name: unknown }).name = "alpha";
    expect((a1.w as { name: unknown }).name).toBe("alpha");
    // Same site, fresh context: restored from the scoped session store.
    const a2 = fakeWindow(undefined, session.store);
    isolate(a2.w, P);
    expect((a2.w as { name: unknown }).name).toBe("alpha");
    // Another virtual site sharing the real session store: empty.
    const b = fakeWindow(undefined, session.store);
    isolate(b.w, "zl:bbb:");
    expect((b.w as { name: unknown }).name).toBe("");
  });

  it("BroadcastChannel moves to a prefixed real name, page spelling kept", () => {
    const a = fakeWindow();
    const b = fakeWindow();
    const BCa = a.FakeBC;
    const BCb = b.FakeBC;
    isolate(a.w, "zl:aaa:");
    isolate(b.w, "zl:bbb:");
    const Ctor = (x: Record<string, unknown>) =>
      x.BroadcastChannel as unknown as new (n: string) => { name: string };
    const ca = new (Ctor(a.w))("chan");
    const cb = new (Ctor(b.w))("chan");
    expect(ca.name).toBe("chan");
    expect(cb.name).toBe("chan");
    // The real constructed names differ per site.
    expect(BCa.built[BCa.built.length - 1]).toBe("zl:aaa:chan");
    expect(BCb.built[BCb.built.length - 1]).toBe("zl:bbb:chan");
    ca.postMessage("m");
    expect(BCa.sent[BCa.sent.length - 1]).toEqual(["zl:aaa:chan", "m"]);
  });

  it("cookieStore is removed, not faked", () => {
    const { w } = fakeWindow();
    isolate(w, "zl:aaa:");
    expect(w.cookieStore).toBeUndefined();
  });

  it("storage stays scoped across two virtual sites sharing one engine store", () => {
    const local = fakeStore();
    const a = fakeWindow(local.store, fakeStore().store);
    const b = fakeWindow(local.store, fakeStore().store);
    isolate(a.w, "zl:aaa:");
    isolate(b.w, "zl:bbb:");
    (a.w.localStorage as Storage).setItem("k", "a");
    (b.w.localStorage as Storage).setItem("k", "b");
    expect((a.w.localStorage as Storage).getItem("k")).toBe("a");
    expect((b.w.localStorage as Storage).getItem("k")).toBe("b");
    // The real store holds both, each under its own prefix.
    expect(local.map.get("zl:aaa:k")).toBe("a");
    expect(local.map.get("zl:bbb:k")).toBe("b");
  });

  it("installed is false when a store is missing", () => {
    const { w } = fakeWindow(undefined, fakeStore().store);
    const st = applyStorage(w, "zl:aaa:");
    expect(st.installed).toBe(false);
    expect(st.scopedSession).toBeDefined();
    expect(st.scopedLocal).toBeUndefined();
  });
});
