import { describe, expect, it } from "vitest";
import { applyNavGuard, navEncode, NAV } from "../bootstrap/navguard";
import { b64uDecode } from "../codec";

const LOC = "https://engine.host/j/abc";
const ENGINE = "https://engine.host";
const REAL = "https://real.site/x";

/* Fake DOM class: a prototype property backed by a WeakMap (so the
   guard's per-element raw map sees real object identity) and a
   per-instance attribute store for setAttribute. */
function makeClass(prop: string) {
  const store = new WeakMap<object, string>();
  const proto: Record<string, any> = {
    setAttribute(this: any, n: string, v: string) {
      (this._attrs ?? (this._attrs = {}))[n] = v;
    },
    getAttribute(this: any, n: string) {
      return (this._attrs ?? {})[n] ?? null;
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
    set(el: any, v: string) {
      store.set(el, v); // bypasses the guard, like HTML-parsed attributes
    },
  };
}

function makeEnv() {
  const anchor = makeClass("href");
  const iframe = makeClass("src");
  const form = makeClass("action");
  const link = makeClass("href");
  const submitted: string[] = [];
  const opened: unknown[][] = [];
  form.proto.submit = function () {
    submitted.push("submit");
  };
  form.proto.requestSubmit = function () {
    submitted.push("requestSubmit");
  };
  const w: Record<string, any> = {
    HTMLAnchorElement: { prototype: anchor.proto },
    HTMLIFrameElement: { prototype: iframe.proto },
    HTMLFormElement: { prototype: form.proto },
    HTMLLinkElement: { prototype: link.proto },
    RTCPeerConnection: function RTCPeerConnection() {},
    open(...args: unknown[]) {
      opened.push(args);
      return 7;
    },
  };
  applyNavGuard(w, LOC, ENGINE);
  return { w, anchor, iframe, form, link, opened, submitted };
}

describe("navEncode", () => {
  it("round-trips through the marker path", () => {
    const u = "https://real.site/a b?c=1&d=%20";
    const m = navEncode(u);
    expect(m.startsWith(NAV + "/")).toBe(true);
    const b64 = m.slice(NAV.length + 1);
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new TextDecoder().decode(b64uDecode(b64)!)).toBe(u);
  });

  it("never carries the plaintext destination (issue #32)", () => {
    const m = navEncode("https://real.site/x");
    expect(m).not.toContain("real.site");
    expect(m).not.toContain("https");
  });
});

