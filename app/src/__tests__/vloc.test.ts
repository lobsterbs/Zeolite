import { describe, expect, it } from "vitest";
import { applyVloc } from "../bootstrap/vloc";

const ENGINE = "https://engine.host";
const ENTRY = "/j/abc123";

/* Fake realm: a native location over a mutable href, a history
   that rewrites the href like the browser does, and listener
   storage the tests fire by hand. */
function makeWin(href: string) {
  const state = { href };
  const nat = {
    get href() {
      return state.href;
    },
    get hash() {
      return new URL(state.href).hash;
    },
    set hash(v: string) {
      const u = new URL(state.href);
      u.hash = v;
      state.href = u.href;
    },
    get origin() {
      return new URL(state.href).origin;
    },
    assign(u: string) {
      state.href = new URL(u, state.href).href;
    },
    replace(u: string) {
      state.href = new URL(u, state.href).href;
    },
    reload() {
      state.href = state.href;
    },
  };
  const calls: string[] = [];
  const hist = {
    pushState(_s: unknown, _t: string, u?: string | null) {
      if (u != null) state.href = new URL(u, state.href).href;
      calls.push("push " + String(u));
    },
    replaceState(_s: unknown, _t: string, u?: string | null) {
      if (u != null) state.href = new URL(u, state.href).href;
      calls.push("replace " + String(u));
    },
  };
  const listeners: Record<string, Array<() => void>> = {};
  const w: Record<string, unknown> = {
    location: nat,
    history: hist,
    addEventListener(t: string, fn: () => void) {
      (listeners[t] ?? (listeners[t] = [])).push(fn);
    },
  };
  return { w, state, calls, listeners, fire(t: string) {
    for (const fn of listeners[t] ?? []) fn();
  } };
}

const zl = (w: Record<string, unknown>) =>
  w.__zl as {
    href: string;
    pathname: string;
    search: string;
    hash: string;
    origin: string;
    assign(u: string): void;
    replace(u: string): void;
  };

describe("applyVloc (#236)", () => {
  it("seeds the virtual path from the injected vpath", () => {
    const { w } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/real/page?q=1#h");
    const l = zl(w);
    expect(l.pathname).toBe("/real/page");
    expect(l.search).toBe("?q=1");
    expect(l.hash).toBe("#h");
    expect(l.href).toBe(ENGINE + "/real/page?q=1#h");
    expect(l.origin).toBe(ENGINE);
  });

  it("parses the real path back off a NAVH handle URL", () => {
    const { w } = makeWin(ENGINE + "/__zl_navh__/TOKEN123/real/path?x=1");
    applyVloc(w);
    expect(zl(w).pathname).toBe("/real/path");
    expect(zl(w).search).toBe("?x=1");
  });

  it("falls back to the opaque route view without vpath or handle", () => {
    const { w } = makeWin(ENGINE + ENTRY + "?z=9#top");
    applyVloc(w);
    expect(zl(w).pathname).toBe(ENTRY);
    expect(zl(w).search).toBe("?z=9");
    expect(zl(w).hash).toBe("#top");
  });

  it("re-anchors pushState through the entry route", () => {
    const { w, state } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/home");
    const h = w.history as { pushState(s: unknown, t: string, u?: string | null): void };
    h.pushState({}, "", "/spa/route?k=2");
    expect(state.href).toBe(ENGINE + ENTRY + "/__zl_prel__/" + encodeURIComponent("/spa/route?k=2"));
    expect(zl(w).pathname).toBe("/spa/route");
    expect(zl(w).search).toBe("?k=2");
  });

  it("restores the virtual path on popstate (deep-link reload shape)", () => {
    const { w, state, fire } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/home");
    state.href = ENGINE + ENTRY + "/__zl_prel__/" + encodeURIComponent("/deep/link?q=1");
    fire("popstate");
    expect(zl(w).pathname).toBe("/deep/link");
    expect(zl(w).search).toBe("?q=1");
  });

  it("keeps a native hash ahead of the pushed one", () => {
    const { w, state, fire } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/home");
    const h = w.history as { pushState(s: unknown, t: string, u?: string | null): void };
    h.pushState({}, "", "/spa/route#pushed");
    const u = new URL(state.href);
    u.hash = "#clicked";
    state.href = u.href;
    fire("hashchange");
    expect(zl(w).pathname).toBe("/spa/route");
    expect(zl(w).hash).toBe("#clicked");
  });

  it("assign re-anchors a virtual path; cross-origin stays native", () => {
    const { w, state } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/home");
    zl(w).assign("/spa/next");
    expect(state.href).toBe(ENGINE + ENTRY + "/__zl_prel__/" + encodeURIComponent("/spa/next"));
    zl(w).assign("https://other.site/x");
    expect(state.href).toBe("https://other.site/x");
  });

  it("installs nothing on an engine-origin root document", () => {
    const { w } = makeWin(ENGINE + "/");
    applyVloc(w, "/home");
    expect(w.__zl).toBeUndefined();
  });

  it("is idempotent: a second run keeps the first view", () => {
    const { w } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/one");
    applyVloc(w, "/two");
    expect(zl(w).pathname).toBe("/one");
  });
});
