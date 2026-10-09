import { describe, expect, it } from "vitest";
import { applyNavGuard, navEncode, NAVP } from "../bootstrap/navguard";

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
      XMLHttpRequest: {
        prototype: {
          open(this: any, _m: string, u: string) {
            xhrOpened.push(String(u));
          },
          setRequestHeader() {},
          send() {},
          abort() {},
        },
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
