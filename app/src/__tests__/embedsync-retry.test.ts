import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEmbedSync, embedPopup } from "../bootstrap/embedsync";

const ENGINE = "https://engine.host";
const ENTRY = "/j/abc123";

/* Fake realm, the embedsync.test.ts makeWin pattern: a native
   location over a mutable href, a history that rewrites the href,
   and hand-fired listeners. */
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

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("embedder handshake retry (#491)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-arms after a transient send failure and syncs identity", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls: Array<[unknown, unknown[]]> = [];
    let n = 0;
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {
          postMessage: (m: unknown, tr?: unknown[]) => {
            n++;
            calls.push([m, tr ?? []]);
            if (n === 1) throw new Error("transient control-channel failure");
          },
        },
      },
    });
    applyEmbedSync(w);
    /* the throw re-armed the handshake instead of permanently
       disabling identity sync (the #491 regression) */
    await tick();
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toEqual({ type: "zl:getEmbedder" });
    expect(calls[1][0]).toEqual({ type: "zl:getEmbedder" });
    const port2 = (calls[1][1] as Array<{ postMessage: (m: unknown) => void }>)[0];
    port2.postMessage({ ok: true, origin: "https://app.example", url: "https://site.example/one" });
    await tick();
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "nav", data: { url: "https://site.example/one", title: "Example Domain", clientId: "", favicon: "" } },
      "https://app.example",
    );
  });

  it("an unreachable worker exhausts the bounded budget and fails closed", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    let n = 0;
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {
          postMessage: () => {
            n++;
            throw new Error("dead controller");
          },
        },
      },
    });
    applyEmbedSync(w);
    /* MAX_ATTEMPTS bounds the whole recovery: no infinite retry
       loop, and no permanent zombie state either */
    await tick();
    expect(n).toBe(4);
    /* fail-closed terminal: popups are not routed anywhere and no
       native fallback window opens */
    const fallback = vi.fn();
    expect(embedPopup(w, "https://x.example/", fallback)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("an absent controller is retryable; controllerchange completes the handshake", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const handlers: Array<() => void> = [];
    const swState: Record<string, unknown> = {
      controller: null,
      addEventListener: (_t: string, fn: () => void) => handlers.push(fn),
    };
    vi.stubGlobal("navigator", { serviceWorker: swState });
    applyEmbedSync(w);
    /* not terminal: the old code returned for good when the page
       installed before the controller existed */
    expect(parent.postMessage).not.toHaveBeenCalled();
    const calls: Array<[unknown, unknown[]]> = [];
    swState.controller = {
      postMessage: (m: unknown, tr?: unknown[]) => calls.push([m, tr ?? []]),
    };
    handlers[0](); /* controllerchange */
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toEqual({ type: "zl:getEmbedder" });
    const port2 = (calls[0][1] as Array<{ postMessage: (m: unknown) => void }>)[0];
    port2.postMessage({ ok: true, origin: "https://app.example", url: "https://site.example/one" });
    await tick();
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { ok: false }, { ok: true }, { ok: false, origin: null }])("does not authorize standalone popups from malformed reply %j", async reply => {
    const { w } = makeWin(ENGINE + ENTRY);
    w.parent = { postMessage: vi.fn() };
    let peer: MessagePort;
    vi.stubGlobal("navigator", { serviceWorker: { controller: { postMessage(_m: unknown, ports: MessagePort[]) { peer = ports[0]; } } } });
    applyEmbedSync(w);
    const fallback = vi.fn();
    embedPopup(w, "https://x.example", fallback);
    peer!.postMessage(reply);
    await tick();
    expect(fallback).not.toHaveBeenCalled();
    expect(embedPopup(w, "https://x.example", fallback)).toBe(true);
  });

});
