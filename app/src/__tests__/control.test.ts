import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The control plane moved out of sw.ts (issues #85, #90, #91): sw.ts's
   module body registers the service worker, so vitest cannot import it;
   the dispatchers now live in import-safe modules. These tests pin the
   move: the registries against their dispatchers (the dispatch and the
   registry can never drift apart), the host-only sender gate the wiring
   relies on, and the two dispatch seams. The transport seam is mocked
   to the engine name it reports in production: the vendored libcurl
   bundle is a browser/wasm artifact, and these tests exercise dispatch,
   not transport. */

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: { ready: async () => {} },
}));

import {
  CORE_CONTROL_TYPES,
  dispatchCore,
  handleControlEvent,
  type ControlMessage,
} from "../control";
import { EXT_CONTROL_TYPES, dispatchExtControl } from "../extensions/control";
import { documentCookieRead, documentCookieWrite } from "../cookies";

/* Derives the case labels from the dispatcher's own source, the way the
   wiring sees it after vitest's transform (unminified). */
const labelsOf = (fn: (...args: any[]) => unknown): string[] =>
  [...`${fn}`.matchAll(/case "(zl:[^"]+)":/g)].map((m) => m[1]);

const mkReplies = () => {
  const replies: unknown[] = [];
  return { replies, reply: (payload: unknown) => replies.push(payload) };
};

const mkEvent = (sourceUrl: string, msg: ControlMessage) => {
  const posted: unknown[] = [];
  const ev = {
    data: msg,
    ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
    source: { url: sourceUrl, id: "c1" },
  } as unknown as ExtendableMessageEvent;
  return { ev, posted };
};

const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

describe("control-plane registries (#90)", () => {
  it("the core registry matches the labels dispatchCore handles", () => {
    expect([...CORE_CONTROL_TYPES].sort()).toEqual([...new Set(labelsOf(dispatchCore))].sort());
  });

  it("the extension registry matches the labels dispatchExtControl handles", () => {
    expect([...EXT_CONTROL_TYPES].sort()).toEqual([...new Set(labelsOf(dispatchExtControl))].sort());
  });

  it("core and extension registries are disjoint", () => {
    for (const t of CORE_CONTROL_TYPES) expect(EXT_CONTROL_TYPES.has(t)).toBe(false);
    for (const t of EXT_CONTROL_TYPES) expect(CORE_CONTROL_TYPES.has(t)).toBe(false);
  });
});

describe("sender gate preserved by the extraction (#41/#48)", () => {
  beforeEach(() => {
    /* senderIsProxiedPage resolves the sender URL against
       self.location.origin; node has no self, so stand in for the
       worker global the gate reads. */
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a host-only message from a proxied page", async () => {
    const { ev, posted } = mkEvent("https://w.example.org/j/abc", { type: "zl:config", prefix: "/k/" });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });

  it("serves a host sender", async () => {
    const { ev, posted } = mkEvent("https://w.example.org/", {
      type: "zl:mint",
      dest: "https://target.example.org/",
    });
    await handleControlEvent(ev, deps);
    expect(posted.length).toBe(1);
    const r = posted[0] as { ok: boolean; route?: unknown };
    expect(r.ok).toBe(true);
    expect(typeof r.route).toBe("string");
  });

  it("admits zl:mint from a proxied page (#54 residual 1)", async () => {
    const { ev, posted } = mkEvent("https://w.example.org/j/abc", {
      type: "zl:mint",
      dest: "https://target.example.org/",
    });
    await handleControlEvent(ev, deps);
    expect(posted.length).toBe(1);
    expect((posted[0] as { ok: boolean }).ok).toBe(true);
  });
});

describe("dispatch seams", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatchCore answers an unknown type honestly", async () => {
    const { replies, reply } = mkReplies();
    await dispatchCore({ type: "zl:nope" } as unknown as ControlMessage, {
      e: {} as ExtendableMessageEvent,
      reply,
      port: {},
      persistRoute: async () => {},
    });
    expect(replies).toEqual([{ ok: false, error: "unknown message" }]);
  });

  it("dispatchExtControl serves zl:listExt with the installed summary", async () => {
    const { replies, reply } = mkReplies();
    await dispatchExtControl({ type: "zl:listExt" } as ControlMessage, {
      e: {} as ExtendableMessageEvent,
      reply,
    });
    expect(replies.length).toBe(1);
    const r = replies[0] as { ok: boolean; extensions: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.extensions).toEqual([]);
  });
});

describe("zl:teardown clears engine state (#87)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", {
      location: { origin: "https://w.example.org" },
      registration: { unregister: async () => undefined },
    });
    vi.stubGlobal("caches", { keys: async () => ["c1"], delete: async () => true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears the jar, drops the caches, and unregisters the worker", async () => {
    documentCookieWrite("https://x.example/", "a=1");
    expect(documentCookieRead("https://x.example/")).toContain("a=1");
    const { ev, posted } = mkEvent("https://w.example.org/", { type: "zl:teardown" });
    const waits: Promise<unknown>[] = [];
    (ev as unknown as { waitUntil: (p: Promise<unknown>) => void }).waitUntil = (p) => {
      waits.push(p);
    };
    await handleControlEvent(ev, deps);
    for (const p of waits) await p;
    expect(posted).toContainEqual({ ok: true });
    /* 1.4 Boride: cookies do not survive an engine switch - the jar
       the teardown cleared is the same one document.cookie reads. */
    expect(documentCookieRead("https://x.example/")).toBe("");
  });
});
