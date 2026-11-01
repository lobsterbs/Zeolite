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
  altRegister: () => {},
  altConfigured: () => false,
}));

/* #279: capture wsBridge.open destinations for the retarget tests. */
const wsOpenUrls = vi.hoisted(() => [] as string[]);
vi.mock("../ws-runtime", () => ({
  wsBridge: {
    open: (_port: unknown, url: string) => {
      wsOpenUrls.push(url);
    },
    closeAll: () => {},
  },
}));

/* #377: count page-cache clears; the rest of the request module
   surface stays real. */
const cacheClears = vi.hoisted(() => ({ count: 0 }));
vi.mock("../request", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../request")>();
  return {
    ...mod,
    pageCacheClear: async () => {
      cacheClears.count++;
    },
  };
});

import {
  CORE_CONTROL_TYPES,
  dispatchCore,
  handleControlEvent,
  messageListener,
  type ControlMessage,
} from "../control";
import { EXT_CONTROL_TYPES, dispatchExtControl } from "../extensions/control";
import { documentCookieRead, documentCookieWrite } from "../cookies";
import { DIAG } from "../diag";
import { netLogPush } from "../netlog";
import { parseKdl } from "../kdl";
import { experimentalSnapshot, resetExperimentalForTests } from "../experimental-flags";

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

  it("accepts only host-selected experimental preferences, and reports effective capabilities", async () => {
    resetExperimentalForTests();
    const selected = {
      adaptiveTransit: true, hybridLocation: true,
      cspTranslation: true, virtualSW: true,
    };
    const { ev, posted } = mkEvent("https://w.example.org/", {
      type: "zl:config", prefix: "/j/", experimental: selected,
    });
    await handleControlEvent(ev, deps);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      ok: true, experimental: { requested: selected,
        effective: { adaptiveTransit: false, hybridLocation: true,
          cspTranslation: true, virtualSW: false } },
    });
    const ping = mkEvent("https://w.example.org/j/token", { type: "zl:ping" });
    await handleControlEvent(ping.ev, deps);
    expect(ping.posted[0]).toMatchObject({
      ok: true, experimental: { requested: selected,
        effective: { cspTranslation: true, virtualSW: false } },
    });
    const bad = mkEvent("https://w.example.org/", {
      type: "zl:config", prefix: "/j/", experimental: { virtualSW: "true" },
    });
    await handleControlEvent(bad.ev, deps);
    expect(bad.posted[0]).toMatchObject({ ok: false, error: "unknown or non-boolean experimental flag" });
    expect(experimentalSnapshot().requested).toEqual(selected);
    resetExperimentalForTests();
  });

  it("refuses proxied attempts to enable an experimental feature", async () => {
    resetExperimentalForTests();
    const { ev, posted } = mkEvent("https://w.example.org/j/abc", {
      type: "zl:config", experimental: { virtualSW: true },
    });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: false, error: "host-only control message" }]);
    expect(experimentalSnapshot().requested.virtualSW).toBe(false);
  });

  it("rejects zl:doctor from proxied pages before examining boot state", async () => {
    const stalled = new Promise(() => {});
    const { ev, posted } = mkEvent("https://w.example.org/j/abc", { type: "zl:doctor" });
    await handleControlEvent(ev, { ready: stalled, persistRoute: () => { throw new Error("must not write"); } });
    expect(posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });

  it("doctor proves selected proxied client control and fails closed for stale/host clients", async () => {
    const get = vi.fn(async (id: string) => {
      if (id === "live") return { id, url: "https://w.example.org/j/abc" };
      if (id === "host") return { id, url: "https://w.example.org/" };
      return undefined;
    });
    vi.stubGlobal("self", {
      location: { origin: "https://w.example.org", href: "https://w.example.org/sw.js" },
      registration: { scope: "https://w.example.org/" },
      clients: { get },
    });
    for (const [clientId, expected] of [
      ["live", "pass"],
      ["gone", "fail"],
      ["host", "fail"],
    ] as const) {
      const { ev, posted } = mkEvent("https://w.example.org/", {
        type: "zl:doctor", clientId,
      });
      await handleControlEvent(ev, deps);
      const report = posted[0] as { checks: Array<{code: string; status: string}> };
      expect(report.checks.find(c => c.code === "worker.client-control")?.status).toBe(expected);
    }
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("doctor reports client verification unknown when browser client enumeration fails", async () => {
    vi.stubGlobal("self", {
      location: { origin: "https://w.example.org", href: "https://w.example.org/sw.js" },
      registration: { scope: "https://w.example.org/" },
      clients: { get: async () => { throw new Error("browser API unavailable"); } },
    });
    const { ev, posted } = mkEvent("https://w.example.org/", {
      type: "zl:doctor", clientId: "live",
    });
    await handleControlEvent(ev, deps);
    const report = posted[0] as { checks: Array<{code: string; status: string}> };
    expect(report.checks.find(c => c.code === "worker.client-control")?.status).toBe("unknown");
  });

  it("permits zl:doctor to return a bounded passive, redacted report without extra fetching", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const { ev, posted } = mkEvent("https://w.example.org/", {
      type: "zl:doctor", expectedVersion: "wrong version", format: "kdl",
    });
    await handleControlEvent(ev, { ready: Promise.resolve(), persistRoute: () => { throw new Error("must not write"); } });
    expect(posted).toHaveLength(1);
    const report = posted[0] as { ok: boolean; healthy: boolean | null; checks: Array<{code: string; status: string}>; kdl: string };
    expect(report.ok).toBe(true);
    expect(report.healthy).toBe(false); // version mismatch is proven
    expect(report.checks.find(c => c.code === "bundle.version")?.status).toBe("fail");
    expect(report.checks.find(c => c.code === "assets.bootstrap")?.status).toBe("skipped");
    expect(report.checks.find(c => c.code === "worker.client-control")?.status).toBe("unknown");
    expect(report.kdl).toContain('zeolite-doctor version=1');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });

  it("doctor reports failed boot rather than hanging behind the normal control-plane gate", async () => {
    const { ev, posted } = mkEvent("https://w.example.org/", { type: "zl:doctor" });
    await handleControlEvent(ev, {
      ready: Promise.reject(new Error("private credential password=do-not-export")),
      persistRoute: () => { throw new Error("must not write"); },
    });
    expect(posted).toHaveLength(1);
    const report = posted[0] as { ok: boolean; healthy: boolean | null; checks: Array<{code: string; status: string}> };
    expect(report.ok).toBe(true);
    expect(report.healthy).toBe(false);
    expect(report.checks.find(c => c.code === "worker.boot")?.status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("do-not-export");
  });

  it("exports only a worker-verified proxied client request, never worker-global diagnostics", async () => {
    const traceId = DIAG.trace("page-one");
    DIAG.stage(traceId, "REQUEST_INTERCEPTED");
    netLogPush({
      traceId, method: "GET", path: "/j/secret", dest: "https://private.example/?token=SHOULD-NOT-LEAK",
      rtype: "DOCUMENT", status: 200, ms: 12, bytes: 48, transport: "RewriteFallback",
    });
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" },
      clients: { get: vi.fn(async (id: string) =>
        id === "page-one" ? { id, url: "https://w.example.org/j/abc" } : null) },
    });
    const { ev, posted } = mkEvent("https://w.example.org/", {
      type: "zl:exportDiagnostics", clientId: "page-one", traceId,
    });
    await handleControlEvent(ev, { ready: new Promise(() => {}), persistRoute: () => { throw Error("no mutations"); } });
    expect(posted).toHaveLength(1);
    const report = posted[0] as { ok: boolean; scope: string; steps: unknown[]; kdl: string };
    expect(report.ok).toBe(true);
    expect(report.scope).toBe("request");
    expect(report.steps).toHaveLength(2);
    expect(parseKdl(report.kdl)[0].children).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("SHOULD-NOT-LEAK");
    expect(JSON.stringify(report)).not.toContain("private.example");
    expect(JSON.stringify(report)).not.toContain("page-one");
  });

  it("refuses exported traces with missing, unrelated, or navigated-away client IDs", async () => {
    const traceId = DIAG.trace("page-one");
    const probe = vi.fn(async (id: string) => ({
      id, url: "https://w.example.org/index.html",
    }));
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" }, clients: { get: probe } });
    const messages: ControlMessage[] = [
      { type: "zl:exportDiagnostics", clientId: "another-client", traceId },
      { type: "zl:exportDiagnostics", clientId: "page-one" },
      { type: "zl:exportDiagnostics", clientId: "page-one", traceId },
    ];
    for (const msg of messages) {
      const { ev, posted } = mkEvent("https://w.example.org/", msg);
      await handleControlEvent(ev, { ready: new Promise(() => {}), persistRoute: () => { throw Error("no mutations"); } });
      expect(posted).toEqual([{ ok: false, status: "identity-unavailable" }]);
    }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("failed client enumeration refuses export without disclosing worker-global events", async () => {
    const traceId = DIAG.trace("page-one");
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" },
      clients: { get: async () => { throw Error("client gone"); } },
    });
    const { ev, posted } = mkEvent("https://w.example.org/", {
      type: "zl:exportDiagnostics", clientId: "page-one", traceId,
    });
    await handleControlEvent(ev, { ready: new Promise(() => {}), persistRoute: () => {} });
    expect(posted).toEqual([{ ok: false, status: "identity-unavailable" }]);
  });

  it("blocks proxied pages from exporting another site's ring even if trace ID is known", async () => {
    const traceId = DIAG.trace("page-one");
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" }, clients: {
      get: () => { throw Error("must reject before client lookup"); },
    } });
    const { ev, posted } = mkEvent("https://w.example.org/j/abc", {
      type: "zl:exportDiagnostics", clientId: "page-one", traceId,
    });
    await handleControlEvent(ev, { ready: new Promise(() => {}), persistRoute: () => { throw Error("no mutations"); } });
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

  it("clears the page cache when the fingerprint profile or the UA changes (#377)", async () => {
    cacheClears.count = 0;
    const { reply } = mkReplies();
    const ctx = {
      e: {} as ExtendableMessageEvent,
      reply,
      port: {},
      persistRoute: async () => {},
    };
    await dispatchCore(
      { type: "zl:fingerprint", profile: { persona: "a" } } as unknown as ControlMessage,
      ctx,
    );
    expect(cacheClears.count).toBe(1); /* null -> profile: persona change */
    await dispatchCore(
      { type: "zl:fingerprint", profile: { persona: "a" } } as unknown as ControlMessage,
      ctx,
    );
    expect(cacheClears.count).toBe(1); /* same profile: no clear */
    await dispatchCore({ type: "zl:rules", rules: [], ua: "UA/1" } as unknown as ControlMessage, ctx);
    expect(cacheClears.count).toBe(2); /* UA change */
    await dispatchCore({ type: "zl:rules", rules: [], ua: "UA/1" } as unknown as ControlMessage, ctx);
    expect(cacheClears.count).toBe(2); /* same UA: no clear */
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

describe("zl:getVirtualOrigin (#130)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a proxied page with its own route's origin", async () => {
    const { ev, posted } = mkEvent(
      "https://w.example.org/j/aHR0cHM6Ly93d3cuZ29vZ2xlLmNvbQ",
      { type: "zl:getVirtualOrigin" },
    );
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: true, vo: "https://www.google.com" }]);
  });

  it("fails closed for an undecodable route", async () => {
    const { ev, posted } = mkEvent("https://w.example.org/j/abc", {
      type: "zl:getVirtualOrigin",
    });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: true, vo: null }]);
  });
});

