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

  it("re-emits legacy two-arg port calls in standard order (#130 residual: ports must survive)", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    // reCAPTCHA's frame protocol: postMessage(msg, [port]) with no
    // targetOrigin. The exact replay reaches the recipient but
    // Chromium's legacy overload drops the ports on the event
    // (measured: ev.ports.length 0), so the anchor never receives
    // the private setup port and the widget times out. Re-emit in
    // the standard order against the real origin: same delivery,
    // ports transferred.
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)("m", [port]);
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe(3);
    expect(calls[0].t).toBe("https://engine.example");
    expect(calls[0].tr).toEqual([port]);
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


describe("applyPostMessage (#131 sender-side identity repair)", () => {
  function parentFixture() {
    const stash: unknown[][] = [];
    const parent: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      __zlNativePM: (...a: unknown[]) => {
        stash.push(a);
      },
      /* the parent's own wrapped postMessage must be BYPASSED by
         the child shim: routing through it is the corruption bug. */
      postMessage: () => {
        throw new Error("parent wrapper must be bypassed");
      },
    };
    return { parent, stash };
  }
  function childFixture(parent: Record<string, unknown>) {
    const calls: { m: unknown; t?: unknown; tr?: unknown; n: number }[] = [];
    const w: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      parent,
      postMessage: (...a: unknown[]) => {
        calls.push({ m: a[0], t: a[1], tr: a[2], n: a.length });
      },
    };
    return { w, calls };
  }

  it("stashes the native postMessage as __zlNativePM", () => {
    const { w } = childFixture(parentFixture().parent);
    applyPostMessage(w);
    expect(typeof w.__zlNativePM).toBe("function");
    // the stash is the ORIGINAL native, not the wrapper on the own slot
    expect(w.__zlNativePM).not.toBe(w.postMessage);
  });

  it("routes parent.postMessage through the parent's stashed native from the child", () => {
    const { parent, stash } = parentFixture();
    const { w } = childFixture(parent);
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    const px = w.parent as Record<string, unknown>;
    expect(px).not.toBe(parent); // shadowed by the shim proxy
    (px.postMessage as unknown as (m: unknown, t?: unknown, tr?: unknown[]) => void)(
      { setup: 1 },
      "https://www.google.com",
      [port],
    );
    expect(stash).toHaveLength(1);
    expect(stash[0]![0]).toEqual({ setup: 1 });
    expect(stash[0]![1]).toBe("https://engine.example");
    expect(stash[0]![2]).toEqual([port]);
  });

  it("normalizes the legacy bare port call on the parent path", () => {
    const { parent, stash } = parentFixture();
    const { w } = childFixture(parent);
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    ((w.parent as Record<string, unknown>).postMessage as unknown as (
      m: unknown,
      p?: unknown[],
    ) => void)("m", [port]);
    expect(stash[0]!.length).toBe(3);
    expect(stash[0]![1]).toBe("https://engine.example");
    expect(stash[0]![2]).toEqual([port]);
  });

  it("keeps a malformed targetOrigin for the native SyntaxError on the parent path", () => {
    const { parent, stash } = parentFixture();
    const { w } = childFixture(parent);
    applyPostMessage(w);
    ((w.parent as Record<string, unknown>).postMessage as unknown as (
      m: unknown,
      t?: unknown,
    ) => void)("m", "not an origin");
    expect(stash[0]![1]).toBe("not an origin");
  });

  it("forwards other parent reads through the proxy and binds functions", () => {
    const { parent } = parentFixture();
    parent.scroll = function (this: unknown) {
      return this;
    };
    const { w } = childFixture(parent);
    applyPostMessage(w);
    const px = w.parent as Record<string, unknown>;
    expect(px.location).toBe(parent.location);
    const bound = px.scroll as unknown as (...a: unknown[]) => unknown;
    expect(bound()).toBe(parent); // bound to the real parent
  });

  it("does not touch a real-origin or * target on the parent path", () => {
    const { parent, stash } = parentFixture();
    const { w } = childFixture(parent);
    applyPostMessage(w);
    const px = w.parent as Record<string, unknown>;
    const pm = px.postMessage as unknown as (m: unknown, t?: unknown) => void;
    pm(1, "https://engine.example");
    pm(2, "*");
    expect(stash.map((a) => a[0])).toEqual([1, 2]);
    expect(stash.map((a) => a[1])).toEqual(["https://engine.example", "*"]);
  });

  it("installs no shadow on a top-level realm (parent === self)", () => {
    const calls: { m: unknown; t?: unknown; n: number }[] = [];
    const w: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      postMessage: (...a: unknown[]) => {
        calls.push({ m: a[0], t: a[1], n: a.length });
      },
    };
    w.parent = w;
    applyPostMessage(w);
    expect(w.parent).toBe(w);
  });

  it("installs no shadow when the parent has no stash (honest absence)", () => {
    const parent: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      postMessage: () => {},
    };
    const { w, calls } = childFixture(parent);
    applyPostMessage(w);
    expect(w.parent).toBe(parent); // untouched: the parent is not patched
    expect(calls).toHaveLength(0);
  });
});
