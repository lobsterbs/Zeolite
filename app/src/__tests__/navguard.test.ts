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
});