describe("zl:config imageLazy toggle (lazy images host push)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets and echoes the live value", async () => {
    const on = mkEvent("https://w.example.org/", { type: "zl:config", prefix: "/j/", imageLazy: true });
    await handleControlEvent(on.ev, deps);
    const rOn = on.posted[0] as { ok: boolean; imageLazy?: boolean };
    expect(rOn.ok).toBe(true);
    expect(rOn.imageLazy).toBe(true);
    const off = mkEvent("https://w.example.org/", { type: "zl:config", prefix: "/j/", imageLazy: false });
    await handleControlEvent(off.ev, deps);
    const rOff = off.posted[0] as { ok: boolean; imageLazy?: boolean };
    expect(rOff.imageLazy).toBe(false);
  });

  it("keeps the live choice when the field is absent", async () => {
    const set = mkEvent("https://w.example.org/", { type: "zl:config", prefix: "/j/", imageLazy: true });
    await handleControlEvent(set.ev, deps);
    const probe = mkEvent("https://w.example.org/", { type: "zl:config", prefix: "/j/" });
    await handleControlEvent(probe.ev, deps);
    const r = probe.posted[0] as { ok: boolean; imageLazy?: boolean };
    expect(r.imageLazy).toBe(true);
  });
});

import { loadEnter, loadLeave, loadResetForTests } from "../loadstate";

