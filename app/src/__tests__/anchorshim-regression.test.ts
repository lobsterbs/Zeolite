import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

/* Regression coverage for the #488/#489/#490 anchor-shim wave: scan
   convergence past the string-memo LRU bound (#488), read-driven
   refresh of evicted routes (#488), decode-channel teardown on every
   settle path (#489), and coherent component reads (#490). The mock
   set mirrors anchorshim.test.ts: the module graph pulls the
   transport stack. */

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

import { applyAnchorShim } from "../bootstrap/anchorshim";
import { applyNavGuard } from "../bootstrap/navguard";
import { b64uEncode } from "../codec";

const ENGINE = "https://engine.host";
const LOC = ENGINE + "/j/abc";

/* b64u token for a destination string: the legacy route the page
   can construct itself. */
const tok = (dest: string) => b64uEncode(new TextEncoder().encode(dest));

/* Fake DOM class, the navguard.test.ts pattern: a prototype property
   backed by a WeakMap plus a per-instance attribute store. */
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

/* The Element-proto seam: the wrapped Element.prototype.getAttribute
   virtualizes href reads on these elements. */
function makeElemProto() {
  const proto: Record<string, any> = {
    getAttribute(this: any, n: string) {
      return (this._attrs ?? {})[n] ?? null;
    },
  };
  return proto;
}

/* Controller stub; the optional auto-reply answers synchronously on
   the transferred port (delivered on a later macrotask). */
function stubController(reply?: (routes: string[]) => unknown[]) {
  const calls: Array<{ m: any; port: any }> = [];
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage: (m: any, tr: any[]) => {
          const port = tr?.[0];
          calls.push({ m, port });
          if (reply) port.postMessage({ ok: true, dests: reply(m.routes) });
        },
      },
    },
  });
  return { calls };
}

/* Counting MessageChannel: records close() on both endpoints and
   onmessage detachment, so the #489 teardown contract is testable. */
function instrumentChannels() {
  const recs: Array<Record<string, any>> = [];
  const Real = MessageChannel;
  const Fake = function (this: any) {
    const real = new Real();
    const rec: Record<string, any> = { c1: false, c2: false };
    const k1 = real.port1.close.bind(real.port1);
    real.port1.close = () => {
      rec.c1 = true;
      k1();
    };
    const k2 = real.port2.close.bind(real.port2);
    real.port2.close = () => {
      rec.c2 = true;
      k2();
    };
    rec.detached = () => real.port1.onmessage == null;
    recs.push(rec);
    this.port1 = real.port1;
    this.port2 = real.port2;
  } as any;
  vi.stubGlobal("MessageChannel", Fake);
  return recs;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(cond: () => boolean, ms: number): Promise<boolean> {
  for (let t = 0; t < ms && !cond(); t += 25) await sleep(25);
  return cond();
}

/* A 600-anchor document with distinct legacy routes: both the
   property seam (anchor proto, raw absolute route in the href store)
   and the getAttribute seam (Element-proto elements) are
   represented. 600 routes x 2 forms exceed MEMO_MAX(512): the #488
   eviction shape. */
function makeDoc(n: number, tag: string) {
  const anchor = makeClass("href");
  const elemProto = makeElemProto();
  const byRoute = new Map<string, string>();
  const anchors: any[] = [];
  const dests: string[] = [];
  const attrs: string[] = [];
  const nodes: any[] = [];
  for (let i = 0; i < n; i++) {
    const dest = "https://" + tag + ".example/p" + i;
    const attr = "/j/" + tok(dest);
    dests.push(dest);
    attrs.push(attr);
    byRoute.set(attr, dest);
    byRoute.set(ENGINE + attr, dest);
    const el = anchor.make();
    el.tagName = "A";
    anchor.set(el, ENGINE + attr);
    el._attrs = { href: attr };
    anchors.push(el);
    nodes.push(el);
  }
  const mkElem = (i: number) => {
    const e = Object.create(elemProto);
    e.tagName = "A";
    e._attrs = { href: attrs[i] };
    return e;
  };
  /* the eviction probe: an Element-proto element sharing anchor 0's
     EARLY route, visited inside the first window so it is seeded
     together with anchor 0 and never recollected afterwards. A late
     visitor would legitimately re-ask its (already evicted) route
     and re-memoize it, weakening the eviction assertion. */
  const gEvict = mkElem(0);
  const gLast = mkElem(n - 1);
  nodes.unshift(gEvict);
  nodes.push(gLast);
  const w: Record<string, any> = {
    HTMLAnchorElement: { prototype: anchor.proto },
    Element: { prototype: elemProto },
    document: { readyState: "complete", querySelectorAll: () => nodes },
    location: { href: LOC },
  };
  applyNavGuard(w, LOC, ENGINE);
  applyAnchorShim(w);
  return { anchors, gEvict, gLast, byRoute, dests, attrs };
}

describe("scan convergence and eviction (#488)", () => {
  let shared: ReturnType<typeof makeDoc> | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "converges a 600-route document past the memo LRU bound without a rescan storm",
    async () => {
      const doc = makeDoc(600, "conv");
      shared = doc;
      const { calls } = stubController((routes: string[]) =>
        routes.map((r) => doc.byRoute.get(r) ?? null),
      );
      /* the LAST anchor and the LAST getAttribute element both
         virtualize: full convergence, not just the first window */
      const ok = await poll(
        () =>
          doc.anchors[599].href === doc.dests[599] &&
          doc.gLast.getAttribute("href") === doc.dests[599],
        25000,
      );
      expect(ok).toBe(true);
      /* every batch respects the decode bound */
      for (const c of calls) expect(c.m.routes.length).toBeLessThanOrEqual(64);
      /* 1200 routes / 64 per window plus refresh slack: bounded,
         never a per-scan storm (the #488 regression was endless
         rounds rescanning the evicted document prefix). */
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBeLessThanOrEqual(30);
      /* quiet after convergence: no further decode rounds */
      const quiet = calls.length;
      await sleep(700);
      expect(calls.length).toBe(quiet);
    },
    30000,
  );

  it(
    "an evicted string memo does not strand reads: elMemo answers, the read refreshes",
    async () => {
      expect(shared).not.toBeNull();
      const doc = shared!;
      const { calls } = stubController((routes: string[]) =>
        routes.map((r) => doc.byRoute.get(r) ?? null),
      );
      /* route 0 left the 512-entry LRU window hundreds of inserts
         ago; the element-associated result still answers the
         getAttribute seam without a re-ask */
      expect(doc.gEvict.getAttribute("href")).toBe(doc.dests[0]);
      expect(calls.length).toBe(0);
      /* the property seam missed the evicted string memo: native
         once, exactly the honest race */
      const first = doc.anchors[0].href;
      expect(first).toBe(ENGINE + doc.attrs[0]);
      expect(first).not.toBe(doc.dests[0]);
      /* the read itself drives the refresh; the second read
         virtualizes, and getAttribute never flips back */
      const ok = await poll(() => doc.anchors[0].href === doc.dests[0], 5000);
      expect(ok).toBe(true);
      expect(doc.gEvict.getAttribute("href")).toBe(doc.dests[0]);
      /* one refresh, not a storm */
      const after = calls.length;
      expect(after).toBeGreaterThanOrEqual(1);
      expect(after).toBeLessThanOrEqual(2);
      await sleep(500);
      expect(calls.length).toBe(after);
    },
    15000,
  );
});

