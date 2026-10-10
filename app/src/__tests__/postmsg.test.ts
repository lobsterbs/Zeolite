import { describe, expect, it } from "vitest";
import { applyPostMessage, childProxyOf } from "../bootstrap/postmsg";

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

  it("replays the bare legacy two-arg port call exactly (#132: native semantics)", () => {
    const { w, calls } = fakeWindow();
    applyPostMessage(w);
    const port = { postMessage: () => {} };
    // reCAPTCHA's own-realm bootstrap: postMessage(msg, [port]).
    // Direct-run measurement 2026-10-10: the native legacy overload
    // drops the ports on self-delivery and preserves them
    // cross-frame. Re-emitting in standard order delivered phantom
    // self-ports that a first-match setup listener stole, so the
    // engine replays the exact shape and lets the native keep its
    // own semantics.
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)("m", [port]);
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe(2);
    expect(calls[0].t).toEqual([port]);
    expect(calls[0].tr).toBeUndefined();
  });

  it("shares the contentWindow proxy with childProxyOf (#132 identity)", () => {
    const { w } = fakeWindow();
    const child: Record<string, unknown> = {};
    Object.defineProperty(child, "__zlNativePM", {
      value: () => {},
      configurable: true,
    });
    const proto: Record<string, unknown> = {};
    Object.defineProperty(proto, "contentWindow", {
      get: () => child,
      configurable: true,
    });
    w.HTMLIFrameElement = { prototype: proto };
    applyPostMessage(w);
    const got = (proto as Record<string, unknown>).contentWindow as Record<string, unknown>;
    expect(got).not.toBe(child);
    expect(typeof got.postMessage).toBe("function");
    expect(childProxyOf(child)).toBe(got);
    expect(childProxyOf({})).toBeUndefined();
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


describe("applyPostMessage (#132 own-slot parity drop)", () => {
  it("drops a foreign targetOrigin that does not match the recipient marker", () => {
    const { w, calls } = fakeWindow();
    w.__zlVO = "https://site.example";
    applyPostMessage(w);
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      1,
      "https://other.example",
    );
    expect(calls).toHaveLength(0);
  });

  it("delivers when the targetOrigin matches the recipient marker", () => {
    const { w, calls } = fakeWindow();
    w.__zlVO = "https://www.google.com";
    applyPostMessage(w);
    (w.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      2,
      "https://www.google.com",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.t).toBe("https://engine.example");
  });

  it("drops a parent-path call whose targetOrigin misses the parent marker", () => {
    const stash: unknown[][] = [];
    const parent: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      __zlVO: "https://page.example",
      __zlNativePM: (...a: unknown[]) => {
        stash.push(a);
      },
      postMessage: () => {},
    };
    const w: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      parent,
      postMessage: () => {},
    };
    applyPostMessage(w);
    (
      (w.parent as Record<string, unknown>).postMessage as unknown as (
        m: unknown,
        t?: unknown,
      ) => void
    )(3, "https://wrong.example");
    expect(stash).toHaveLength(0);
  });
});

describe("applyPostMessage (#132 contentWindow sender half)", () => {
  function frameFixture(vo?: string) {
    const childCalls: { m: unknown; t?: unknown; tr?: unknown; n: number }[] = [];
    const child: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      __zlNativePM: (...a: unknown[]) => {
        childCalls.push({ m: a[0], t: a[1], tr: a[2], n: a.length });
      },
      /* the child's own wrapped postMessage must be BYPASSED by the
         contentWindow shim: routing through it is the corruption. */
      postMessage: () => {
        throw new Error("child wrapper must be bypassed");
      },
    };
    if (vo !== undefined) child.__zlVO = vo;
    const el: Record<string, unknown> = {};
    const proto: Record<string, unknown> = {};
    Object.defineProperty(proto, "contentWindow", {
      get: () => child,
      configurable: true,
    });
    const w: Record<string, unknown> = {
      location: { origin: "https://engine.example" },
      postMessage: () => {},
      HTMLIFrameElement: { prototype: proto },
    };
    w.parent = w; /* top realm: the parent half stays out of the way */
    return { w, el, proto, child, childCalls };
  }
  const getCw = (f: {
    proto: Record<string, unknown>;
    el: Record<string, unknown>;
  }): unknown =>
    (
      Object.getOwnPropertyDescriptor(f.proto, "contentWindow")!.get as unknown as (
        this: unknown,
      ) => unknown
    ).call(f.el);

  it("routes element.contentWindow.postMessage through the child stash", () => {
    const f = frameFixture("https://www.google.com");
    applyPostMessage(f.w);
    const px = getCw(f) as Record<string, unknown>;
    expect(px).not.toBe(f.child);
    const port = { postMessage: () => {} };
    (
      px.postMessage as unknown as (m: unknown, t?: unknown, tr?: unknown[]) => void
    )("m", "https://www.google.com", [port]);
    expect(f.childCalls).toHaveLength(1);
    expect(f.childCalls[0]).toEqual({
      m: "m",
      t: "https://engine.example",
      tr: [port],
      n: 3,
    });
  });

  it("caches the proxy: identity holds across reads", () => {
    const f = frameFixture("https://www.google.com");
    applyPostMessage(f.w);
    expect(getCw(f)).toBe(getCw(f));
  });

  it("drops a targetOrigin that does not match the child marker", () => {
    const f = frameFixture("https://www.google.com");
    applyPostMessage(f.w);
    const px = getCw(f) as Record<string, unknown>;
    (px.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      1,
      "https://wrong.example",
    );
    expect(f.childCalls).toHaveLength(0);
  });

  it("delivers while the child marker is pending (no drop race)", () => {
    const f = frameFixture(undefined);
    applyPostMessage(f.w);
    const px = getCw(f) as Record<string, unknown>;
    (px.postMessage as unknown as (m: unknown, t?: unknown) => void)(
      2,
      "https://www.google.com",
    );
    expect(f.childCalls).toHaveLength(1);
    expect(f.childCalls[0]!.t).toBe("https://engine.example");
  });

  it("keeps the raw window for a child without a stash", () => {
    const f = frameFixture("https://www.google.com");
    delete f.child.__zlNativePM;
    applyPostMessage(f.w);
    expect(getCw(f)).toBe(f.child);
  });

  it("normalizes the bare legacy port call on the child path", () => {
    const f = frameFixture("https://www.google.com");
    applyPostMessage(f.w);
    const px = getCw(f) as Record<string, unknown>;
    const port = { postMessage: () => {} };
    (px.postMessage as unknown as (m: unknown, p?: unknown[]) => void)("m", [port]);
    expect(f.childCalls[0]).toEqual({
      m: "m",
      t: "https://engine.example",
      tr: [port],
      n: 3,
    });
  });
});
