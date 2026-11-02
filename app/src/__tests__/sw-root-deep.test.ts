import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Deep composition-root torture: the REAL wiring under a stubbed
   worker world.

   Companion to sw-torture.test.ts, which drives the entrypoint with
   the heavy leaves (request, control, cookies, transport) MOCKED so
   the wiring can be fault-injected per seam. This file is the
   opposite cut: only the transport is mocked (the vendored libcurl
   bundle is a browser/wasm artifact), and the REAL sw.ts, request.ts
   handleFetch, control plane, cookies jar and transform prelude run
   underneath - because the failure class that survives the mocked
   suite is the one living in the composition itself:

   - never-rejecting respondWith: every branch of handleFetch that
     arms respondWith must settle to a Response the browser can
     serve. A rejected respondWith is a hard net::ERR_FAILED for the
     page - no error page, no diagnostic, nothing.
   - worker-script prelude hygiene: the prelude asset cache must
     never poison itself with a non-2xx body.
   - arming guarantee: every request that is engine work gets
     respondWith armed synchronously and exactly once; the classes
     that are deliberately browser-owned stay unarmed.
   - lifecycle blast radius and the control plane, re-pinned through
     the real modules instead of mock fakes.

   Layer 3 of the methodology (cookies-torture.test.ts): a seeded LCG
   fuzz over hostile URL/request space where every deviation from the
   two invariants is a finding, and any UNCLASSIFIED deviation fails
   the suite.

   The rewriter wasm resolves through the vite config's throwing
   stub, which is exactly the degradation the entrypoint must
   survive (boot-wedge.test.ts pins the containment). */

/* ---- transport mock (full surface used by sw/request/control) ---- */
const transportSpy = vi.hoisted(() => ({ readyCalls: 0, fetchCalls: 0 }));