describe("decode channel teardown (#489)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const setup = (dest: string) => {
    const anchor = makeClass("href");
    const elemProto = makeElemProto();
    const attr = "/j/" + tok(dest);
    const abs = ENGINE + attr;
    const el = anchor.make();
    el.tagName = "A";
    anchor.set(el, abs);
    el._attrs = { href: attr };
    return { anchor, elemProto, attr, abs, el, dest };
  };

  it(
    "closes the held port and detaches the listener on a successful reply",
    async () => {
      const recs = instrumentChannels();
      const s = setup("https://teardown1.example/page");
      const ports: any[] = [];
      vi.stubGlobal("navigator", {
        serviceWorker: {
          controller: { postMessage: (_m: any, tr: any[]) => ports.push(tr[0]) },
        },
      });
      const w: Record<string, any> = {
        HTMLAnchorElement: { prototype: s.anchor.proto },
        Element: { prototype: s.elemProto },
        document: { readyState: "complete", querySelectorAll: () => [s.el] },
        location: { href: LOC },
      };
      applyNavGuard(w, LOC, ENGINE);
      applyAnchorShim(w);
      expect(await poll(() => ports.length === 1, 3000)).toBe(true);
      ports[0].postMessage({ ok: true, dests: [s.dest, s.dest] });
      expect(
        await poll(() => recs[recs.length - 1].c1 && recs[recs.length - 1].detached(), 2000),
      ).toBe(true);
      expect(s.el.href).toBe(s.dest);
    },
    10000,
  );

  it(
    "settles on an invalid reply, stays retryable on a fresh channel",
    async () => {
      const recs = instrumentChannels();
      const s = setup("https://teardown2.example/page");
      const ports: any[] = [];
      vi.stubGlobal("navigator", {
        serviceWorker: {
          controller: { postMessage: (_m: any, tr: any[]) => ports.push(tr[0]) },
        },
      });
      const w: Record<string, any> = {
        HTMLAnchorElement: { prototype: s.anchor.proto },
        Element: { prototype: s.elemProto },
        document: { readyState: "complete", querySelectorAll: () => [s.el] },
        location: { href: LOC },
      };
      applyNavGuard(w, LOC, ENGINE);
      applyAnchorShim(w);
      expect(await poll(() => ports.length === 1, 3000)).toBe(true);
      ports[0].postMessage({ ok: false });
      expect(await poll(() => recs[0].c1 && recs[0].detached(), 2000)).toBe(true);
      /* honest degrade: the read stays native and retryable */
      expect(s.el.href).toBe(s.abs);
      /* the read miss re-asks on a fresh channel */
      expect(await poll(() => ports.length === 2, 4000)).toBe(true);
      ports[1].postMessage({ ok: true, dests: [s.dest, s.dest] });
      expect(await poll(() => s.el.href === s.dest, 3000)).toBe(true);
      expect(recs[1].c1).toBe(true);
      expect(recs[1].detached()).toBe(true);
    },
    15000,
  );

  it(
    "closes both held endpoints when the synchronous send throws",
    async () => {
      const recs = instrumentChannels();
      const s = setup("https://teardown3.example/page");
      const ge = Object.create(s.elemProto);
      ge.tagName = "A";
      ge._attrs = { href: s.attr };
      vi.stubGlobal("navigator", {
        serviceWorker: {
          controller: {
            postMessage: () => {
              throw new Error("dead controller");
            },
          },
        },
      });
      const w: Record<string, any> = {
        HTMLAnchorElement: { prototype: s.anchor.proto },
        Element: { prototype: s.elemProto },
        document: { readyState: "complete", querySelectorAll: () => [s.el, ge] },
        location: { href: LOC },
      };
      applyNavGuard(w, LOC, ENGINE);
      applyAnchorShim(w);
      expect(
        await poll(
          () => recs.length === 1 && recs[0].c1 && recs[0].c2 && recs[0].detached(),
          3000,
        ),
      ).toBe(true);
      /* honest degrade: nothing thrown to the page, reads stay native */
      expect(s.el.href).toBe(s.abs);
      expect(ge.getAttribute("href")).toBe(s.attr);
    },
    10000,
  );
});

