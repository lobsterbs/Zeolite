import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEmbedSync, embedPopup } from "../bootstrap/embedsync";

/* #558: a target=_top activation in an embedded realm hands the
   destination to the embedder, which owns the real top document;
   the realm never drives the top natively once the embedder is
   known. A realm without a live embedder keeps the native drive
   through the fallback. The fail-closed terminal follows the
   file's own unknown-embedder rule for queued activations: not
   routed, not driven. */

const ENGINE = "https://engine.host";
const ENTRY = "/j/abc123";
const tick = () => new Promise((r) => setTimeout(r, 20));

function makeWin(href: string) {
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const w: Record<string, unknown> = {
    location: { href },
    history: { pushState() {}, replaceState() {} },
    addEventListener(t: string, fn: (e?: unknown) => void) {
      (listeners[t] ?? (listeners[t] = [])).push(fn);
    },
    document: { title: "Example Domain" },
  };
  return {
    w,
    fire(t: string, ev?: unknown) {
      for (const fn of listeners[t] ?? []) fn(ev);
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
  return calls;
}

async function settle(calls: Array<[unknown, unknown[]]>, reply: unknown) {
  const tr = (calls[0] as unknown[])[1] as Array<{ postMessage: (m: unknown) => void }>;
  tr[0].postMessage(reply);
  await tick();
}

describe("embedder top-nav handoff (#558)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers false without a bridge: the caller keeps its native drive", () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const fallback = vi.fn();
    expect(embedPopup(w, "https://accounts.example/signin", fallback, true)).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("hands the destination to the embedder; the realm never drives the top natively", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    await settle(calls, { ok: true, origin: "https://app.example", url: "https://site.example/one", clientId: "client-one" });
    const fallback = vi.fn();
    expect(embedPopup(w, "https://accounts.example/signin", fallback, true)).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigateTab", data: { href: "https://accounts.example/signin" } },
      "https://app.example",
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(fallback).not.toHaveBeenCalled();
  });

  it("queues a pre-settle activation and delivers it on settle", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    const fallback = vi.fn();
    expect(embedPopup(w, "https://accounts.example/signin", fallback, true)).toBe(true);
    expect(parent.postMessage).not.toHaveBeenCalled();
    await settle(calls, { ok: true, origin: "https://app.example", url: "https://site.example/one", clientId: "client-one" });
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigateTab", data: { href: "https://accounts.example/signin" } },
      "https://app.example",
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it("fails closed like popups: a terminal unknown embedder neither routes nor drives", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    const fallback = vi.fn();
    expect(embedPopup(w, "https://accounts.example/signin", fallback, true)).toBe(true);
    await settle(calls, { ok: false });
    expect(parent.postMessage).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    /* the terminal noop swallows the request like a popup: the
       fail-closed rule is one rule for every queued activation. */
    expect(embedPopup(w, "https://accounts.example/two", fallback, true)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("runs queued fallbacks on a standalone terminal and answers false afterwards", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    const fallback = vi.fn();
    expect(embedPopup(w, "https://accounts.example/signin", fallback, true)).toBe(true);
    await settle(calls, { ok: true, origin: null, url: "https://site.example/one" });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(embedPopup(w, "https://accounts.example/two", fallback, true)).toBe(false);
  });
});