vi.mock("../transport", () => ({
  /* The complete export surface of ./transport, mocked benignly: the
     vendored libcurl bundle is a browser/wasm artifact. */
  currentEngine: () => "libcurl",
  openWebSocket: () => {
    throw new Error("torture: no transport socket");
  },
  altRegister: () => undefined,
  altConfigured: () => false,
  altEndpoint: () => null,
  initTransport: () => undefined,
  setPrimaryWisp: () => true,
  engineReady: async () => undefined,
  parseTtfbDeadline: () => undefined,
  transportResetForTests: () => undefined,
  wispCoolingForTests: () => false,
  canReplayAfterFailure: () => false,
  wispTransport: {
    ready: async () => {
      transportSpy.readyCalls++;
    },
    fetch: async () => {
      transportSpy.fetchCalls++;
      return new Response("<html><body>up</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    switchEngine: () => undefined,
  },
  altWispFetch: async () => new Response("up"),
}));

/* ---- the stubbed worker world ------------------------------------ */
const ORIGIN = "https://engine.test";

const workerWorld = vi.hoisted(() => {
  return {
    listeners: new Map<string, Array<(e: unknown) => void>>(),
    clientsById: new Map<string, { url: string; id: string }>(),
    windows: [] as Array<{ url: string; id: string; messages: unknown[] }>,
    registrationUpdateCalls: 0,
    intervals: Array.of<() => void>(),
    claimError: null as Error | null,
  };
});

const selfStub = {
  location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
  addEventListener(type: string, fn: (e: unknown) => void) {
    const arr = workerWorld.listeners.get(type) ?? [];
    arr.push(fn);
    workerWorld.listeners.set(type, arr);
  },
  registration: {
    addEventListener: () => undefined,
    update: async () => {
      workerWorld.registrationUpdateCalls++;
    },
    active: { scriptURL: ORIGIN + "/sw.js" },
    scope: ORIGIN + "/",
  },
  skipWaiting: async () => undefined,
  clients: {
    matchAll: async (opts?: { type?: string }) => {
      if (opts?.type === "window") return workerWorld.windows;
      return [...workerWorld.clientsById.values()];
    },
    get: async (id: string) => workerWorld.clientsById.get(id) ?? null,
    claim: async () => {
      if (workerWorld.claimError) throw workerWorld.claimError;
      return [...workerWorld.clientsById.values()];
    },
  },
};

vi.stubGlobal("self", selfStub);
vi.stubGlobal(
  "caches",
  {
    open: async () => ({
      match: async () => undefined,
      put: async () => undefined,
      delete: async () => true,
      keys: async () => [],
    }),
    delete: async () => true,
    keys: async () => [],
  },
);
/* The update poll must not leave a live 5-minute interval in the
   test process. */
vi.stubGlobal("setInterval", (fn: () => void) => {
  workerWorld.intervals.push(fn);
  return workerWorld.intervals.length;
});

/* The mutable global fetch impl: engineSha (activate broadcast), the
   worker-prelude asset fetch, host passthrough arms and the ghostery
   list fetch all ride it. Per-test swap, never a live network. */
const fetchState = vi.hoisted(() => ({ impl: null as null | ((...a: unknown[]) => unknown) }));
vi.stubGlobal("fetch", (...a: unknown[]) => {
  const impl =
    fetchState.impl ??
    (async () => new Response("console.log('sw');", { status: 200, headers: { "content-type": "text/javascript" } }));
  return (impl as (...a: unknown[]) => unknown)(...a);
});

import { handleFetch } from "../request";
import { workerPrelude } from "../transform";
import * as cookiesMod from "../cookies";

import { b64uEncode, setRouteKey, setScheme } from "../codec";
/* A hand-rolled request stub for the branches that only read
   url/method/destination/headers before answering (the opaque-scheme
   arms): undici's Request constructor rejects blob:/about: URLs, but
   a real browser fetch event carries them. */
const stubRequest = (url: string, opts: { destination?: string; method?: string } = {}): Request =>
  ({
    url,
    method: opts.method ?? "GET",
    destination: opts.destination ?? "",
    mode: "cors",
    headers: new Headers(),
    referrer: "about:client",
    signal: new AbortController().signal,
  }) as unknown as Request;

/* The composition root itself - imported once, after the worker
   world exists, exactly the way a real worker evaluates it. */
const sw = await import("../sw");

const listener = (type: string): ((e: unknown) => void) => {
  const arr = workerWorld.listeners.get(type);
  if (!arr || arr.length !== 1) throw new Error("expected exactly one " + type + " listener, got " + (arr?.length ?? 0));
  return arr[0]!;
};

/* ---- event stubs -------------------------------------------------- */
interface FiredFetch {
  armed: Promise<Response>[];
  held: Promise<unknown>[];
  fire(): void;
}

const fireFetch = (req: Request, extra: Record<string, unknown> = {}): FiredFetch => {
  const armed: Promise<Response>[] = [];
  const held: Promise<unknown>[] = [];
  const ev = {
    request: req,
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: (p: Promise<unknown>) => void held.push(p),
    clientId: "",
    resultingClientId: "",
    replacesClientId: "",
    ...extra,
  };
  return {
    armed,
    held,
    fire: () => listener("fetch")(ev),
  };
};

const fireMessage = (
  data: unknown,
  opts: { senderUrl?: string; ports?: unknown[] } = {},
): { replies: unknown[]; held: Promise<unknown>[] } => {
  const replies: unknown[] = [];
  const held: Promise<unknown>[] = [];
  const port = { postMessage: (m: unknown) => void replies.push(m) };
  const ev = {
    data,
    ports: opts.ports ?? [port],
    source: opts.senderUrl === undefined ? null : { url: opts.senderUrl, id: "sender-1" },
    waitUntil: (p: Promise<unknown>) => void held.push(p),
    lastEventId: "",
    origin: ORIGIN,
  };
  listener("message")(ev);
  return { replies, held };
};

const drain = async (ps: Promise<unknown>[], ms = 4000): Promise<PromiseSettledResult<unknown>[]> => {
  const all = Promise.allSettled(ps);
  const t = new Promise<PromiseSettledResult<unknown>[]>((r) => setTimeout(() => r([]), ms));
  const res = await Promise.race([all, t]);
  if (res.length === 0 && ps.length > 0) throw new Error("held promise(s) never settled within " + ms + "ms");
  return res;
};

const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(KEY);
  workerWorld.clientsById.clear();
  workerWorld.windows = [];
  workerWorld.claimError = null;
  fetchState.impl = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ==================================================================
   A. Import-time wiring of the real composition root
   ================================================================== */
describe("composition root wiring (real sw.ts import)", () => {
  it("registers exactly one install/activate/fetch/message listener each", () => {
    for (const t of ["install", "activate", "fetch", "message"]) {
      expect(workerWorld.listeners.get(t)?.length).toBe(1);
    }
  });

  it("the update poll ran once at module evaluation and left no live interval", () => {
    expect(workerWorld.registrationUpdateCalls).toBe(1);
    expect(workerWorld.intervals.length).toBe(1);
  });
});

/* ==================================================================
   B. Activate composition: every step is best-effort
   ================================================================== */
describe("activate composition", () => {
  const mkActivate = (): { held: Promise<unknown>[] } => {
    const held: Promise<unknown>[] = [];
    listener("activate")({ waitUntil: (p: Promise<unknown>) => void held.push(p) });
    return { held };
  };

  it("claims, broadcasts the engine update to window clients, then warms the transport", async () => {
    transportSpy.readyCalls = 0;
    const messages: unknown[] = [];
    const win = { url: ORIGIN + "/", id: "w1", messages, postMessage: (m: unknown) => void messages.push(m) };
    workerWorld.windows = [win as never];
    const { held } = mkActivate();
    await drain(held);
    /* broadcast: engineSha fetches the worker script (stubbed fetch),
       then posts zl:engineUpdate to every window client */
    expect(messages.length).toBe(1);
    expect((messages[0] as { type?: string }).type).toBe("zl:engineUpdate");
    expect(transportSpy.readyCalls).toBe(1);
  });

  it("a claim rejection does not skip the broadcast or the transport warm (blast radius)", async () => {
    transportSpy.readyCalls = 0;
    workerWorld.claimError = new Error("registration replaced mid-claim");
    const messages: unknown[] = [];
    const win = { url: ORIGIN + "/", id: "w2", messages, postMessage: (m: unknown) => void messages.push(m) };
    workerWorld.windows = [win as never];
    const { held } = mkActivate();
    await drain(held);
    expect(messages.length).toBe(1);
    expect(transportSpy.readyCalls).toBe(1);
  });

  it("a broadcast rejection does not skip the transport warm", async () => {
    transportSpy.readyCalls = 0;
    fetchState.impl = async () => {
      throw new Error("sw.js unreachable");
    };
    const { held } = mkActivate();
    await drain(held);
    expect(transportSpy.readyCalls).toBe(1);
  });
});

/* ==================================================================
   C. Install composition: the real prewarm settles, never fails
   ================================================================== */
describe("install composition", () => {
  it("skipWaiting stays and the real (throwing wasm stub) prewarm settles to undefined", async () => {
    const held: Promise<unknown>[] = [];
    const skip = vi.fn(async () => undefined);
    const selfWithSkip = { ...selfStub, skipWaiting: skip };
    const origSelf = globalThis.self;
    vi.stubGlobal("self", selfWithSkip);
    try {
      listener("install")({ waitUntil: (p: Promise<unknown>) => void held.push(p) });
      expect(skip).toHaveBeenCalledTimes(1);
      expect(held.length).toBe(1);
      await drain(held);
      await expect(held[0]).resolves.toBeUndefined();
    } finally {
      vi.stubGlobal("self", origSelf);
    }
  });
});

/* ==================================================================
   D2. Honest failure for the worker-script branches
   ================================================================== */
describe("worker script branches answer honestly instead of rejecting", () => {
  it("/zl-bw/ with a failing prelude asset answers a Response, never a rejection", async () => {
    /* runs before the battery warmed the prelude cache: the asset
       fetch itself fails, which used to reject the respondWith promise */
    fetchState.impl = async () => {
      throw new Error("asset store unreachable");
    };
    const f = fireFetch(new Request(zlBwUrl()));
    f.fire();
    expect(f.armed.length).toBe(1);
    const resp = await f.armed[0];
    expect(resp).toBeInstanceOf(Response);
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });

  it("a blob: worker script whose own fetch fails answers a Response, never a rejection", async () => {
    fetchState.impl = async () => {
      throw new Error("blob store gone");
    };
    const f = fireFetch(stubRequest("blob:" + ORIGIN + "/worker-2", { destination: "worker" }));
    f.fire();
    expect(f.armed.length).toBe(1);
    const resp = await f.armed[0];
    expect(resp).toBeInstanceOf(Response);
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });
});

/* ==================================================================
   D3. Worker prelude hygiene (runs AFTER the failure pins: the module-level
   prelude cache is process state, and the success case warms it)
   ================================================================== */
describe("workerPrelude asset hygiene", () => {
  it("a non-2xx asset body is never cached as the prelude; the next call retries", async () => {
    let calls = 0;
    fetchState.impl = async () => {
      calls++;
      return new Response("<html>404 page</html>", { status: 404 });
    };
    await expect(workerPrelude()).rejects.toThrow();
    expect(calls).toBe(1);
    fetchState.impl = async () => {
      calls++;
      return new Response("PRELUDE-OK", { status: 200, headers: { "content-type": "text/javascript" } });
    };
    await expect(workerPrelude()).resolves.toBe("PRELUDE-OK");
    await expect(workerPrelude()).resolves.toBe("PRELUDE-OK");
    expect(calls).toBe(2); /* cached only on success */
  });
});

/* ==================================================================
   D. The respondWith funnel: every engine response rides withCorp
   ================================================================== */
describe("respondWith funnel (withCorp at the composition root)", () => {
  it("a foreign host-traffic passthrough gains CORP and keeps its body", async () => {
    fetchState.impl = async () =>
      new Response("host asset", { status: 200, headers: { "content-type": "text/plain" } });
    const f = fireFetch(new Request("https://other.example/asset.txt"));
    f.fire();
    expect(f.armed.length).toBe(1);
    const resp = await f.armed[0];
    expect(resp.status).toBe(200);
    expect(resp.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    await expect(resp.text()).resolves.toBe("host asset");
  });

  it("a redirect passthrough keeps its Location and gains CORP", async () => {
    fetchState.impl = async () =>
      new Response(null, { status: 302, headers: { location: "https://other.example/next" } });
    const f = fireFetch(new Request("https://other.example/jump"));
    f.fire();
    const resp = await f.armed[0];
    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe("https://other.example/next");
    expect(resp.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("a streamed passthrough body survives the funnel intact (re-wrap, not tee)", async () => {
    fetchState.impl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("str"));
            c.enqueue(new TextEncoder().encode("eam"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    const f = fireFetch(new Request("https://other.example/stream"));
    f.fire();
    const resp = await f.armed[0];
    expect(resp.body).not.toBeNull();
    await expect(resp.text()).resolves.toBe("stream");
    expect(resp.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("the proxy forwards waitUntil: the ghostery hold extends the real event", async () => {
    fetchState.impl = async () => new Response("x", { headers: { "content-type": "text/plain" } });
    const f = fireFetch(new Request("https://other.example/x"));
    f.fire();
    await f.armed[0];
    await drain(f.held);
    expect(f.held.length).toBeGreaterThanOrEqual(1);
  });

  it("a passthrough of Response.error() stays the native object (no CORP on errors)", async () => {
    fetchState.impl = async () => Response.error();
    const f = fireFetch(new Request("https://other.example/err"));
    f.fire();
    const resp = await f.armed[0];
    expect(resp.type).toBe("error");
    expect(resp.headers.get("cross-origin-resource-policy")).toBeNull();
  });
});

/* ==================================================================
   E. The message plane: the real wiring answers everything
   ================================================================== */
describe("control plane through the composition root", () => {
  it("zl:ping from a host page answers the live shape", async () => {
    const { replies, held } = fireMessage({ type: "zl:ping" }, { senderUrl: ORIGIN + "/" });
    await drain(held);
    const r = replies[0] as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(typeof r.version).toBe("string");
    expect(r.scheme).toBe("b64u");
    expect(typeof r.prefix).toBe("string");
  });

  it("a host-only message from a proxied (NAVH) sender is refused", async () => {
    const navh = ORIGIN + "/__zl_navh__/AAAAgarbageAAAA";
    const { replies, held } = fireMessage({ type: "zl:getJars" }, { senderUrl: navh });
    await drain(held);
    expect(replies[0]).toMatchObject({ ok: false, error: "host-only control message" });
  });

  it("garbage payloads settle the event without crashing the plane", async () => {
    const payloads: unknown[] = [null, 42, "a string", {}, { type: 123 as unknown as string }, { type: "" }, { type: "zl:unknownShape" }];
    for (const data of payloads) {
      const { held } = fireMessage(data, { senderUrl: ORIGIN + "/" });
      const settled = await drain(held);
      /* every event resolved (the #250 catch keeps rejections from
         surfacing) */
      for (const s of settled) expect(s.status).toBe("fulfilled");
    }
  });

  it("a handler failure is answered with the structured error (#250)", async () => {
    const spy = vi.spyOn(cookiesMod, "jarEnumeration").mockImplementation(() => {
      throw new Error("torture: jar ring broken");
    });
    const { replies, held } = fireMessage({ type: "zl:getJars" }, { senderUrl: ORIGIN + "/" });
    let settled: PromiseSettledResult<unknown>[] = [];
    try {
      settled = await drain(held);
    } finally {
      spy.mockRestore();
    }
    expect(replies[0]).toMatchObject({ ok: false, error: "control handler failed" });
    for (const s of settled) expect(s.status).toBe("fulfilled");
  });

  it("an empty ports array never crashes the reply seam", async () => {
    const { held } = fireMessage({ type: "zl:ping" }, { senderUrl: ORIGIN + "/", ports: [] });
    const settled = await drain(held);
    for (const s of settled) expect(s.status).toBe("fulfilled");
  });
});

/* ==================================================================
   E2. The orchestration body never arms a rejected respondWith
   ================================================================== */
describe("orchestration failure answers honestly (outer catch)", () => {
  it("a rejected boot gate lands as the engine's honest 502, never net::ERR_FAILED", async () => {
    const spy = vi
      .spyOn(cookiesMod, "jarProfilesReady")
      .mockImplementation(() => Promise.reject(new Error("torture: boot gate rejected")));
    let f: ReturnType<typeof fireFetch>;
    try {
      fetchState.impl = async () => new Response("x", { headers: { "content-type": "text/plain" } });
      f = fireFetch(new Request("https://target.example/asset"));
      f.fire();
    } finally {
      spy.mockRestore();
    }
    expect(f!.armed.length).toBe(1);
    const resp = await f!.armed[0];
    expect(resp).toBeInstanceOf(Response);
    expect(resp.status).toBe(502);
    await drain(f!.held);
  });

  it("a rejected boot gate on a navigation lands as the honest error page", async () => {
    const spy = vi
      .spyOn(cookiesMod, "jarProfilesReady")
      .mockImplementation(() => Promise.reject(new Error("torture: boot gate rejected")));
    let f: ReturnType<typeof fireFetch>;
    try {
      /* a real navigation carries mode "navigate" (undici honors it in
         the constructor); the outer catch branches on the mode */
      const nav = new Request("https://target.example/doc", { headers: { "sec-fetch-dest": "document" } });
      Object.defineProperty(nav, "mode", { value: "navigate" });
      f = fireFetch(nav);
      f.fire();
    } finally {
      spy.mockRestore();
    }
    const resp = await f!.armed[0];
    expect(resp.status).toBe(502);
    expect(resp.headers.get("content-type")).toContain("text/html");
    await drain(f!.held);
  });
});

/* ==================================================================
   F. Arming guarantee + never-rejecting respondWith
   ================================================================== */
/* The classes that are INTENTIONALLY browser-owned (respondWith must
   stay unarmed): opaque schemes whose destination is not a worker
   script, and the /wisp/ transport endpoint. */
const UNARMED_CASES: Array<{ name: string; req: Request }> = [
  { name: "data: url", req: stubRequest("data:text/plain,hi") },
  { name: "blob: url (non-worker destination)", req: stubRequest("blob:" + ORIGIN + "/9ab") },
  { name: "blob: url (POST)", req: stubRequest("blob:" + ORIGIN + "/9ac", { method: "POST" }) },
  { name: "about:blank", req: stubRequest("about:blank") },
  { name: "wisp transport endpoint", req: new Request(ORIGIN + "/wisp/") },
  { name: "wisp transport endpoint (deep)", req: new Request(ORIGIN + "/wisp/deep/path?x=1") },
];

/* A valid /zl-bw/ token: the blob-worker prelude route. */
const zlBwUrl = (site = "site.example", base = "https://site.example/"): string =>
  ORIGIN + "/zl-bw/?c=" + encodeURIComponent(JSON.stringify({ s: site, b: base }));

type Case = { name: string; make: () => Request; opts?: Record<string, unknown> };

const deterministicCases = (): Case[] => {
  const cases: Case[] = [];
  const req = (url: string, init?: RequestInit): Request => new Request(url, init);
  /* Same-origin shapes */
  cases.push({ name: "host page path", make: () => req(ORIGIN + "/index.html") });
  cases.push({ name: "host asset", make: () => req(ORIGIN + "/assets/app.js", { headers: { "sec-fetch-dest": "script" } }) });
  cases.push({ name: "engine route garbage token", make: () => req(ORIGIN + "/j/!!!not-base64url!!!") });
  cases.push({ name: "engine route empty", make: () => req(ORIGIN + "/j/") });
  cases.push({ name: "navh garbage token", make: () => req(ORIGIN + "/__zl_navh__/garbage-garbage") });
  cases.push({ name: "navh empty", make: () => req(ORIGIN + "/__zl_navh__/") });
  cases.push({ name: "query handle garbage", make: () => req(ORIGIN + "/x?zlNavh=%00%01garbage") });
  cases.push({ name: "query handle empty value", make: () => req(ORIGIN + "/?zlNavh=") });
  cases.push({ name: "navp marker garbage", make: () => req(ORIGIN + "/a/__zlprel__/b/c") });
  cases.push({ name: "nav marker garbage", make: () => req(ORIGIN + "/__zl_nav__/!!") });
  cases.push({ name: "zl-bw bad token", make: () => req(ORIGIN + "/zl-bw/?c=garbage") });
  cases.push({ name: "zl-bw missing token", make: () => req(ORIGIN + "/zl-bw/") });
  cases.push({ name: "zl-bw valid token (prelude ok)", make: () => req(zlBwUrl()) });
  cases.push({ name: "ext route garbage", make: () => req(ORIGIN + "/zl-ext/!!!/popup.html") });
  cases.push({ name: "cs route garbage", make: () => req(ORIGIN + "/zl-cs/???") });
  cases.push({ name: "rooted zlExt no grant", make: () => req(ORIGIN + "/?zlExt=nope") });
  cases.push({ name: "deeply nested unknown path", make: () => req(ORIGIN + "/" + "a/".repeat(120) + "leaf") });
  cases.push({ name: "unicode path", make: () => req(ORIGIN + "/日本語/נְתִיב/x") });
  cases.push({ name: "null byte query", make: () => req(ORIGIN + "/x?q=%00&y=%01") });
  cases.push({ name: "huge query", make: () => req(ORIGIN + "/x?q=" + "z".repeat(8000)) });
  /* Foreign shapes (no client context: host-traffic passthrough) */
  cases.push({ name: "foreign simple", make: () => req("https://target.example/") });
  cases.push({ name: "foreign post", make: () => req("https://target.example/api", { method: "POST", body: "k=v" }) });
  cases.push({ name: "foreign preflight", make: () => req("https://target.example/api", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } }) });
  cases.push({ name: "foreign opaque port", make: () => req("https://target.example:8642/x") });
  /* Blob worker script (engine-owned prelude branch). The battery
     runs after the hygiene section, so the prelude asset cache is
     warm and the branch answers from it. */
  cases.push({ name: "blob worker script GET (prelude cached)", make: () => stubRequest("blob:" + ORIGIN + "/worker-1", { destination: "worker" }) });
  return cases;
};

describe("arming + never-rejecting respondWith (deterministic battery)", () => {
  for (const c of deterministicCases()) {
    it("arms exactly once and answers with a Response: " + c.name, async () => {
      const f = fireFetch(c.make(), c.opts);
      f.fire();
      /* arming is synchronous: no await before this point */
      expect(f.armed.length).toBe(1);
      const resp = await f.armed[0];
      expect(resp).toBeInstanceOf(Response);
      expect(resp.status).toBeGreaterThanOrEqual(200);
      expect(resp.status).toBeLessThanOrEqual(599);
      await drain(f.held);
    });
  }

  for (const c of UNARMED_CASES) {
    it("stays browser-owned without arming: " + c.name, async () => {
      const f = fireFetch(c.req);
      f.fire();
      expect(f.armed.length).toBe(0);
    });
  }
});

/* Seeded LCG fuzz over hostile URL/request space. Every deviation from
   the two invariants is a finding: arming class violated, armed promise
   rejected, or a non-Response answer. */
describe("arming + never-rejecting respondWith (seeded fuzz)", () => {
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const garbage = (rnd: () => number, n: number): string => {
    const alphabet = "ABCabc012-_!#$%&()*+,:;=?@[]^`{|}~Äöü\u00e9\u4e2d";
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    return s;
  };

  const iters = 80;
  const seed = 0x5efe11;

  it("every seeded request arms its class and never rejects respondWith", async () => {
    const rnd = mulberry32(seed);
    const deviations: string[] = [];
    for (let i = 0; i < iters; i++) {
      const pick = rnd();
      let url: string;
      if (pick < 0.3) {
        url = ORIGIN + "/" + garbage(rnd, 1 + Math.floor(rnd() * 60));
      } else if (pick < 0.5) {
        url = ORIGIN + "/j/" + garbage(rnd, 1 + Math.floor(rnd() * 40));
      } else if (pick < 0.65) {
        url = ORIGIN + "/__zl_navh__/" + garbage(rnd, 1 + Math.floor(rnd() * 40));
      } else if (pick < 0.8) {
        url = "https://f" + Math.floor(rnd() * 9) + ".example/" + garbage(rnd, 1 + Math.floor(rnd() * 40)) + "?q=" + encodeURIComponent(garbage(rnd, 1 + Math.floor(rnd() * 20)));
      } else if (pick < 0.9) {
        url = zlBwUrl(garbage(rnd, 8), "https://" + garbage(rnd, 6) + ".example/");
      } else {
        url = ORIGIN + "/?zlNavh=" + encodeURIComponent(garbage(rnd, 1 + Math.floor(rnd() * 30)));
      }
      const method = pick < 0.8 ? "GET" : rnd() < 0.5 ? "POST" : "OPTIONS";
      const dest = ["document", "script", "style", "image", "empty", "worker"][Math.floor(rnd() * 6)];
      let request: Request;
      try {
        request = new Request(url, { method, headers: { "sec-fetch-dest": dest } });
      } catch {
        continue; /* Request constructor rejected: not an engine case */
      }
      if (method === "OPTIONS") request.headers.set("access-control-request-method", "POST");
      /* every fuzz template is http(s) engine work: /wisp/ and the
         opaque schemes are covered by the deterministic battery */
      const f = fireFetch(request);
      try {
        f.fire();
        const armedShould = true;
        if (armedShould && f.armed.length !== 1) {
          deviations.push(`case ${i} (${method} ${url}): armed ${f.armed.length}`);
          continue;
        }
        if (!armedShould) {
          if (f.armed.length !== 0) deviations.push(`case ${i} (${method} ${url}): expected unarmed, got ${f.armed.length}`);
          continue;
        }
        const resp = await Promise.race([
          f.armed[0].then(
            (r) => r,
            (err: unknown) => err,
          ),
          new Promise<string>((r) => setTimeout(() => r("TIMEOUT"), 8000)),
        ]);
        if (resp === "TIMEOUT") {
          deviations.push(`case ${i} (${method} ${url}): respondWith never settled`);
        } else if (resp instanceof Response) {
          if (resp.status < 200 || resp.status > 599) deviations.push(`case ${i} (${method} ${url}): status ${resp.status}`);
        } else {
          deviations.push(`case ${i} (${method} ${url}): respondWith REJECTED with ${String(resp)}`);
        }
        await drain(f.held);
      } catch (err) {
        deviations.push(`case ${i} (${method} ${url}): threw ${String(err)}`);
      }
    }
    if (deviations.length > 0) {
      throw new Error(`UNCLASSIFIED DEVIATIONS (${deviations.length}/${iters}):\n` + deviations.slice(0, 10).join("\n"));
    }
    expect(deviations.length).toBe(0);
  });
});

/* ==================================================================
   I. The update poll degrades without a usable registration
   ================================================================== */
describe("startUpdateChecks registration degradation", () => {
  it("a worker world without registration.update() must not throw at module scope", async () => {
    vi.resetModules();
    const brokenWorlds: unknown[] = [
      { location: { origin: ORIGIN, href: ORIGIN + "/sw.js" } }, /* no registration at all */
      { location: { origin: ORIGIN, href: ORIGIN + "/sw.js" }, registration: { addEventListener: () => undefined } }, /* no update() */
    ];
    for (const w of brokenWorlds) {
      vi.stubGlobal("self", w);
      const upd = await import("../updates");
      expect(() => upd.startUpdateChecks()).not.toThrow();
    }
  });
});
