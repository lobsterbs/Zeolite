import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

/* The anchor read virtualization (#180, Injector phase 1): the
   worker-side decode oracle (zl:decodeRoutes, admitted to proxied
   pages like zl:mint) and the page-side wiring (the nav guard's
   swap-row getter plus the Element.getAttribute wrap). The mock set
   mirrors control.test.ts: dispatch pulls the transport graph. */

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: { ready: async () => {} },
  altRegister: () => {},
}));

vi.mock("../ws-runtime", () => ({
  wsBridge: { open: () => {}, closeAll: () => {} },
}));

vi.mock("../request", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../request")>();
  return { ...mod, pageCacheClear: async () => {} };
});

import { handleControlEvent } from "../control";
import { applyAnchorShim } from "../bootstrap/anchorshim";
import { applyNavGuard } from "../bootstrap/navguard";
import { b64uEncode, decodeClientUrl } from "../codec";
import bootSrc from "../bootstrap.ts?raw";

const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

const mkEvent = (sourceUrl: string, msg: unknown) => {
  const posted: unknown[] = [];
  const ev = {
    data: msg,
    ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
    source: { url: sourceUrl, id: "c1" },
  } as unknown as ExtendableMessageEvent;
  return { ev, posted };
};

/* b64u token for a destination string: the legacy route the page
   can construct itself (#54 residual 1 precedent). */
const tok = (dest: string) => b64uEncode(new TextEncoder().encode(dest));

/* Fake DOM class, the navguard.test.ts pattern: a prototype
   property backed by a WeakMap plus a per-instance attribute store;
   set() bypasses the guard like HTML-parsed markup. */
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
      return Object.create(proto) as Record<string, any>;
    },
    set(el: any, v: string) {
      store.set(el, v);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("zl:decodeRoutes (worker oracle, #180)", () => {
  it("decodes the page's own routes; garbage, non-strings and overlong decode to null", async () => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
    const dest = "https://real.site/x?y=1";
    const rel = "/j/" + tok(dest);
    const abs = "https://w.example.org" + rel;
    expect(decodeClientUrl(new URL(abs))).toBe(dest);
    expect(decodeClientUrl(new URL("https://w.example.org/plain"))).toBe(null);
    const { ev, posted } = mkEvent("https://w.example.org/j/AbCdEfGhIjKlMn", {
      type: "zl:decodeRoutes",
      routes: [rel, abs, "https://w.example.org/plain", 42, null, "x".repeat(3000)],
    });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: true, dests: [dest, dest, null, null, null, null] }]);
  });

  it("bounds the batch at 64 routes", async () => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
    const routes: unknown[] = [];
    for (let i = 0; i < 70; i++) routes.push("/notaroute");
    const { ev, posted } = mkEvent("https://w.example.org/j/AbCdEfGhIjKlMn", {
      type: "zl:decodeRoutes",
      routes,
    });
    await handleControlEvent(ev, deps);
    const r = posted[0] as { ok: boolean; dests: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.dests.length).toBe(64);
    expect(r.dests.every((d) => d === null)).toBe(true);
  });
});

describe("applyAnchorShim wiring (#180)", () => {
  it("virtualizes parser-inserted anchor reads after the decode reply", async () => {
    const LOC = "https://engine.host/j/abc";
    const ENGINE = "https://engine.host";
    const dest = "https://real.site/page";
    const attr = "/j/" + tok(dest);
    const abs = "https://engine.host" + attr;
    const anchor = makeClass("href");
    const elemProto: Record<string, any> = {
      getAttribute(this: any, n: string) {
        return (this._attrs ?? {})[n] ?? null;
      },
    };
    /* parser-inserted anchor: the raw href store carries the route
       (what the browser resolved from the rewriter's markup), the
       attr string carries the route attribute. */
    const el = anchor.make();
    anchor.set(el, abs);
    el._attrs = { href: attr };
    const aEl = Object.create(elemProto) as Record<string, any>;
    aEl.tagName = "A";
    aEl._attrs = { href: attr };
    const divEl = Object.create(elemProto) as Record<string, any>;
    divEl.tagName = "DIV";
    divEl._attrs = { href: attr };
    const sent: Array<{ type: string; routes: string[] }> = [];
    const ports: Array<{ postMessage: (p: unknown) => void }> = [];
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {
          postMessage: (
            m: { type: string; routes: string[] },
            t: Array<{ postMessage: (p: unknown) => void }>,
          ) => {
            sent.push(m);
            ports.push(t[0]);
          },
        },
      },
    });
    const w: Record<string, any> = {
      HTMLAnchorElement: { prototype: anchor.proto },
      document: { readyState: "complete", querySelectorAll: () => [el, aEl] },
      location: { href: LOC },
      Element: { prototype: elemProto },
    };
    applyNavGuard(w, LOC, ENGINE);
    applyAnchorShim(w);
    /* first read race: native until the decode reply lands */
    expect(el.href).toBe(abs);
    for (let i = 0; i < 300 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe("zl:decodeRoutes");
    /* both the attr string and the absolute form were collected */
    expect(sent[0].routes).toEqual([attr, abs]);
    ports[0].postMessage({ ok: true, dests: [dest, dest] });
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    /* property getter seam (through the nav guard) */
    expect(el.href).toBe(dest);
    /* getAttribute seam on an A element */
    expect(aEl.getAttribute("href")).toBe(dest);
    /* a non-anchor href stays native */
    expect(divEl.getAttribute("href")).toBe(attr);
  });

  it("keeps the native route read when no controller answers (honest degrade)", async () => {
    const LOC = "https://engine.host/j/abc";
    const dest = "https://other.site/p";
    const attr = "/j/" + tok(dest);
    const abs = "https://engine.host" + attr;
    const anchor = makeClass("href");
    const el = anchor.make();
    anchor.set(el, abs);
    el._attrs = { href: attr };
    vi.stubGlobal("navigator", { serviceWorker: {} });
    const w: Record<string, any> = {
      HTMLAnchorElement: { prototype: anchor.proto },
      document: { readyState: "complete", querySelectorAll: () => [el] },
      location: { href: LOC },
    };
    applyNavGuard(w, LOC, "https://engine.host");
    applyAnchorShim(w);
    expect(el.href).toBe(abs);
    /* the scan fired and found no controller: no virtualization */
    await new Promise((r) => setTimeout(r, 280));
    expect(el.href).toBe(abs);
  });
});

describe("install ordering (#180)", () => {
  it("bootstrap installs the nav guard before the anchor shim", () => {
    const a = bootSrc.indexOf("applyNavGuard(");
    const b = bootSrc.indexOf("applyAnchorShim(");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });
});