describe("zl:loadState dispatch (loading indicator)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
    loadResetForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    loadResetForTests();
  });

  it("reports the per-host in-flight count and stream count", async () => {
    const { replies, reply } = mkReplies();
    loadEnter("https://a.example.org/x");
    loadEnter("https://a.example.org/y");
    loadEnter("https://b.example.org/z");
    await dispatchCore({ type: "zl:loadState", host: "a.example.org" } as unknown as ControlMessage, {
      e: {} as ExtendableMessageEvent,
      reply,
      port: {},
      persistRoute: async () => {},
    });
    expect(replies).toEqual([{ ok: true, inflight: 2, streams: 0 }]);
    loadLeave("https://a.example.org/x");
    loadLeave("https://a.example.org/y");
    loadLeave("https://b.example.org/z");
  });

  it("answers the global count when no host is given", async () => {
    const { replies, reply } = mkReplies();
    loadEnter("https://a.example.org/x");
    await dispatchCore({ type: "zl:loadState" } as unknown as ControlMessage, {
      e: {} as ExtendableMessageEvent,
      reply,
      port: {},
      persistRoute: async () => {},
    });
    expect(replies).toEqual([{ ok: true, inflight: 1, streams: 0 }]);
    loadLeave("https://a.example.org/x");
  });

  it("refuses a proxied-page sender (host-only gate)", async () => {
    const { ev, posted } = mkEvent("https://w.example.org/j/abc", { type: "zl:loadState" });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });
});

