import { describe, expect, it } from "vitest";
import { applyVloc } from "../bootstrap/vloc";
import { onVlocChange } from "../bootstrap/vloc";

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

  it("anchors on the bare entry after loading at a prel URL (no tail nesting)", () => {
    const { w, state } = makeWin(
      ENGINE + ENTRY + "/__zl_prel__/" + encodeURIComponent("/spa/one?k=1"),
    );
    applyVloc(w, "/spa/one?k=1");
    const h = w.history as { pushState(s: unknown, t: string, u?: string | null): void };
    h.pushState({}, "", "/spa/two?k=2");
    expect(state.href).toBe(
      ENGINE + ENTRY + "/__zl_prel__/" + encodeURIComponent("/spa/two?k=2"),
    );
  });

  it("decodes a prel tail on the handle route instead of reading it as path", () => {
    const { w } = makeWin(
      ENGINE + "/__zl_navh__/TOKEN123/search/__zl_prel__/" + encodeURIComponent("/search?q=a"),
    );
    applyVloc(w);
    expect(zl(w).pathname).toBe("/search");
    expect(zl(w).search).toBe("?q=a");
  });

  it("restores the tail view on popstate (NAVH + prel)", () => {
    const { w, state, fire } = makeWin(ENGINE + "/__zl_navh__/TOKEN123/search");
    applyVloc(w, "/search");
    state.href =
      ENGINE + "/__zl_navh__/TOKEN123/search/__zl_prel__/" + encodeURIComponent("/search?q=b");
    fire("popstate");
    expect(zl(w).pathname).toBe("/search");
    expect(zl(w).search).toBe("?q=b");
  });

  it("strips an embedded marker from a legacy accumulated tail", () => {
    const { w } = makeWin(
      ENGINE +
        ENTRY +
        "/__zl_prel__/" +
        encodeURIComponent("/spa/one") +
        "/__zl_prel__/" +
        encodeURIComponent("/spa/two"),
    );
    applyVloc(w);
    expect(zl(w).pathname).toBe("/spa/one");
  });

  it("passes cross-origin protocol-relative inputs through natively (#239)", () => {
    const { w, calls } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/real");
    (w.history as { pushState(s: unknown, t: string, u?: string | null): void })
      .pushState(1, "", "//evil.com/x?a=1");
    expect(calls[0]).toBe("push //evil.com/x?a=1");
    expect(zl(w).pathname).toBe("/real");
  });

  it("passes whitespace-prefixed cross-origin URLs through natively (#239)", () => {
    const { w, state } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/real");
    zl(w).assign("  https://evil.com/x");
    expect(state.href).toBe("https://evil.com/x");
    expect(zl(w).href).toBe(ENGINE + "/real");
  });

  it("is idempotent: a second run keeps the first view", () => {
    const { w } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/one");
    applyVloc(w, "/two");
    expect(zl(w).pathname).toBe("/one");
  });
});

describe("route-shaped inputs decode, never stack (prel-of-prel mint)", () => {
  it("assign of the page's own opaque route re-anchors, not stacks", () => {
    const href =
      ENGINE + "/__zl_navh__/TOKEN123/ai/__zl_prel__/" + encodeURIComponent("/search?udm=50");
    const { w, state } = makeWin(href);
    applyVloc(w);
    zl(w).assign(href);
    expect(state.href).toBe(href);
  });

  it("pushState of a re-emitted engine-origin href stays single-level", () => {
    const href = ENGINE + ENTRY + "/__zl_prel__/" + encodeURIComponent("/spa/one");
    const { w, state } = makeWin(href);
    applyVloc(w, "/spa/one");
    const h = w.history as { pushState(s: unknown, t: string, u?: string | null): void };
    h.pushState({}, "", href);
    expect(state.href).toBe(href);
  });
});

describe("backslash-form absolute URLs are cross-origin (#373)", () => {
  it("never resolves a \\\\host form to a same-site virtual path", () => {
    const { w, state } = makeWin(ENGINE + ENTRY);
    applyVloc(w);
    const nav = w.location as unknown as { assign: (u: string) => void };
    void nav;
    (w.history as unknown as { pushState: (s: unknown, t: string, u: string) => void }).pushState(null, "", "\\\\evil.example/x");
    // Cross-origin: handed to the native location as-is, never folded
    // into a virtual path on this page's origin.
    expect(state.href).toBe("https://evil.example/x");
  });
});

describe("onVlocChange (#107 phase 2)", () => {
  it("observes real virtual-path moves only", () => {
    const { w, fire } = makeWin(ENGINE + ENTRY);
    applyVloc(w, "/start");
    const seen: string[] = [];
    onVlocChange((v) => seen.push(v));
    const h = w.history as { pushState(s: unknown, t: string, u?: string | null): void };
    h.pushState({}, "", "/next?q=1");
    expect(seen).toEqual(["/next?q=1"]);
    /* popstate back on the re-anchored URL decodes a real path: fires. */
    fire("popstate");
    expect(seen).toEqual(["/next?q=1", "/next?q=1"]);
  });
});
