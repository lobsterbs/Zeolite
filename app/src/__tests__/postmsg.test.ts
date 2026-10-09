import { describe, expect, it } from "vitest";
import { applyPostMessage } from "../bootstrap/postmsg";

function fakeWindow(origin = "https://engine.example") {
  const calls: { m: unknown; t?: unknown; tr?: unknown[] }[] = [];
  const events: unknown[] = [];
  const w: Record<string, unknown> = {
    location: { origin },
    postMessage: (m: unknown, t?: unknown, tr?: unknown[]) => {
      calls.push({ m, t, tr });
    },
    dispatchEvent: (e: unknown) => {
      events.push(e);
      return true;
    },
  };
  return { w, calls, events };
}

describe("applyPostMessage (issue #128)", () => {
  it("delivers a virtual-target message locally with the intended origin", () => {
    const { w, calls, events } = fakeWindow();
    applyPostMessage(w);
    (w.postMessage as (m: unknown, t?: unknown) => void)(
      { a: 1 },
      "https://www.google.com",
    );
    expect(calls).toHaveLength(0); // native path never ran
    expect(events).toHaveLength(1);
    const ev = events[0] as Record<string, unknown>;
    expect(ev.type).toBe("message");
    expect(ev.origin).toBe("https://www.google.com");
    expect(ev.data).toEqual({ a: 1 });
    expect(ev.source).toBeNull();
    expect(ev.lastEventId).toBe("");
  });

  it("keeps the native path for the real origin, * and /", () => {
    const { w, calls, events } = fakeWindow();
    applyPostMessage(w);
    const pm = w.postMessage as unknown as (
      m: unknown,
      t?: unknown,
      tr?: unknown[],
    ) => void;
    pm(1, "https://engine.example");
    pm(2, "*");
    pm(3, "/");
    pm(4, "https://engine.example/", []);
    expect(calls.map((c) => c.m)).toEqual([1, 2, 3, 4]);
    expect(events).toHaveLength(0);
  });

  it("keeps the native SyntaxError for malformed targetOrigin", () => {
    const { w, calls, events } = fakeWindow();
    applyPostMessage(w);
    const pm = w.postMessage as unknown as (m: unknown, t?: unknown) => void;
    pm(1, "https://"); // no host: unparseable
    pm(2, "not an origin");
    expect(calls.map((c) => c.t)).toEqual(["https://", "not an origin"]);
    expect(events).toHaveLength(0);
  });

  it("passes the transfer list through as the event ports", () => {
    const { w, events } = fakeWindow();
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    (w.postMessage as unknown as (m: unknown, t?: unknown, tr?: unknown[]) => void)(
      "m",
      "https://other.example",
      [port],
    );
    const ev = events[0] as Record<string, unknown>;
    expect(ev.ports).toEqual([port]);
  });

  it("structured-clones the payload when the host exposes it", () => {
    const { w, events } = fakeWindow();
    w.structuredClone = structuredClone;
    applyPostMessage(w);
    const payload = { deep: { n: 1 } };
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      payload,
      "https://other.example",
    );
    const ev = events[0] as Record<string, unknown>;
    expect(ev.data).toEqual(payload);
    expect(ev.data).not.toBe(payload); // a clone, not a shared reference
  });

  it("falls back to the raw payload for non-cloneable messages", () => {
    const { w, events } = fakeWindow();
    w.structuredClone = structuredClone;
    applyPostMessage(w);
    const fn = () => {};
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      fn,
      "https://other.example",
    );
    const ev = events[0] as Record<string, unknown>;
    expect(ev.data).toBe(fn);
  });

  it("uses the host MessageEvent constructor when present", () => {
    const { w, events } = fakeWindow();
    class ME {
      type: string;
      origin: string;
      data: unknown;
      constructor(t: string, init?: Record<string, unknown>) {
        this.type = t;
        this.origin = (init && String(init.origin)) || "";
        this.data = init && init.data;
      }
    }
    w.MessageEvent = ME;
    applyPostMessage(w);
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      "x",
      "https://other.example",
    );
    expect(events[0]).toBeInstanceOf(ME);
  });

  it("installs nothing without a real origin (honest absence)", () => {
    const a = fakeWindow("");
    applyPostMessage(a.w);
    const b = fakeWindow("https://engine.example");
    delete b.w.location;
    applyPostMessage(b.w);
    (a.w.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      "x",
      "https://other.example",
    );
    expect(a.calls).toHaveLength(1);
    expect(a.events).toHaveLength(0);
  });
});