describe("zl:wispRegister persists the route shape (#168 idle-kill)", () => {
  it("registers the endpoint and persists the current route", async () => {
    const { replies, reply } = mkReplies();
    const persist = vi.fn();
    await dispatchCore({ type: "zl:wispRegister", url: "wss://public.example/" } as unknown as ControlMessage, {
      e: {} as ExtendableMessageEvent,
      reply,
      port: {},
      persistRoute: persist,
    });
    expect(replies).toEqual([{ ok: true }]);
    expect(persist).toHaveBeenCalledWith("/j/");
  });

  it("a withdraw persists too; a bad url neither registers nor persists", async () => {
    const persist = vi.fn();
    const { replies, reply } = mkReplies();
    await dispatchCore({ type: "zl:wispRegister", url: "" } as unknown as ControlMessage, {
      e: {} as ExtendableMessageEvent,
      reply,
      port: {},
      persistRoute: persist,
    });
    expect(replies).toEqual([{ ok: true }]);
    expect(persist).toHaveBeenCalledTimes(1);
    const bad = mkReplies();
    await dispatchCore({ type: "zl:wispRegister", url: "https://nope.example/" } as unknown as ControlMessage, {
      e: {} as ExtendableMessageEvent,
      reply: bad.reply,
      port: {},
      persistRoute: persist,
    });
    expect(bad.replies).toEqual([{ ok: false, error: "wisp registration needs a ws(s):// url or an empty string" }]);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("messageListener lifecycle (#250)", () => {
  function fakeEvent(waitUntil: ReturnType<typeof vi.fn>) {
    const posted: unknown[] = [];
    const port = { postMessage: (m: unknown) => posted.push(m) };
    const e = {
      data: { type: "zl:getNetLog" },
      ports: [port],
      source: null,
      waitUntil,
    };
    return { e, posted };
  }

  it("keeps the message event alive for the whole handler, not just the listener call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const waitUntil = vi.fn();
    const { e } = fakeEvent(waitUntil);
    messageListener({ ready: gate, persistRoute: () => {} })(e as unknown as ExtendableMessageEvent);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const held = waitUntil.mock.calls[0][0] as Promise<unknown>;
    release();
    await held;
  });

  it("a failed handler answers a structured error and never rejects the event promise", async () => {
    const waitUntil = vi.fn();
    const { e, posted } = fakeEvent(waitUntil);
    messageListener({
      ready: Promise.reject(new Error("boot wedge")),
      persistRoute: () => {},
    })(e as unknown as ExtendableMessageEvent);
    const held = waitUntil.mock.calls[0][0] as Promise<unknown>;
    await expect(held).resolves.toBeUndefined();
    expect(posted[0]).toMatchObject({ ok: false, error: "control handler failed" });
  });
});

describe("zl:wsOpen engine-local retarget (#279)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org", host: "w.example.org" } });
    wsOpenUrls.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retargets an engine-host ws URL through the sender decoded route", async () => {
    const minted = mkEvent("https://w.example.org/", { type: "zl:mint", dest: "https://target.example.org/" });
    await handleControlEvent(minted.ev, deps);
    const route = (minted.posted[0] as { ok: boolean; route: string }).route;
    wsOpenUrls.length = 0;
    const { ev, posted } = mkEvent("https://w.example.org" + route, {
      type: "zl:wsOpen",
      url: "wss://w.example.org/socket",
      protocols: [],
    });
    await handleControlEvent(ev, deps);
    expect(wsOpenUrls).toEqual(["wss://target.example.org/socket"]);
    expect(posted).toEqual([]);
  });

  it("passes a cross-origin ws URL through unchanged", async () => {
    const { ev } = mkEvent("https://w.example.org/", {
      type: "zl:wsOpen",
      url: "wss://other.example/chat",
      protocols: [],
    });
    await handleControlEvent(ev, deps);
    expect(wsOpenUrls).toEqual(["wss://other.example/chat"]);
  });
});
