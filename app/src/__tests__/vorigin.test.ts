import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyVirtualOrigin } from "../bootstrap/vorigin";
import { PAGE_MESSAGES } from "../cpgate";

type Listener = (ev: unknown) => unknown;

function fakeWindow(origin = "https://engine.example") {
  const listeners = new Map<string, Listener[]>();
  const w: Record<string, unknown> = {
    location: { origin },
    addEventListener: (t: unknown, l: unknown) => {
      const k = String(t);
      const arr = listeners.get(k) ?? [];
      arr.push(l as Listener);
      listeners.set(k, arr);
    },
    removeEventListener: (t: unknown, l: unknown) => {
      const arr = listeners.get(String(t));
      if (!arr) return;
      const i = arr.indexOf(l as Listener);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  return { w, listeners };
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

const mkSender = (vo: string | null) => {
  const sender: Record<string, unknown> = {};
  if (vo !== null) Object.defineProperty(sender, "__zlVO", { value: vo });
  return sender;
};

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("applyVirtualOrigin (#130)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the controller for the virtual origin and marks the window", async () => {
    const { w } = fakeWindow();
    const { calls } = stubController();
    applyVirtualOrigin(w);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ type: "zl:getVirtualOrigin" });
    const port2 = (calls[0][1] as Array<{ postMessage: (m: unknown) => void }>)[0];
    port2.postMessage({ vo: "https://site.example" });
    await tick();
    expect(w.__zlVO).toBe("https://site.example");
    expect(Object.keys(w)).not.toContain("__zlVO"); // non-enumerable
  });

  it("installs no marker for a null origin (fail closed)", async () => {
    const { w } = fakeWindow();
    const { calls } = stubController();
    applyVirtualOrigin(w);
    const port2 = (calls[0][1] as Array<{ postMessage: (m: unknown) => void }>)[0];
    port2.postMessage({ vo: null });
    await tick();
    expect("__zlVO" in w).toBe(false);
  });

  it("re-labels a marked sender's engine-origin event for addEventListener", () => {
    const { w, listeners } = fakeWindow();
    stubController();
    applyVirtualOrigin(w);
    const l = vi.fn();
    (w.addEventListener as unknown as (t: string, f: Listener) => void)("message", l);
    const fwd = listeners.get("message")?.[0];
    expect(fwd).toBeDefined();
    expect(fwd).not.toBe(l); // the page's function is wrapped
    const ev = {
      origin: "https://engine.example",
      source: mkSender("https://site.example"),
      data: "x",
    };
    (fwd as Listener)(ev);
    expect(l).toHaveBeenCalledTimes(1);
    expect(l.mock.calls[0][0]).toBe(ev); // same event object
    expect((ev as { origin: unknown }).origin).toBe("https://site.example");
  });

  it("leaves unmarked senders and foreign-origin events untouched", () => {
    const { w, listeners } = fakeWindow();
    stubController();
    applyVirtualOrigin(w);
    const l = vi.fn();
    (w.addEventListener as unknown as (t: string, f: Listener) => void)("message", l);
    const fwd = listeners.get("message")?.[0] as Listener;
    const unmarked = { origin: "https://engine.example", source: mkSender(null) };
    fwd(unmarked);
    const foreign = { origin: "https://elsewhere.example", source: mkSender("https://site.example") };
    fwd(foreign);
    expect((unmarked as { origin: unknown }).origin).toBe("https://engine.example");
    expect((foreign as { origin: unknown }).origin).toBe("https://elsewhere.example");
    expect(l).toHaveBeenCalledTimes(2);
  });

  it("maps removeEventListener back to the wrapper", () => {
    const { w, listeners } = fakeWindow();
    stubController();
    applyVirtualOrigin(w);
    const l = vi.fn();
    (w.addEventListener as unknown as (t: string, f: Listener) => void)("message", l);
    expect(listeners.get("message")).toHaveLength(1);
    (w.removeEventListener as unknown as (t: string, f: Listener) => void)("message", l);
    expect(listeners.get("message")).toHaveLength(0);
  });

  it("passes non-message registrations through unchanged", () => {
    const { w, listeners } = fakeWindow();
    stubController();
    applyVirtualOrigin(w);
    const l = vi.fn();
    (w.addEventListener as unknown as (t: string, f: Listener) => void)("click", l);
    expect(listeners.get("click")?.[0]).toBe(l);
  });

  it("re-labels for window.onmessage assignments", () => {
    const { w } = fakeWindow();
    stubController();
    applyVirtualOrigin(w);
    const l = vi.fn();
    w.onmessage = l;
    const fwd = w.onmessage as Listener;
    expect(typeof fwd).toBe("function");
    const ev = {
      origin: "https://engine.example",
      source: mkSender("https://site.example"),
      data: "y",
    };
    fwd(ev);
    expect(l).toHaveBeenCalledTimes(1);
    expect((ev as { origin: unknown }).origin).toBe("https://site.example");
  });

  it("installs nothing without a controller (honest absence)", () => {
    const { w, listeners } = fakeWindow();
    vi.stubGlobal("navigator", { serviceWorker: {} }); // controller absent
    applyVirtualOrigin(w);
    const l = vi.fn();
    (w.addEventListener as unknown as (t: string, f: Listener) => void)("message", l);
    expect(listeners.get("message")?.[0]).toBe(l); // original, not wrapped
  });

  it("zl:getVirtualOrigin is page-admissible", () => {
    expect(PAGE_MESSAGES.has("zl:getVirtualOrigin")).toBe(true);
    expect(PAGE_MESSAGES.has("zl:navHandle")).toBe(false);
  });
});