describe("applyNavGuard", () => {
  it("rewrites cross-origin anchor/iframe/link/form property assignments", () => {
    const e = makeEnv();
    const a = e.anchor.make();
    a.href = REAL;
    expect(e.anchor.read(a)).toBe(navEncode(REAL));
    expect(a.href).toBe(REAL); // reads return what the page wrote
    const f = e.iframe.make();
    f.src = REAL;
    expect(e.iframe.read(f)).toBe(navEncode(REAL));
    const l = e.link.make();
    l.href = REAL;
    expect(e.link.read(l)).toBe(navEncode(REAL));
    const fo = e.form.make();
    fo.action = REAL;
    expect(e.form.read(fo)).toBe(navEncode(REAL));
  });

  it("passes relative, engine-origin and opaque URLs through unchanged", () => {
    const e = makeEnv();
    const a = e.anchor.make();
    for (const v of ["/local", "img.png", "https://engine.host/j/zzz", "data:text/html,x", "mailto:a@b.c"]) {
      a.href = v;
      expect(e.anchor.read(a)).toBe(v);
      expect(a.href).toBe(v);
    }
  });

  it("rewrites protocol-relative URLs using the page location as base", () => {
    const e = makeEnv();
    const a = e.anchor.make();
    a.href = "//real.site/y";
    expect(e.anchor.read(a)).toBe(navEncode("https://real.site/y"));
  });

  it("rewrites setAttribute on the guarded attributes only", () => {
    const e = makeEnv();
    const a = e.anchor.make();
    a.setAttribute("href", REAL);
    expect(a.getAttribute("href")).toBe(navEncode(REAL));
    a.setAttribute("href", "/local");
    expect(a.getAttribute("href")).toBe("/local");
    a.setAttribute("title", REAL);
    expect(a.getAttribute("title")).toBe(REAL);
    const fo = e.form.make();
    fo.setAttribute("action", "https://real.site/login");
    expect(fo.getAttribute("action")).toBe(navEncode("https://real.site/login"));
  });

  it("rewrites window.open targets, passes through the rest", () => {
    const e = makeEnv();
    expect(e.w.open(REAL, "_blank")).toBe(7);
    expect(e.opened[0][0]).toBe(navEncode(REAL));
    expect(e.opened[0][1]).toBe("_blank");
    e.w.open("/local");
    expect(e.opened[1][0]).toBe("/local");
    e.w.open();
    expect(e.opened[2][0]).toBeUndefined();
  });

  it("submit/requestSubmit rewrite a bypassing action first", () => {
    const e = makeEnv();
    const f = e.form.make();
    e.form.set(f, "https://real.site/login"); // HTML-parsed-style value
    f.submit();
    expect(f.getAttribute("action")).toBe(navEncode("https://real.site/login"));
    expect(e.submitted).toEqual(["submit"]);
    const g = e.form.make();
    e.form.set(g, "/relative");
    g.requestSubmit();
    expect(g.getAttribute("action")).toBe(null); // untouched
    expect(e.submitted).toEqual(["submit", "requestSubmit"]);
  });

  it("removes RTCPeerConnection entirely", () => {
    const e = makeEnv();
    expect("RTCPeerConnection" in e.w).toBe(false);
  });

  it("overrides document.referrer to the empty string (#32/#35)", () => {
    /* The proxied frame's referrer is the embedder URL with the
       plaintext ?url= destination; the guard empties the DOM surface. */
    const doc: Record<string, any> = {};
    Object.defineProperty(doc, "referrer", {
      configurable: true,
      get: () => "https://embedder.host/?url=" + encodeURIComponent(REAL),
    });
    const w: Record<string, any> = { document: doc, open() { return 1; } };
    applyNavGuard(w, LOC, ENGINE);
    expect(doc.referrer).toBe("");
  });

  it("keeps a sealed document's referrer native (safe fallback)", () => {
    const doc: Record<string, any> = {};
    Object.defineProperty(doc, "referrer", {
      configurable: false,
      get: () => "https://embedder.host/?url=x",
    });
    const w: Record<string, any> = { document: doc, open() { return 1; } };
    applyNavGuard(w, LOC, ENGINE);
    expect(doc.referrer).toBe("https://embedder.host/?url=x");
  });

  it("survives a non-configurable prototype: other hooks still install", () => {
    const frozen = makeClass("href");
    const d = Object.getOwnPropertyDescriptor(frozen.proto, "href")!;
    Object.defineProperty(frozen.proto, "href", { ...d, configurable: false });
    const w: Record<string, any> = {
      HTMLAnchorElement: { prototype: frozen.proto },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    expect(w.open("https://real.site/x")).toBe(1);
  });

  it("installs every hook even without window.navigation (#39)", () => {
    const e = makeEnv();
    expect(e.w.open(REAL)).toBe(7);
    expect(e.opened[0][0]).toBe(navEncode(REAL));
  });
});

/* #39: the Navigation API seam. window.navigation is absent from
   the other fixtures on purpose - the hook must be a pure add-on. */
function makeNavEnv() {
  const listeners: Array<(e: any) => void> = [];
  const navigated: string[] = [];
  const submitted: Array<{ action: string; method: string; entries: unknown[][] }> = [];
  const w: Record<string, any> = {
    open() {
      return 1;
    },
    location: {},
    document: {
      createElement(tag: string) {
        if (tag === "input") return { type: "", name: "", value: "" };
        return {
          style: {} as Record<string, string>,
          method: "",
          action: "",
          _entries: [] as unknown[][],
          appendChild(i: { name: string; value: string }) {
            this._entries.push([i.name, i.value]);
          },
          submit() {
            submitted.push({ action: this.action, method: this.method, entries: this._entries.slice() });
          },
          remove() {},
        };
      },
      body: { appendChild() {} },
    },
    navigation: {
      addEventListener(_t: string, fn: (e: any) => void) {
        listeners.push(fn);
      },
    },
  };
  Object.defineProperty(w.location, "href", {
    configurable: true,
    get: () => LOC,
    set(v: string) {
      navigated.push(v);
    },
  });
  applyNavGuard(w, LOC, ENGINE);
  return {
    w,
    fire(e: Record<string, any>) {
      listeners.forEach((fn) => fn(e));
    },
    navigated,
    submitted,
  };
}

describe("navigation api guard (#39)", () => {
  it("cancels a real-origin navigation and re-drives through the marker", () => {
    const e = makeNavEnv();
    let prevented = false;
    e.fire({ cancelable: true, destination: { url: REAL, sameDocument: false }, preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(e.navigated).toEqual([navEncode(REAL)]);
  });

  it("leaves engine-origin, relative and opaque destinations native", () => {
    for (const url of ["https://engine.host/j/zzz", "/local", "about:blank"]) {
      const e = makeNavEnv();
      let prevented = false;
      e.fire({ cancelable: true, destination: { url, sameDocument: false }, preventDefault() { prevented = true; } });
      expect(prevented).toBe(false);
      expect(e.navigated).toEqual([]);
    }
  });

  it("leaves same-document navigations and non-cancelable events untouched", () => {
    const e = makeNavEnv();
    let prevented = false;
    e.fire({ cancelable: true, destination: { url: REAL, sameDocument: true }, preventDefault() { prevented = true; } });
    expect(prevented).toBe(false);
    e.fire({ cancelable: false, destination: { url: REAL, sameDocument: false }, preventDefault() { prevented = true; } });
    expect(prevented).toBe(false);
    expect(e.navigated).toEqual([]);
  });

  it("resubmits a canceled form POST through the marker with its entries", () => {
    const e = makeNavEnv();
    let prevented = false;
    e.fire({
      cancelable: true,
      destination: { url: "https://real.site/login", sameDocument: false },
      formData: { entries: () => [["user", "u1"], ["pw", "p1"], ["file", { name: "f.bin" }]] },
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(e.submitted.length).toBe(1);
    expect(e.submitted[0].action).toBe(navEncode("https://real.site/login"));
    expect(e.submitted[0].method).toBe("POST");
    expect(e.submitted[0].entries).toEqual([
      ["user", "u1"],
      ["pw", "p1"],
      ["file", "f.bin"],
    ]);
    expect(e.navigated).toEqual([]);
  });
});

/* #39 residual: runtime-injected meta refresh, the seam that stays
   reachable on engines without the Navigation API (Firefox: no
   window.navigation, so the cancel-and-re-drive seam never fires). */
describe("meta refresh guard (#39 residual)", () => {
  function makeMetaEnv() {
    const meta = makeClass("content");
    const w: Record<string, any> = {
      HTMLMetaElement: { prototype: meta.proto },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    return meta;
  }
  function refreshMeta(meta: ReturnType<typeof makeMetaEnv>) {
    const el = meta.make();
    el.httpEquiv = "refresh";
    return el;
  }

  it("rewires the url token of a refresh meta's content property", () => {
    const meta = makeMetaEnv();
    const el = refreshMeta(meta);
    el.content = "5; url=" + REAL;
    expect(meta.read(el)).toBe("5; url=" + navEncode(REAL));
    expect(el.content).toBe("5; url=" + REAL); /* reads stay page-truthful */
  });

  it("rewires setAttribute content on refresh metas only", () => {
    const meta = makeMetaEnv();
    const el = refreshMeta(meta);
    el.setAttribute("content", "0; url=" + REAL);
    expect(el.getAttribute("content")).toBe("0; url=" + navEncode(REAL));
    const csp = meta.make();
    csp.httpEquiv = "Content-Security-Policy";
    csp.setAttribute("content", "default-src " + REAL);
    expect(csp.getAttribute("content")).toBe("default-src " + REAL);
    const plain = meta.make();
    plain.setAttribute("content", "width=device-width");
    expect(plain.getAttribute("content")).toBe("width=device-width");
  });

  it("passes relative and engine-origin refresh urls through", () => {
    const meta = makeMetaEnv();
    const el = refreshMeta(meta);
    el.content = "2; url=/local";
    expect(meta.read(el)).toBe("2; url=/local");
    el.content = "3; url=https://engine.host/j/zzz";
    expect(meta.read(el)).toBe("3; url=https://engine.host/j/zzz");
  });

  it("rewires quoted refresh urls and keeps the quotes (#59)", () => {
    const meta = makeMetaEnv();
    const el = refreshMeta(meta);
    el.content = "0; url='" + REAL + "'";
    expect(meta.read(el)).toBe("0; url='" + navEncode(REAL) + "'");
    const d = meta.make();
    d.httpEquiv = "refresh";
    d.setAttribute("content", "1; url=\"" + REAL + "\"");
    expect(d.getAttribute("content")).toBe("1; url=\"" + navEncode(REAL) + "\"");
  });
});

/* Parser-inserted iframe/frame src: the property and setAttribute
   hooks never ran (innerHTML, document.write), so a document-wide
   MutationObserver rewires the src before the browser's queued
   iframe load task starts. */
describe("parser-inserted iframe guard", () => {
  function makeParserEnv() {
    const iframe = makeClass("src");
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
      HTMLIFrameElement: { prototype: iframe.proto },
      MutationObserver: MO,
      document: { documentElement: { tag: "html" } },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    return {
      iframe,
      observers,
      fire(records: any[]) {
        observers.forEach((o) => o.cb(records));
      },
    };
  }
  /* A parser-created frame: plain object with attribute accessors,
     not an instance of the hooked prototype. */
  function frame(attrs: Record<string, string>) {
    const el: Record<string, any> = { nodeType: 1, tagName: "IFRAME", _attrs: attrs };
    el.getAttribute = (n: string) => (n in attrs ? attrs[n] : null);
    el.setAttribute = function (this: Record<string, any>, n: string, v: string) {
      this._attrs[n] = v;
    };
    return el;
  }

  it("rewires an iframe inserted with a real-origin src", () => {
    const e = makeParserEnv();
    const f = frame({ src: REAL });
    e.fire([{ type: "childList", addedNodes: [f] }]);
    expect(f._attrs.src).toBe(navEncode(REAL));
  });

  it("descends into an added subtree and covers FRAME too", () => {
    const e = makeParserEnv();
    const f = frame({ src: "https://real.site/embed" });
    const fr: Record<string, any> = frame({ src: "https://real.site/frame" });
    fr.tagName = "FRAME";
    const root: Record<string, any> = {
      nodeType: 1,
      tagName: "DIV",
      querySelectorAll: () => [f, fr],
    };
    e.fire([{ type: "childList", addedNodes: [root] }]);
    expect(f._attrs.src).toBe(navEncode("https://real.site/embed"));
    expect(fr._attrs.src).toBe(navEncode("https://real.site/frame"));
  });

  it("skips relative, engine-origin, opaque and missing srcs", () => {
    const e = makeParserEnv();
    const rel = frame({ src: "/local" });
    const eng = frame({ src: "https://engine.host/j/zzz" });
    const opq = frame({ src: "about:blank" });
    const none = frame({});
    e.fire([{ type: "childList", addedNodes: [rel, eng, opq, none] }]);
    expect(rel._attrs.src).toBe("/local");
    expect(eng._attrs.src).toBe("https://engine.host/j/zzz");
    expect(opq._attrs.src).toBe("about:blank");
    expect(none._attrs.src).toBeUndefined();
  });

  it("ignores non-frame elements and text nodes", () => {
    const e = makeParserEnv();
    const span: Record<string, any> = {
      nodeType: 1,
      tagName: "SPAN",
      getAttribute() {
        return REAL;
      },
      setAttribute() {
        throw new Error("guard touched a non-frame element");
      },
    };
    e.fire([{ type: "childList", addedNodes: [span, { nodeType: 3 }] }]);
  });

  it("rewires a parser-inserted srcdoc child document (#58)", () => {
    const e = makeParserEnv();
    const f = frame({ srcdoc: "<a href=\"" + REAL + "\">x</a>" });
    e.fire([{ type: "childList", addedNodes: [f] }]);
    expect(f._attrs.srcdoc).toBe("<a href=\"" + navEncode(REAL) + "\">x</a>");
  });

  it("observes the document element with subtree childList", () => {
    const e = makeParserEnv();
    expect(e.observers.length).toBe(1);
    expect(e.observers[0].target.tag).toBe("html");
    expect(e.observers[0].opts).toEqual({ childList: true, subtree: true });
  });

  it("stays silent without MutationObserver (honest limit)", () => {
    const iframe = makeClass("src");
    const w: Record<string, any> = {
      HTMLIFrameElement: { prototype: iframe.proto },
      document: { documentElement: {} },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE); /* must not throw, must not observe */
  });
});

describe("setAttribute robustness (#59)", () => {
  it("matches the attribute name case-insensitively (HREF sets href)", () => {
    const e = makeEnv();
    const a = e.anchor.make();
    a.setAttribute("HREF", REAL);
    expect(a.getAttribute("HREF")).toBe(navEncode(REAL));
    a.setAttribute("HREF", "/local");
    expect(a.getAttribute("HREF")).toBe("/local");
    a.setAttribute("Title", REAL);
    expect(a.getAttribute("Title")).toBe(REAL);
  });

  it("stores the page-truthful raw value for property reads", () => {
    const e = makeEnv();
    const a = e.anchor.make();
    a.setAttribute("href", REAL);
    expect(a.href).toBe(REAL); /* the page wrote REAL, not the marker */
    expect(a.getAttribute("href")).toBe(navEncode(REAL));
  });
});

describe("srcdoc guard (#58)", () => {
  const DOC = "<a href=\"" + REAL + "\">x</a><form action=\"" + REAL + "\"></form>";
  const WANTED =
    "<a href=\"" + navEncode(REAL) + "\">x</a><form action=\"" + navEncode(REAL) + "\"></form>";

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

  it("rewires navigable attributes inside srcdoc markup (property seam)", () => {
    const srcdoc = makeSrcdocEnv();
    const el = srcdoc.make();
    el.srcdoc = DOC;
    expect(srcdoc.read(el)).toBe(WANTED);
    expect(el.srcdoc).toBe(DOC); /* reads stay page-truthful */
  });

  it("rewires srcdoc through setAttribute", () => {
    const srcdoc = makeSrcdocEnv();
    const el = srcdoc.make();
    el.setAttribute("srcdoc", DOC);
    expect(el.getAttribute("srcdoc")).toBe(WANTED);
  });

  it("leaves relative and engine-origin srcdoc markup untouched", () => {
    const srcdoc = makeSrcdocEnv();
    const el = srcdoc.make();
    const doc = "<a href=\"/local\">x</a><form action=\"https://engine.host/j/zzz\"></form>";
    el.srcdoc = doc;
    expect(srcdoc.read(el)).toBe(doc);
  });
});


/* #58 follow-up: inline child realms. An about:srcdoc / about:blank /
   same-origin child document runs no bootstrap of its own, so runtime
   navigations inside it fired in the child realm and committed
   browser-direct; the frame observer now re-enters the guard on the
   child window. */
describe("inline child realm guard (#58 follow-up)", () => {
  function makeChildRealm() {
    const anchor = makeClass("href");
    const moInstalls: Array<unknown> = [];
    class CMO {
      cb: (muts: any[]) => void;
      constructor(cb: (muts: any[]) => void) {
        this.cb = cb;
        moInstalls.push(this);
      }
      observe(_t: any, _o: any) {}
    }
    const listeners: Array<(e: any) => void> = [];
    const navigated: string[] = [];
    const win: Record<string, any> = {
      HTMLAnchorElement: { prototype: anchor.proto },
      MutationObserver: CMO,
      document: { baseURI: LOC, documentElement: { tag: "html" } },
      location: {},
      open() {
        return 1;
      },
      navigation: {
        addEventListener(_t: string, fn: (e: any) => void) {
          listeners.push(fn);
        },
      },
    };
    Object.defineProperty(win.location, "href", {
      configurable: true,
      get: () => LOC,
      set(v: string) {
        navigated.push(v);
      },
    });
    return {
      anchor,
      win,
      doc: win.document,
      moInstalls,
      navigated,
      fireNav(e: Record<string, any>) {
        listeners.forEach((fn) => fn(e));
      },
    };
  }
  /* A frame navigation replaces the child's document: swap in a
     fresh one, like a srcdoc or src change does. */
  function swapDoc(child: ReturnType<typeof makeChildRealm>) {
    child.doc = { baseURI: LOC, documentElement: { tag: "html" } };
    child.win.document = child.doc;
  }
  function childFrame(child: ReturnType<typeof makeChildRealm>) {
    const el: Record<string, any> = {
      nodeType: 1,
      tagName: "IFRAME",
      _attrs: {},
      _listeners: {},
      addEventListener(this: Record<string, any>, t: string, fn: () => void) {
        (this._listeners[t] ?? (this._listeners[t] = [])).push(fn);
      },
      getAttribute(n: string) {
        return n in el._attrs ? el._attrs[n] : null;
      },
      setAttribute(this: Record<string, any>, n: string, v: string) {
        this._attrs[n] = v;
      },
    };
    Object.defineProperty(el, "contentWindow", {
      configurable: true,
      get: () => child.win,
    });
    Object.defineProperty(el, "contentDocument", {
      configurable: true,
      get: () => child.doc,
    });
    return el;
  }
  function makeParentEnv() {
    const observers: Array<{ cb: (muts: any[]) => void }> = [];
    class PMO {
      cb: (muts: any[]) => void;
      constructor(cb: (muts: any[]) => void) {
        this.cb = cb;
        observers.push(this);
      }
      observe(_t: any, _o: any) {}
    }
    const w: Record<string, any> = {
      MutationObserver: PMO,
      document: { documentElement: { tag: "html" } },
      open() {
        return 1;
      },
    };
    applyNavGuard(w, LOC, ENGINE);
    return {
      fire(records: any[]) {
        observers.forEach((o) => o.cb(records));
      },
    };
  }

  it("guards the child realm when the observer sees an inline frame", () => {
    const parent = makeParentEnv();
    const child = makeChildRealm();
    parent.fire([{ type: "childList", addedNodes: [childFrame(child)] }]);
    const a = child.anchor.make();
    a.href = REAL;
    expect(child.anchor.read(a)).toBe(navEncode(REAL));
    let prevented = false;
    child.fireNav({
      cancelable: true,
      destination: { url: REAL, sameDocument: false },
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(child.navigated).toEqual([navEncode(REAL)]);
  });

  it("does not re-guard a document it already guards", () => {
    const parent = makeParentEnv();
    const child = makeChildRealm();
    const f = childFrame(child);
    parent.fire([{ type: "childList", addedNodes: [f] }]);
    expect(child.moInstalls.length).toBe(1);
    parent.fire([{ type: "childList", addedNodes: [f] }]);
    expect(child.moInstalls.length).toBe(1);
  });

  it("re-guards a replaced child document on the frame load event", () => {
    const parent = makeParentEnv();
    const child = makeChildRealm();
    const f = childFrame(child);
    parent.fire([{ type: "childList", addedNodes: [f] }]);
    swapDoc(child);
    (f._listeners.load ?? []).forEach((fn: () => void) => fn());
    expect(child.moInstalls.length).toBe(2);
    const a = child.anchor.make();
    a.href = REAL;
    expect(child.anchor.read(a)).toBe(navEncode(REAL));
  });

  it("skips a child realm whose own bootstrap owns the guard (__ZL)", () => {
    const parent = makeParentEnv();
    const child = makeChildRealm();
    const f = childFrame(child);
    parent.fire([{ type: "childList", addedNodes: [f] }]);
    child.win.__ZL = { site: "opaque" };
    swapDoc(child);
    (f._listeners.load ?? []).forEach((fn: () => void) => fn());
    expect(child.moInstalls.length).toBe(1);
  });

  it("skips cross-origin children without throwing", () => {
    const parent = makeParentEnv();
    const good = makeChildRealm();
    const g = childFrame(good);
    const cross = childFrame(good);
    Object.defineProperty(cross, "contentWindow", {
      configurable: true,
      get: () =>
        new Proxy(function () {}, {
          get() {
            throw new Error("cross-origin access");
          },
        }),
    });
    Object.defineProperty(cross, "contentDocument", {
      configurable: true,
      get: () => ({ baseURI: LOC }),
    });
    parent.fire([{ type: "childList", addedNodes: [cross, g] }]);
    expect(good.moInstalls.length).toBe(1); /* the sibling still got guarded */
  });

  it("re-drives a navigation exactly once in a twice-guarded realm", () => {
    const e = makeNavEnv();
    applyNavGuard(e.w, LOC, ENGINE); /* second guard on the same realm */
    let prevented = 0;
    e.fire({
      cancelable: true,
      destination: { url: REAL, sameDocument: false },
      preventDefault(this: any) {
        prevented++;
        this.defaultPrevented = true;
      },
    });
    expect(prevented).toBe(1);
    expect(e.navigated).toEqual([navEncode(REAL)]);
  });
});
