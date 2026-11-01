import { describe, expect, it } from "vitest";
import { applyNavGuard, navEncode, NAVP, SWEEP_MAX_ROOTS } from "../bootstrap/navguard";

const LOC = "https://engine.host/j/abc";
const ENGINE = "https://engine.host";
const REAL = "https://real.site/x";

/* #116: the four child-document residuals, each with a test that
   fails before its fix. Fake-realm harness mirrors
   navguard.test.ts (plain-object classes, observer list, child
   realm with anchor + location + navigation). */

function makeClass(prop: string) {
  const store = new WeakMap<object, string>();
  const proto: Record<string, any> = {
    setAttribute(this: any, n: string, v: string) {
      (this._attrs ?? (this._attrs = {}))[n] = v;
    },
    getAttribute(this: any, n: string) {
      return (this._attrs ?? {})[n] ?? null;
    },
    addEventListener(this: any, t: string, fn: () => void) {
      if (!this._listeners) this._listeners = {};
      (this._listeners[t] ?? (this._listeners[t] = [])).push(fn);
    },
  };
  Object.defineProperty(proto, prop, {
    configurable: true,
    get(this: any) {
      return store.get(this);
    },
    set(this: any, v: string) {
      store.set(this, v);
    },
  });
  return {
    proto,
    make() {
      return Object.create(proto);
    },
    read(el: any) {
      return store.get(el);
    },
  };
}