describe("component getters and stringifier (#490)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "component reads agree with the virtual href once decoded; setters stay native",
    async () => {
      const store = new WeakMap<object, string>();
      const raw = (el: any) => store.get(el) ?? "";
      const proto: Record<string, any> = {
        setAttribute(this: any, n: string, v: string) {
          (this._attrs ?? (this._attrs = {}))[n] = v;
        },
        getAttribute(this: any, n: string) {
          return (this._attrs ?? {})[n] ?? null;
        },
        toString(this: any) {
          return raw(this);
        },
      };
      Object.defineProperty(proto, "href", {
        configurable: true,
        enumerable: true,
        get(this: any) {
          return store.get(this);
        },
        set(this: any, v: string) {
          store.set(this, v);
        },
      });
      for (const c of ["protocol", "host", "hostname", "port", "search", "hash"]) {
        Object.defineProperty(proto, c, {
          configurable: true,
          enumerable: true,
          get(this: any) {
            try {
              return (new URL(raw(this)) as any)[c];
            } catch {
              return "";
            }
          },
        });
      }
      /* the native pathname setter mutates the raw href like the
         browser does; the shim must preserve it */
      Object.defineProperty(proto, "pathname", {
        configurable: true,
        enumerable: true,
        get(this: any) {
          try {
            return new URL(raw(this)).pathname;
          } catch {
            return "";
          }
        },
        set(this: any, v: string) {
          try {
            const u = new URL(raw(this));
            u.pathname = v;
            store.set(this, u.href);
          } catch {
            /* unparseable: no-op */
          }
        },
      });
      Object.defineProperty(proto, "origin", {
        configurable: true,
        enumerable: true,
        get(this: any) {
          try {
            return new URL(raw(this)).origin;
          } catch {
            return "";
          }
        },
      });

      const dest = "https://real2.site:8443/app/page?q=1#f";
      const attr = "/j/" + tok(dest);
      const abs = ENGINE + attr;
      const el = Object.create(proto);
      el.tagName = "A";
      store.set(el, abs);
      el._attrs = { href: attr };
      const elemProto = makeElemProto();
      const ports: any[] = [];
      vi.stubGlobal("navigator", {
        serviceWorker: {
          controller: { postMessage: (_m: any, tr: any[]) => ports.push(tr[0]) },
        },
      });
      const w: Record<string, any> = {
        HTMLAnchorElement: { prototype: proto },
        Element: { prototype: elemProto },
        document: { readyState: "complete", querySelectorAll: () => [el] },
        location: { href: LOC },
      };
      applyNavGuard(w, LOC, ENGINE);
      applyAnchorShim(w);
      /* while pending the components read the native route value */
      expect(el.hostname).toBe("engine.host");
      expect(await poll(() => ports.length === 1, 3000)).toBe(true);
      ports[0].postMessage({ ok: true, dests: [dest, dest] });
      expect(await poll(() => el.href === dest, 3000)).toBe(true);
      /* every component now derives from the virtual href */
      expect(el.protocol).toBe("https:");
      expect(el.host).toBe("real2.site:8443");
      expect(el.hostname).toBe("real2.site");
      expect(el.port).toBe("8443");
      expect(el.pathname).toBe("/app/page");
      expect(el.search).toBe("?q=1");
      expect(el.hash).toBe("#f");
      expect(el.origin).toBe("https://real2.site:8443");
      expect(String(el)).toBe(dest);
      /* the component setter keeps the browser's own mutation */
      el.pathname = "/native-write";
      expect(raw(el)).toBe("https://engine.host/native-write");
    },
    10000,
  );
});
