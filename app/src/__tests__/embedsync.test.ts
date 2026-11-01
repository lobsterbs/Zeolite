import { afterEach, describe, expect, it, vi } from "vitest";
import { applyVloc } from "../bootstrap/vloc";
import { applyEmbedSync } from "../bootstrap/embedsync";
import { applyNavGuard } from "../bootstrap/navguard";
import { PAGE_MESSAGES } from "../cpgate";

const ENGINE = "https://engine.host";
const ENTRY = "/j/abc123";

/* Fake realm for both vloc and embedsync: a native location over a
   mutable href, a history that rewrites the href like the browser
   does, and listener storage the tests fire by hand (the makeWin
   shape of vloc.test.ts, plus parent + document for the sync). */
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
      /* no-op */
    },
  };
  const hist = {
    pushState(_s: unknown, _t: string, u?: string | null) {
      if (u != null) state.href = new URL(u, state.href).href;
    },
    replaceState(_s: unknown, _t: string, u?: string | null) {
      if (u != null) state.href = new URL(u, state.href).href;
    },
  };
  const listeners: Record<string, Array<() => void>> = {};
  const w: Record<string, unknown> = {
    location: nat,
    history: hist,
    addEventListener(t2: string, fn: () => void) {
      (listeners[t2] ?? (listeners[t2] = [])).push(fn);
    },
    document: { title: "Example Domain" },
  };
  return {
    w,
    state,
    fire(t2: string) {
      for (const fn of listeners[t2] ?? []) fn();
    },
  };
}

