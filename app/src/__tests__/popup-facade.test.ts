import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEmbedSync, embedPopup, popupFacade } from "../bootstrap/embedsync";
import { applyNavGuard } from "../bootstrap/navguard";

/* #553 slice 2: embedded window.open keeps its synchronous return
   contract with a limited facade instead of null - only when the
   popup was really routed to the embedder. Ops correlate by an
   opaque per-open pid; the host's lb:popupState reports flip
   closed; close/focus/postMessage ride lb:popupClose/popupFocus/
   popupMessage. A fail-closed embedder still swallows and answers
   null, and facades minted before the fail-closed verdict flip
   closed honestly, native blocked-popup observables. */

const ENGINE = "https://engine.host";
const ENTRY = ENGINE + "/j/abc";
const LOC = "https://site.example/page";

function makeWin() {
  const state = { href: ENTRY };
  const nat = {
    get href() {
      return state.href;
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
    reload() {},
  };
  const listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  const opened: unknown[][] = [];
  const w: Record<string, any> = {
    location: nat,
    history: { pushState() {}, replaceState() {} },
    addEventListener(t: string, fn: (ev?: unknown) => void) {
      (listeners[t] ?? (listeners[t] = [])).push(fn);
    },
    document: { title: "t" },
    open(...args: unknown[]) {
      opened.push(args);
      return { native: true, args };
    },
  };
  return {
    w,
    opened,
    fire(type: string, ev: unknown) {
      for (const fn of listeners[type] ?? []) fn(ev);
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

function answerEmbedder(calls: Array<[unknown, unknown[]]>, port2?: unknown): void {
  const p = (calls[0]![1] as Array<{ postMessage: (m: unknown) => void }>)[0];
  p.postMessage(port2 ?? { ok: true, origin: "https://app.example", url: "https://site.example/one" });
}

const tick = () => new Promise((r) => setTimeout(r, 20));

type Nav = { lb: string; data: Record<string, unknown> };
const navCalls = (parent: { postMessage: ReturnType<typeof vi.fn> }): Nav[] =>
  parent.postMessage.mock.calls.map((c) => c[0] as Nav).filter((m) => m && m.lb === "navigate");

const opsCalls = (parent: { postMessage: ReturnType<typeof vi.fn> }): Nav[] =>
  parent.postMessage.mock.calls.map((c) => c[0] as Nav).filter((m) => m && /^popup/.test(m.lb));

async function settledWin() {
  const { w, fire } = makeWin();
  const parent = { postMessage: vi.fn() };
  w.parent = parent;
  const { calls } = stubController();
  applyEmbedSync(w);
  answerEmbedder(calls);
  await tick();
  applyNavGuard(w, LOC, ENGINE);
  return { w, fire, parent };
}

describe("popup facade (#553)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a routed popup returns a facade, not null, synchronously", async () => {
    const { w, parent } = await settledWin();
    const f = w.open("https://real.site/x", "feat");
    expect(f).toBeTruthy();
    expect(f.native).toBeUndefined();
    expect(f.name).toBe("feat");
    expect(f.closed).toBe(false);
    expect(parent.postMessage).toHaveBeenCalledWith(
      {
        lb: "navigate",
        data: expect.objectContaining({ href: "https://real.site/x", newTab: true, clientId: "", name: "feat" }),
      },
      "https://app.example",
    );
  });

  it("the same name returns the same facade object; unnamed opens do not reuse", async () => {
    const { w } = await settledWin();
    const a = w.open("https://real.site/x", "same");
    const b = w.open("https://other.site/y", "same");
    const c = w.open("https://real.site/z");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(c.name).toBe("");
  });

  it("the facade carries no destination: own keys never include the href", async () => {
    const { w } = await settledWin();
    const f = w.open("https://secret.example/private-path?token=zzz", "");
    const keys = Object.getOwnPropertyNames(f);
    expect(keys.sort()).toEqual(["close", "closed", "focus", "name", "postMessage"]);
    expect(JSON.stringify(f)).not.toContain("secret.example");
    expect(String(f)).not.toContain("secret.example");
  });

  it("unnamed opens correlate by distinct opaque pids", async () => {
    const { w, parent } = await settledWin();
    w.open("https://one.example/");
    w.open("https://two.example/");
    const navs = navCalls(parent);
    expect(navs).toHaveLength(2);
    expect(navs[0].data.pid).toMatch(/^zlp/);
    expect(navs[0].data.pid).not.toBe(navs[1].data.pid);
    expect(navs[0].data.name).toBe("");
  });

  it("host popupState reports flip closed; a wrong-origin report is ignored", async () => {
    const { w, fire, parent } = await settledWin();
    const f = w.open("https://real.site/x", "track");
    const pid = navCalls(parent)[0]!.data.pid;
    fire("message", { origin: "https://evil.example", source: w.parent, data: { lb: "popupState", data: { pid, closed: true } } });
    expect(f.closed).toBe(false);
    fire("message", { origin: "https://app.example", source: w.parent, data: { lb: "popupState", data: { pid, closed: true } } });
    expect(f.closed).toBe(true);
  });

  it("close/focus/postMessage ride the channel pid-correlated", async () => {
    const { w, parent } = await settledWin();
    const f = w.open("https://real.site/x", "ops");
    const pid = navCalls(parent)[0]!.data.pid;
    f.close();
    f.focus();
    f.postMessage({ hi: 1 }, "*");
    const ops = opsCalls(parent);
    expect(ops.map((m) => m.lb).sort()).toEqual(["popupClose", "popupFocus", "popupMessage"]);
    for (const m of ops) expect(m.data.pid).toBe(pid);
    const pm = ops.find((m) => m.lb === "popupMessage")!;
    expect(pm.data.msg).toEqual({ hi: 1 });
    expect(pm.data.targetOrigin).toBe("*");
    expect(f.closed).toBe(true);
  });

  it("postMessage rejects an invalid targetOrigin with SyntaxError", async () => {
    const { w } = await settledWin();
    const f = w.open("https://real.site/x");
    let err: any;
    try {
      f.postMessage("x", "not a url");
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.name).toBe("SyntaxError");
  });

  it("a queued pre-settle open canceled by close() never ships", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    applyNavGuard(w, LOC, ENGINE);
    const f = w.open("https://real.site/x", "queued");
    expect(f).toBeTruthy();
    f.close();
    answerEmbedder(calls);
    await tick();
    expect(navCalls(parent)).toHaveLength(0);
    expect(f.closed).toBe(true);
  });

  it("a queued pre-settle popup is routed, then delivered with pid and name", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    applyNavGuard(w, LOC, ENGINE);
    const f = w.open("https://real.site/x", "queued");
    expect(f).toBeTruthy();
    expect(f.name).toBe("queued");
    answerEmbedder(calls);
    await tick();
    expect(parent.postMessage).toHaveBeenCalledWith(
      {
        lb: "navigate",
        data: expect.objectContaining({ href: "https://real.site/x", newTab: true, clientId: "", name: "queued" }),
      },
      "https://app.example",
    );
  });

  it("a fail-closed embedder still swallows: window.open answers null; earlier facades flip closed", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    applyNavGuard(w, LOC, ENGINE);
    const f = w.open("https://real.site/x", "early");
    expect(f).toBeTruthy();
    for (let i = 0; i < 6; i++) {
      answerEmbedder(calls, { ok: false });
      await tick();
    }
    expect(w.open("https://real.site/y", "n")).toBeNull();
    expect(f.closed).toBe(true);
  });

  it("popupFacade without a routed document answers null even if called directly", () => {
    const { w } = makeWin();
    expect(popupFacade(w)).toBeNull();
  });

  it("embedPopup stays false for a document with no embedder bridge (native path)", () => {
    const { w } = makeWin();
    expect(embedPopup(w, "https://x.example/", () => {})).toBe(false);
  });
});
