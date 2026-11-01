import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEmbedSync, embedPopup, popupFacade } from "../bootstrap/embedsync";
import { applyNavGuard } from "../bootstrap/navguard";

/* #553: embedded window.open keeps its synchronous return contract
   with a limited facade instead of null - only when the popup was
   really routed to the embedder. A fail-closed (unknown) embedder
   still swallows and answers null, native-blocked semantics. */

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
  const listeners: Record<string, Array<() => void>> = {};
  const w: Record<string, any> = {
    location: nat,
    history: { pushState() {}, replaceState() {} },
    addEventListener(t: string, fn: () => void) {
      (listeners[t] ?? (listeners[t] = [])).push(fn);
    },
    document: { title: "t" },
    open(...args: unknown[]) {
      opened.push(args);
      return { native: true, args };
    },
  };
  const opened: unknown[][] = [];
  return { w, opened };
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

describe("popup facade (#553)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a routed popup returns a facade, not null, synchronously", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    answerEmbedder(calls);
    await tick();
    applyNavGuard(w, LOC, ENGINE);
    const f = w.open("https://real.site/x", "feat");
    expect(f).toBeTruthy();
    expect(f.native).toBeUndefined();
    expect(f.name).toBe("feat");
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigate", data: { href: "https://real.site/x", newTab: true, clientId: "" } },
      "https://app.example",
    );
  });

  it("the same name returns the same facade object; unnamed opens do not reuse", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    answerEmbedder(calls);
    await tick();
    applyNavGuard(w, LOC, ENGINE);
    const a = w.open("https://real.site/x", "same");
    const b = w.open("https://other.site/y", "same");
    const c = w.open("https://real.site/z");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(c.name).toBe("");
  });

  it("the facade carries no destination: own keys never include the href", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    answerEmbedder(calls);
    await tick();
    applyNavGuard(w, LOC, ENGINE);
    const f = w.open("https://secret.example/private-path?token=zzz", "");
    const keys = [...Object.getOwnPropertyNames(f), ...(Object.getOwnPropertyDescriptor(f, "closed")?.get ? [] : [])];
    expect(keys.sort()).toEqual(["close", "closed", "focus", "name", "postMessage"]);
    expect(JSON.stringify(f)).not.toContain("secret.example");
    expect(String(f)).not.toContain("secret.example");
  });

  it("close() rides the embedder channel with the name; focus stays a no-op", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    answerEmbedder(calls);
    await tick();
    applyNavGuard(w, LOC, ENGINE);
    const f = w.open("https://real.site/x", "closable");
    f.close();
    await tick();
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "popupClose", data: { name: "closable" } },
      "https://app.example",
    );
    expect(() => f.focus()).not.toThrow();
    expect(f.closed).toBe(false);
  });

  it("postMessage is an explicit documented rejection, not a silent no-op", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    answerEmbedder(calls);
    await tick();
    applyNavGuard(w, LOC, ENGINE);
    const f = w.open("https://real.site/x");
    expect(() => f.postMessage("x", "*")).toThrow(/postMessage relay not wired/);
  });

  it("a fail-closed embedder still swallows: window.open answers null", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    /* Exhaust the bounded handshake budget without an embedder answer:
       finish(false) installs the fail-closed sink. */
    for (let i = 0; i < 6; i++) {
      answerEmbedder(calls, { ok: false });
      await tick();
    }
    applyNavGuard(w, LOC, ENGINE);
    expect(w.open("https://real.site/x", "n")).toBeNull();
  });

  it("popupFacade without a routed document answers null even if called directly", () => {
    const { w } = makeWin();
    expect(popupFacade(w, "x")).toBeNull();
  });

  it("embedPopup stays false for a document with no embedder bridge (native path)", () => {
    const { w } = makeWin();
    expect(embedPopup(w, "https://x.example/", () => {})).toBe(false);
  });

  it("a queued pre-settle popup is routed (facade justified), then delivered", async () => {
    const { w } = makeWin();
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const { calls } = stubController();
    applyEmbedSync(w);
    applyNavGuard(w, LOC, ENGINE);
    /* Open BEFORE the embedder answer: the popup queues (bounded 32). */
    const f = w.open("https://real.site/x", "queued");
    expect(f).toBeTruthy();
    expect(f.name).toBe("queued");
    answerEmbedder(calls);
    await tick();
    /* The queued popup was delivered to the embedder on settle. */
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigate", data: { href: "https://real.site/x", newTab: true, clientId: "" } },
      "https://app.example",
    );
  });
});