function stubController() {
  const calls: Array<[unknown, unknown[]]> = [];
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage: (m: unknown, tr?: unknown[]) => {
          calls.push([m, tr ?? []]);
        },
      },
    },
  });
  return { calls };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("applyEmbedSync (#107 phase 2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays inert for a top-level document (no embedder to sync)", () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const { calls } = stubController();
    w.parent = w;
    applyEmbedSync(w);
    expect(calls).toHaveLength(0);
  });

  it("posts lb:nav url+title to the registered embedder, then on vloc moves", async () => {
    const { w, fire } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyVloc(w, "/one");
    applyEmbedSync(w);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ type: "zl:getEmbedder" });
    const port2 = (calls[0][1] as Array<{ postMessage: (m: unknown) => void }>)[0];
    port2.postMessage({ ok: true, origin: "https://app.example", url: "https://site.example/one" });
    await tick();
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "nav", data: { url: "https://site.example/one", title: "Example Domain", clientId: "", favicon: "" } },
      "https://app.example",
    );
    /* a pushState-driven virtual move re-emits with the same base */
    const h = w.history as { pushState(s: unknown, t: string, u?: string | null): void };
    h.pushState({}, "", "/two?q=1");
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { lb: "nav", data: { url: "https://site.example/two?q=1", title: "Example Domain", clientId: "", favicon: "" } },
      "https://app.example",
    );
    /* the load listener re-emits the current state */
    fire("load");
    expect(parent.postMessage).toHaveBeenCalledTimes(3);
  });

  it("installs nothing without a registered embedder (fail closed)", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyVloc(w, "/one");
    applyEmbedSync(w);
    const port2 = (calls[0][1] as Array<{ postMessage: (m: unknown) => void }>)[0];
    port2.postMessage({ ok: true, origin: null, url: "https://site.example/one" });
    await tick();
    const h = w.history as { pushState(s: unknown, t: string, u?: string | null): void };
    h.pushState({}, "", "/two");
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("never emits an opaque engine route (hash-only move on a routeless document)", async () => {
    const { w, fire } = makeWin(ENGINE + ENTRY + "#top");
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyVloc(w); // no vpath: cur stays the opaque entry route
    applyEmbedSync(w);
    const port2 = (calls[0][1] as Array<{ postMessage: (m: unknown) => void }>)[0];
    port2.postMessage({ ok: true, origin: "https://app.example", url: "https://site.example/one" });
    await tick();
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    /* popstate with no decodable route only moves the hash: the hook
       must NOT re-emit the opaque route as a URL. */
    fire("popstate");
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("#41 gate direction for the embedder messages (#107 phase 2)", () => {
  it("zl:getEmbedder is page-facing, zl:embedderOrigin is host-only", () => {
    expect(PAGE_MESSAGES.has("zl:getEmbedder")).toBe(true);
    expect(PAGE_MESSAGES.has("zl:embedderOrigin")).toBe(false);
  });
});

describe("embedder popup routing (#416)", () => {
  afterEach(() => vi.unstubAllGlobals());
  function setup() {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    const nativeOpen = vi.fn();
    const listeners: Record<string, (e: Event) => void> = {};
    w.parent = parent; w.open = nativeOpen;
    w.addEventListener = (t: string, fn: (e: Event) => void) => { listeners[t] = fn; };
    const { calls } = stubController();
    applyNavGuard(w, ENGINE + ENTRY, ENGINE);
    applyEmbedSync(w);
    const register = async (origin: string | null = "https://app.example") => {
      (calls[0][1][0] as MessagePort).postMessage({ ok: true, origin, url: "https://site.example/dir/page", clientId: "client-one" });
      await tick();
    };
    const open = w.open as (href?: string, target?: string, features?: string) => unknown;
    return { w, parent, nativeOpen, listeners, calls, register, open };
  }
  it("queues startup window.open and sends only to the registered parent", async () => {
    const e = setup();
    /* #553: a queued popup is accepted for routing, so window.open
       answers the limited facade instead of null. */
    const facade = e.open("https://accounts.example/signin", "_blank", "noopener");
    expect(facade).toBeTruthy();
    expect(facade.name).toBe("_blank");
    expect(e.nativeOpen).not.toHaveBeenCalled(); expect(e.parent.postMessage).not.toHaveBeenCalled();
    await e.register();
    expect(e.parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigate", data: { href: "https://accounts.example/signin", newTab: true, clientId: "client-one" } }, "https://app.example");
    expect(e.nativeOpen).not.toHaveBeenCalled();
  });
  it("routes relative and blank window.open requests into host tabs", async () => {
    const e = setup(); await e.register(); e.open("../signin"); e.open();
    expect(e.parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigate", data: { href: "https://site.example/signin", newTab: true, clientId: "client-one" } }, "https://app.example");
    expect(e.parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigate", data: { href: "", newTab: true, blank: true, clientId: "client-one" } }, "https://app.example");
    expect(e.nativeOpen).not.toHaveBeenCalled();
  });
  it("decodes engine links and suppresses the click/auxclick pair", async () => {
    const e = setup(); await e.register();
    const anchor = { tagName: "A", href: ENGINE + "/__zl_nav__/abc", target: "_blank" };
    const click = new Event("click", { cancelable: true });
    Object.defineProperty(click, "target", { value: anchor }); e.listeners.click(click);
    const aux = new Event("auxclick", { cancelable: true });
    Object.defineProperties(aux, { target: { value: anchor }, button: { value: 1 } }); e.listeners.auxclick(aux);
    expect(click.defaultPrevented).toBe(true); expect(aux.defaultPrevented).toBe(true);
    const decodes = e.calls.filter(c => (c[0] as { type: string }).type === "zl:decodeRoutes");
    expect(decodes).toHaveLength(1);
    expect(decodes[0][0]).toEqual({ type: "zl:decodeRoutes", routes: [anchor.href] });
    (decodes[0][1][0] as MessagePort).postMessage({ ok: true, dests: ["https://accounts.example/login"] }); await tick();
    expect(e.parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigate", data: { href: "https://accounts.example/login", newTab: true, clientId: "client-one" } }, "https://app.example");
    expect(e.nativeOpen).not.toHaveBeenCalled();
  });
  it("preserves standalone fallback after an explicit no-embedder reply", async () => {
    const e = setup(); e.open("https://site.example/next"); await e.register(null);
    expect(e.nativeOpen).toHaveBeenCalledTimes(1); expect(e.parent.postMessage).not.toHaveBeenCalled();
  });
});
