import { describe, expect, it } from "vitest";
import { applyPostMessage } from "../bootstrap/postmsg";

function fakeWindow(origin = "https://engine.example") {
  const calls: { m: unknown; t?: unknown; tr?: unknown; n: number }[] = [];
  const w: Record<string, unknown> = {
    location: { origin },
    postMessage: (...a: unknown[]) => {
      calls.push({ m: a[0], t: a[1], tr: a[2], n: a.length });
    },
  };
  return { w, calls };
}

describe("applyPostMessage (#128 -> #130 native delivery)", () => {
  it("rewrites a foreign targetOrigin to the real origin and delivers natively", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      { a: 1 },
      "https://www.google.com",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      m: { a: 1 },
      t: "https://engine.example",
      tr: undefined,
      n: 2,
    });
  });

  it("carries the transfer list on the rewritten standard-order call", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    (w.postMessage as unknown as (m: unknown, t?: unknown, tr?: unknown[]) => void)(
      "m",
      "https://other.example",
      [port],
    );
    expect(calls[0].n).toBe(3);
    expect(calls[0].t).toBe("https://engine.example");
    expect(calls[0].tr).toEqual([port]);
  });

  it("normalizes a legacy-order virtual call to the standard shape", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    // Legacy WebKit order: postMessage(msg, transfer, targetOrigin).
    (w.postMessage as unknown as (m: unknown, t?: unknown, tr?: unknown) => void)(
      "m",
      [port],
      "https://other.example",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe(3);
    expect(calls[0].t).toBe("https://engine.example");
    expect(calls[0].tr).toEqual([port]);
  });

  it("keeps the native path for the real origin, * and /", () => {
    const { w, calls } = fakeWindow();
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
    expect(calls.map((c) => [c.t, c.tr])).toEqual([
      ["https://engine.example", undefined],
      ["*", undefined],
      ["/", undefined],
      ["https://engine.example/", []],
    ]);
  });

  it("keeps the native SyntaxError for malformed targetOrigin", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    const pm = w.postMessage as unknown as (m: unknown, t?: unknown) => void;
    pm(1, "https://"); // no host: unparseable
    pm(2, "not an origin");
    expect(calls.map((c) => c.t)).toEqual(["https://", "not an origin"]);
  });

  it("replays legacy two-arg calls with the exact argument list (#128 follow-up)", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    // reCAPTCHA's frame protocol: postMessage(msg, [port]) with no
    // targetOrigin. Re-emitting this as (msg, [port], undefined)
    // made the native binding throw "Invalid target origin
    // '[object MessagePort]'".
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)("m", [port]);
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe(2); // arg count preserved, no phantom third arg
    expect(calls[0].t).toEqual([port]);
  });

  it("replays legacy three-arg calls for the real origin untouched", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    (w.postMessage as unknown as (m: unknown, t?: unknown, tr?: unknown) => void)(
      "m",
      [port],
      "https://engine.example",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe(3);
    expect(calls[0].t).toEqual([port]);
    expect(calls[0].tr).toBe("https://engine.example");
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
    expect(a.calls[0].t).toBe("https://other.example"); // untouched native call
  });
});