/* Residual 2: shadow-root frames. */
describe("shadow-root frames (#116 residual 2)", () => {
  function makeShadowEnv() {
    const observers: Array<{ cb: (muts: any[]) => void; target: any; opts: any }> = [];
    class MO {
      cb: (muts: any[]) => void;
      constructor(cb: (muts: any[]) => void) {
        this.cb = cb;
      }
      observe(target: any, opts: any) {
        observers.push({ cb: this.cb, target, opts });
      }
    }
    const w: Record<string, any> = {
      MutationObserver: MO,
      Element: {
        prototype: {
          attachShadow(this: any, _init: any) {
            return { nodeType: 11, tag: "shadow-root" };
          },
        },
      },
      document: { documentElement: { tag: "html" } },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    return {
      w,
      observers,
      fire(records: any[]) {
        observers.forEach((o) => o.cb(records));
      },
    };
  }

  it("observes every created shadow root with the same contract", () => {
    const e = makeShadowEnv();
    const host: any = {};
    const root = e.w.Element.prototype.attachShadow.call(host, { mode: "open" });
    expect(root).toBeTruthy();
    const installs = e.observers.filter((o) => o.target === root);
    expect(installs.length).toBe(1);
    expect(installs[0].opts).toEqual({ childList: true, subtree: true });
  });

  it("rewires a parser-inserted frame inside a shadow root", async () => {
    const e = makeShadowEnv();
    const root = e.w.Element.prototype.attachShadow.call({}, { mode: "open" });
    const f: Record<string, any> = {
      nodeType: 1,
      tagName: "IFRAME",
      _attrs: { src: REAL },
      getAttribute(n: string) {
        return n in this._attrs ? this._attrs[n] : null;
      },
      setAttribute(n: string, v: string) {
        this._attrs[n] = v;
      },
    };
    e.fire([{ type: "childList", addedNodes: [f] }]);
    expect(f._attrs.src).toBe("");
    await new Promise((r) => setTimeout(r, 0));
    expect(f._attrs.src).toBe(navEncode(REAL));
  });

  it("does not stack a second attachShadow hook on a twice-guarded realm", () => {
    const e = makeShadowEnv();
    expect((e.w.Element.prototype.attachShadow as any).__zlShadow).toBe(true);
    const before = e.observers.length;
    applyNavGuard(e.w, LOC, ENGINE);
    const root = (e.w.Element.prototype.attachShadow as any).call({}, { mode: "open" });
    const installs = e.observers.filter((o) => o.target === root);
    /* the re-guard installs its own observer on the root; the hook
       itself is not wrapped twice */
    expect((e.w.Element.prototype.attachShadow as any).__zlShadow).toBe(true);
    expect(installs.length).toBe(1);
    expect(e.observers.length).toBe(before + 2); /* documentElement + root */
  });
});

/* Residual 4: the observer-microtask race. */
describe("child realm race (#116 residual 4)", () => {
  function makeChildRealm() {
    const anchor = makeClass("href");
    const moInstalls: unknown[] = [];
    class CMO {
      cb: (muts: any[]) => void;
      constructor(cb: (muts: any[]) => void) {
        this.cb = cb;
        moInstalls.push(this);
      }
      observe(_t: any, _o: any) {}
    }
    const fetched: string[] = [];
    const xhrOpened: string[] = [];
    const win: Record<string, any> = {
      HTMLAnchorElement: { prototype: anchor.proto },
      MutationObserver: CMO,
      document: { baseURI: "about:blank", documentElement: { tag: "html" } },
      location: {},
      fetch(_u: string) {
        fetched.push(String(_u));
        return new Promise(() => {});
      },
      XMLHttpRequest: class {
        open(_m: string, u: string) {
          xhrOpened.push(String(u));
        }
        setRequestHeader() {}
        send() {}
        abort() {}
      },
      open() {
        return 1;
      },
    };
    Object.defineProperty(win.location, "href", {
      configurable: true,
      get: () => "about:blank",
      set() {},
    });
    return { anchor, win, moInstalls, fetched, xhrOpened };
  }

  function makeRaceEnv() {
    const iframe = makeClass("src");
    const child = makeChildRealm();
    Object.defineProperty(iframe.proto, "contentWindow", {
      configurable: true,
      get: () => child.win,
    });
    Object.defineProperty(iframe.proto, "contentDocument", {
      configurable: true,
      get: () => child.win.document,
    });
    const w: Record<string, any> = {
      HTMLIFrameElement: { prototype: iframe.proto },
      document: { documentElement: { tag: "html" } },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    return { iframe, child };
  }

  it("guards the child realm on the first contentWindow read, before any observer tick", () => {
    const e = makeRaceEnv();
    const f = e.iframe.make();
    const win = (f as any).contentWindow;
    expect(win).toBe(e.child.win);
    /* the child guard landed synchronously: a navigation seam the
       child script commits in the same task now rides the marker */
    const a = e.child.anchor.make();
    a.href = REAL;
    expect(e.child.anchor.read(a)).toBe(navEncode(REAL));
  });

  it("guards the child realm on the first contentDocument read too", () => {
    const e = makeRaceEnv();
    const f = e.iframe.make();
    const doc = (f as any).contentDocument;
    expect(doc).toBe(e.child.win.document);
    const a = e.child.anchor.make();
    a.href = REAL;
    expect(e.child.anchor.read(a)).toBe(navEncode(REAL));
    expect(e.child.moInstalls.length).toBe(1); /* one guard, not two */
  });

  it("re-emits the child's fetch and XHR through the parent-relative marker (#116 residual 1)", () => {
    const e = makeRaceEnv();
    const f = e.iframe.make();
    (f as any).contentWindow; /* lands the guard + the reemit patch */
    e.child.win.fetch("/child-fetch");
    expect(e.child.fetched).toEqual([LOC.replace("https://engine.host", "") + NAVP + "/" + encodeURIComponent("/child-fetch")]);
    const x = new (e.child.win.XMLHttpRequest as any)();
    x.open("GET", "/child-xhr", true);
    x.send();
    expect(e.child.xhrOpened).toEqual([
      LOC.replace("https://engine.host", "") + NAVP + "/" + encodeURIComponent("/child-xhr"),
    ]);
  });
});

/* Residual 3: unquoted srcdoc values. */
describe("unquoted srcdoc values (#116 residual 3)", () => {
  function makeSrcdocEnv() {
    const srcdoc = makeClass("srcdoc");
    const w: Record<string, any> = {
      HTMLIFrameElement: { prototype: srcdoc.proto },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    return srcdoc;
  }

  it("rewires an unquoted absolute URL inside srcdoc markup", () => {
    const srcdoc = makeSrcdocEnv();
    const el = srcdoc.make();
    el.srcdoc = `<a href=${REAL}>x</a>`;
    expect(srcdoc.read(el)).toBe(`<a href=${navEncode(REAL)}>x</a>`);
    expect(el.srcdoc).toBe(`<a href=${REAL}>x</a>`); /* reads stay page-truthful */
  });

  it("keeps quoted values, spacing and relative URLs intact", () => {
    const srcdoc = makeSrcdocEnv();
    const el = srcdoc.make();
    el.srcdoc = `<a href="${REAL}">x</a><form action=${REAL}></form><img src="/local.png">`;
    expect(srcdoc.read(el)).toBe(
      `<a href="${navEncode(REAL)}">x</a><form action=${navEncode(REAL)}></form><img src="/local.png">`,
    );
  });
});

/* #536: pre-existing OPEN shadow roots. A root that existed before
   the guard installed escaped both the observer and the attachShadow
   hook, so its frames loaded browser-direct. The sweep now joins
   every visible root to the same observer contract and gives its
   frames the same pass; CLOSED roots are invisible to page script
   by browser rule (.shadowRoot is null) and stay the documented
   boundary; the sweep is bounded. */
describe("pre-existing open shadow root sweep (#536)", () => {
  function makeSweepEnv(hosts: Array<{ el: any; root: any | null }>) {
    const observers: Array<{ cb: (muts: any[]) => void; target: any; opts: any }> = [];
    class MO {
      cb: (muts: any[]) => void;
      constructor(cb: (muts: any[]) => void) {
        this.cb = cb;
      }
      observe(target: any, opts: any) {
        observers.push({ cb: this.cb, target, opts });
      }
    }
    const lightAll: any[] = hosts.map((h) => h.el);
    const w: Record<string, any> = {
      MutationObserver: MO,
      Element: { prototype: { attachShadow() { return { nodeType: 11 }; } } },
      document: {
        documentElement: { tag: "html" },
        querySelectorAll(sel: string) {
          if (sel === "*") return lightAll;
          return [];
        },
      },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    return { w, observers };
  }

  function shadowFrame(src: string) {
    return {
      nodeType: 1,
      tagName: "IFRAME",
      _attrs: { src } as Record<string, string>,
      getAttribute(n: string) {
        return n in this._attrs ? this._attrs[n] : null;
      },
      setAttribute(n: string, v: string) {
        this._attrs[n] = v;
      },
    };
  }

  it("joins a pre-existing open root to the observer and rewires its frames", async () => {
    const root: any = { nodeType: 11, tag: "pre-existing" };
    const frame = shadowFrame(REAL);
    root.querySelectorAll = (sel: string) =>
      sel === "iframe,frame" ? [frame] : sel === "*" ? [] : [];
    const host: any = { tagName: "DIV", shadowRoot: root };
    const e = makeSweepEnv([{ el: host, root }]);
    const installs = e.observers.filter((o) => o.target === root);
    expect(installs.length).toBe(1);
    expect(installs[0].opts).toEqual({ childList: true, subtree: true });
    expect(frame._attrs.src).toBe("");
    await new Promise((r) => setTimeout(r, 0));
    expect(frame._attrs.src).toBe(navEncode(REAL));
  });

  it("finds nested open roots inside discovered roots", () => {
    const outer: any = { nodeType: 11, tag: "outer" };
    const inner: any = { nodeType: 11, tag: "inner" };
    const innerHost: any = { tagName: "SPAN", shadowRoot: inner };
    outer.querySelectorAll = (sel: string) => (sel === "iframe,frame" ? [] : [innerHost]);
    const outerHost: any = { tagName: "DIV", shadowRoot: outer };
    const e = makeSweepEnv([{ el: outerHost, root: outer }]);
    const targets = e.observers.map((o) => o.target);
    expect(targets).toContain(outer);
    expect(targets).toContain(inner);
  });

  it("never observes the same root twice (host re-listed, nested cycle)", () => {
    const root: any = { nodeType: 11, tag: "r" };
    root.querySelectorAll = (sel: string) => (sel === "iframe,frame" ? [] : []);
    const hostA: any = { tagName: "DIV", shadowRoot: root };
    const hostB: any = { tagName: "DIV", shadowRoot: root };
    const e = makeSweepEnv([{ el: hostA, root }, { el: hostB, root }]);
    expect(e.observers.filter((o) => o.target === root).length).toBe(1);
  });

  it("a closed root (shadowRoot null) is invisible and harmless", () => {
    const closedHost: any = { tagName: "DIV", shadowRoot: null };
    const e = makeSweepEnv([{ el: closedHost, root: null }]);
    expect(e.observers.length).toBe(1); /* documentElement only */
  });

  it("stops at the roots cap: later roots keep native loads (bounded sweep)", () => {
    const hosts: Array<{ el: any; root: any | null }> = [];
    const roots: any[] = [];
    for (let i = 0; i < SWEEP_MAX_ROOTS + 3; i++) {
      const root: any = { nodeType: 11, tag: "r" + i };
      root.querySelectorAll = (sel: string) => (sel === "iframe,frame" ? [] : []);
      roots.push(root);
      hosts.push({ el: { tagName: "DIV", shadowRoot: root }, root });
    }
    const e = makeSweepEnv(hosts);
    const guarded = e.observers.filter((o) => roots.includes(o.target));
    expect(guarded.length).toBe(SWEEP_MAX_ROOTS);
    expect(e.observers.filter((o) => o.target === roots[roots.length - 1]).length).toBe(0);
  });

  it("a hostile querySelectorAll throw never breaks the guard install", () => {
    const observers: Array<{ target: any }> = [];
    class MO {
      observe(target: any) {
        observers.push({ target });
      }
    }
    const w: Record<string, any> = {
      MutationObserver: MO,
      Element: { prototype: { attachShadow() { return { nodeType: 11 }; } } },
      document: {
        documentElement: { tag: "html" },
        querySelectorAll(sel: string) {
          if (sel === "*") throw new Error("hostile");
          return [];
        },
      },
      open() {
        return 1;
      },
    };
    expect(() => applyNavGuard(w, LOC, ENGINE)).not.toThrow();
    expect(observers.length).toBe(1); /* documentElement observed before the sweep */
  });
});
