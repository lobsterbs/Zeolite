import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEmbedSync, embedTopNav } from "../bootstrap/embedsync";

/* #558: a target=_top activation in an embedded realm hands the
   destination to the embedder with a bounded ack; the realm's own
   native drive stays the fallback for standalone documents, silent
   hosts and fail-closed handshakes. */

const ENGINE = "https://engine.host";
const ENTRY = "/j/abc123";
/* Past the embedsync ack bound so a no-ack wait proves the fallback
   fired, not that the timer is still pending. */
const PAST_ACK = 1100;
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

  it("answers false without a bridge: the native drive owns the top", () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const fallback = vi.fn();
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("hands the destination to the embedder; the ack cancels the fallback", async () => {
    const { w, fire } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    await settle(calls, { ok: true, origin: "https://app.example", url: "https://site.example/one", clientId: "client-one" });
    const fallback = vi.fn();
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigateTab", data: { href: "https://accounts.example/signin", clientId: "client-one", ack: "zltop1" } },
      "https://app.example",
    );
    fire("message", { origin: "https://app.example", data: { lb: "navigateTabAck", nonce: "zltop1" } });
    await new Promise((r) => setTimeout(r, PAST_ACK));
    expect(fallback).not.toHaveBeenCalled();
  });

  it("runs the native fallback when no ack lands within the bound", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    await settle(calls, { ok: true, origin: "https://app.example", url: "https://site.example/one", clientId: "client-one" });
    const fallback = vi.fn();
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(true);
    await new Promise((r) => setTimeout(r, PAST_ACK));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("ignores an ack from the wrong origin", async () => {
    const { w, fire } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    await settle(calls, { ok: true, origin: "https://app.example", url: "https://site.example/one", clientId: "client-one" });
    const fallback = vi.fn();
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(true);
    fire("message", { origin: "https://evil.example", data: { lb: "navigateTabAck", nonce: "zltop1" } });
    await new Promise((r) => setTimeout(r, PAST_ACK));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("queues a pre-settle activation and delivers it on settle", async () => {
    const { w, fire } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    const fallback = vi.fn();
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(true);
    expect(parent.postMessage).not.toHaveBeenCalled();
    await settle(calls, { ok: true, origin: "https://app.example", url: "https://site.example/one", clientId: "client-one" });
    expect(parent.postMessage).toHaveBeenCalledWith(
      { lb: "navigateTab", data: { href: "https://accounts.example/signin", clientId: "client-one", ack: "zltop1" } },
      "https://app.example",
    );
    fire("message", { origin: "https://app.example", data: { lb: "navigateTabAck", nonce: "zltop1" } });
    await new Promise((r) => setTimeout(r, PAST_ACK));
    expect(fallback).not.toHaveBeenCalled();
  });

  it("runs queued fallbacks on a fail-closed terminal (unknown embedder)", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    const fallback = vi.fn();
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(true);
    await settle(calls, { ok: false });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(false);
  });

  it("runs queued fallbacks on a standalone terminal", async () => {
    const { w } = makeWin(ENGINE + ENTRY);
    const parent = { postMessage: vi.fn() };
    w.parent = parent;
    const calls = stubController();
    applyEmbedSync(w);
    const fallback = vi.fn();
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(true);
    await settle(calls, { ok: true, origin: null, url: "https://site.example/one" });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(embedTopNav(w, "https://accounts.example/signin", fallback)).toBe(false);
  });
});
