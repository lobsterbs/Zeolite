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
});
