import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Node runtime provides setImmediate; the app tsconfig deliberately
   ships no node types, so the ambient declaration lives here. Used as
   the macrotask flush because raceBoot's fake timers fake setTimeout
   only (the PR #597 fake-indexeddb/setImmediate lesson, inverted). */
declare function setImmediate(cb: () => void): void;

/* Service-worker composition-root torture suite.

   Target: app/src/sw.ts - the entrypoint that boots the runtime and
   wires install/activate/fetch/message events to the engine. The file
   is 90% wiring, so the torture is of the WIRING: every seam a close
   reading flagged (boot-fault propagation, event-listener lifetime,
   the respondWith proxy, the ready-gate ordering, module-evaluation
   survival) is driven with fault injection at the leaf modules and
   real behavior at everything sw.ts actually composes.

   Layered like cookies-torture.test.ts:

   - deterministic fault injection: each boot step (jar restore,
     download registries, extension phases, prewarm, transport warm,
     claim, route shape) resolves / rejects / hangs / throws sync, and
     the suite asserts the composition survives with the documented
     degraded default and an honest diagnostic - never silently, never
     by killing the worker;
   - wiring invariants: one listener per event, the seams sw.ts hands
     out (ghostery dest coercion, transform deps, perms backend,
     dispatcher delivery) behave as documented;
   - the respondWith proxy: CORP funneling for every response shape,
     passthrough for the honest withCorp limits, and observability of
     an escaped engine rejection (#250's mirror at the fetch seam);
   - pinned deltas: the control-plane ready gate is SEQUENTIAL
     (routeReady, then the bounded initReady race), so its worst-case
     open time is the sum of the two bounds, not the max. Deliberate
     composition, pinned here; the fetch gate runs the same promises
     concurrently.

   The heavy leaves are mocked (cookies, downloads, extensions,
   transport, ghostery, transform, request, control, swstate) because
   they have their own suites; lifecycle, corp, updates, netlog, diag,
   codec and cpgate are REAL - they are what sw.ts composes. */

/* ---- scenario bag (hoisted: the mock factories read it at call time) */

type Mode = "resolve" | "reject" | "hang" | "throw";

const bag = vi.hoisted(() => {
  const state = {
    jarLoad: "resolve" as Mode,
    dlLoad: "resolve" as Mode,
    extDownloadsLoad: "resolve" as Mode,
    extStartup: "resolve" as Mode,
    extBoot: "resolve" as Mode,
    prewarm: "resolve" as Mode,
    transportReady: "resolve" as Mode,
    claim: "resolve" as "resolve" | "reject",
    matchAllError: false,
    hasRegistration: true,
    routeReadyHang: false,
    fpScript: "fp-script",
    routeKey: "route-key",
    lazyImages: false,
    siteProfile: null as { script: string } | null,
    handleFetch: null as null | ((e: { respondWith(r: Response | Promise<Response>): void; waitUntil(p: Promise<unknown>): void; [k: string]: unknown }) => void),
    settleRoute: null as null | (() => void),
  };
  const calls = {
    jarLoad: 0,
    dlLoad: 0,
    extDownloadsLoad: 0,
    setResumeFetch: [] as unknown[],
    initTransport: [] as unknown[],
    initTransform: [] as unknown[],
    ghosteryFetch: [] as unknown[],
    controlDeps: [] as { ready: Promise<unknown>; persistRoute: unknown }[],
    messageEvents: [] as unknown[],
    initEngine: [] as unknown[],
    handleFetchEvents: [] as unknown[],
    extStartup: 0,
    extBoot: 0,
    alarmWake: [] as unknown[],
    mgmtWire: [] as unknown[],
    tabsDispatch: [] as unknown[],
    tabsMessageDispatch: [] as unknown[],
    scriptingDispatch: [] as unknown[],
    extDownloadsDispatch: [] as unknown[],
    notifyDispatch: [] as unknown[],
    actionDispatch: [] as unknown[],
    permsBackend: [] as unknown[],
    transportReady: 0,
    grantOptional: 0,
    revokeOptional: 0,
  };
  const drive = (mode: Mode): Promise<void> => {
    if (mode === "resolve") return Promise.resolve();
    if (mode === "reject") return Promise.reject(new Error("torture: " + mode));
    if (mode === "hang") return new Promise<void>(() => {});
    throw new Error("torture: sync throw");
  };
  return { state, calls, drive };
});

vi.mock("../cookies", () => ({
  jarLoad: () => {
    bag.calls.jarLoad++;
    return bag.drive(bag.state.jarLoad);
  },
}));
vi.mock("../downloads", () => ({
  DL: {
    load: () => {
      bag.calls.dlLoad++;
      return bag.drive(bag.state.dlLoad);
    },
    setResumeFetch: (f: unknown) => {
      bag.calls.setResumeFetch.push(f);
    },
  },
}));
vi.mock("../extensions", () => ({
  ALARMS: { setWake: (f: unknown) => bag.calls.alarmWake.push(f) },
  MGMT: { wire: (x: unknown) => bag.calls.mgmtWire.push(x) },
  TABS: {
    setDispatch: (f: unknown) => bag.calls.tabsDispatch.push(f),
    setMessageDispatch: (f: unknown) => bag.calls.tabsMessageDispatch.push(f),
  },
  SCRIPTING: { setDispatch: (f: unknown) => bag.calls.scriptingDispatch.push(f) },
  DOWNLOADS: {
    load: () => {
      bag.calls.extDownloadsLoad++;
      return bag.drive(bag.state.extDownloadsLoad);
    },
    setDispatch: (f: unknown) => bag.calls.extDownloadsDispatch.push(f),
  },
  NOTIFY: { setDispatch: (f: unknown) => bag.calls.notifyDispatch.push(f) },
  ACTION: { setDispatch: (f: unknown) => bag.calls.actionDispatch.push(f) },
  PERMS: { setBackend: (f: unknown) => bag.calls.permsBackend.push(f) },
  bootEnabled: () => {
    bag.calls.extBoot++;
    return bag.drive(bag.state.extBoot);
  },
  extensions: {
    startup: () => {
      bag.calls.extStartup++;
      return bag.drive(bag.state.extStartup);
    },
    grantOptional: async () => {
      bag.calls.grantOptional++;
      return { permissions: ["tabs"], hostPermissions: ["*://granted/*"] };
    },
    revokeOptional: async () => {
      bag.calls.revokeOptional++;
      return null;
    },
  },
  wakeExtension: () => {},
}));
vi.mock("../transport", () => ({
  initTransport: (d: unknown) => {
    bag.calls.initTransport.push(d);
  },
  wispTransport: {
    fetch: (u: unknown, i: unknown) => {
      void u;
      void i;
      return Promise.resolve(new Response(""));
    },
    ready: () => {
      bag.calls.transportReady++;
      return bag.drive(bag.state.transportReady);
    },
  },
}));
vi.mock("../ghostery", () => ({
  configureGhostery: (f: unknown) => {
    (bag.state as { ghosterySeam?: unknown }).ghosterySeam = f;
  },
}));
vi.mock("../transform", () => ({
  initTransform: (d: unknown) => {
    bag.calls.initTransform.push(d);
  },
  prewarmRewriter: () => bag.drive(bag.state.prewarm),
}));
vi.mock("../swstate", () => ({
  ZEOLITE_VERSION: "torture-9.9.9",
  getFpScript: () => bag.state.fpScript,
  getRouteKey: () => bag.state.routeKey,
  isImageLazy: () => bag.state.lazyImages,
  setEngineDegraded: () => {},
  siteProfileFor: async () => bag.state.siteProfile,
}));
vi.mock("../request", () => ({
  /* a getter, not a factory-time value: vi.resetModules() re-evaluates
     sw.ts but REUSES the mocked module instance, so anything computed
     once in the factory is frozen by whichever test imported first.
     The getter runs at sw.ts's messageListener wiring - per boot. */
  get routeReady() {
    if (!bag.state.routeReadyHang) return Promise.resolve();
    return new Promise<void>((res) => {
      (bag.state as { settleRoute?: () => void }).settleRoute = res;
    });
  },
  initEngine: (p: unknown) => {
    bag.calls.initEngine.push(p);
  },
  handleFetch: (e: unknown) => {
    bag.calls.handleFetchEvents.push(e);
    if (bag.state.handleFetch) bag.state.handleFetch(e as never);
  },
  ghosteryListFetch: (dest: unknown, init: unknown) => {
    bag.calls.ghosteryFetch.push([dest, init]);
    return Promise.resolve(new Response(""));
  },
  persistRoute: () => {},
}));
vi.mock("../control", () => ({
  messageListener: (deps: { ready: Promise<unknown>; persistRoute: unknown }) => {
    bag.calls.controlDeps.push(deps);
    return (e: unknown) => {
      bag.calls.messageEvents.push(e);
    };
  },
}));

/* ---- fake ServiceWorkerGlobalScope --------------------------------- */

const ORIGIN = "https://engine.example";

interface FakeCtx {
  swself: Record<string, unknown>;
  listeners: Map<string, Array<(e: unknown) => void>>;
  errors: unknown[];
  posted: Array<{ client: string; msg: unknown }>;
  claimCalls: number;
  skipWaiting: number;
  updateCalls: number;
  updateFoundListeners: Array<[string, unknown]>;
  dispatch(type: string, ev: unknown): void;
}

function makeFakeSelf(opts: { claim?: "resolve" | "reject"; clients?: Array<{ url: string; postMessage(msg: unknown, transfer?: unknown[]): void }>; hasRegistration?: boolean; matchAllError?: boolean }): FakeCtx {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const errors: unknown[] = [];
  const posted: Array<{ client: string; msg: unknown }> = [];
  const clients = (opts.clients ?? []).map((c, i) => ({
    url: c.url,
    postMessage: (msg: unknown, transfer?: unknown[]) => {
      void transfer;
      posted.push({ client: "c" + i, msg });
    },
  }));
  const ctx: FakeCtx = {
    swself: {},
    listeners,
    errors,
    posted,
    claimCalls: 0,
    skipWaiting: 0,
    updateCalls: 0,
    updateFoundListeners: [],
    dispatch(type, ev) {
      for (const fn of listeners.get(type) ?? []) {
        try {
          fn(ev);
        } catch (err) {
          errors.push(err);
        }
      }
    },
  };
  ctx.swself = {
    location: { origin: ORIGIN },
    addEventListener(type: string, fn: (e: unknown) => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    skipWaiting() {
      ctx.skipWaiting++;
    },
    clients: {
      claim: () => {
        ctx.claimCalls++;
        if ((opts.claim ?? "resolve") === "reject") return Promise.reject(new Error("claim refused"));
        return Promise.resolve();
      },
      matchAll: () => {
        if (opts.matchAllError) return Promise.reject(new Error("matchAll refused"));
        return Promise.resolve(clients);
      },
      get: () => Promise.resolve(null),
    },
    registration:
      opts.hasRegistration === false
        ? undefined
        : {
            scope: ORIGIN + "/",
            active: { scriptURL: ORIGIN + "/sw.js" },
            addEventListener: (t: string, fn: unknown) => {
              ctx.updateFoundListeners.push([t, fn]);
            },
            update: () => {
              ctx.updateCalls++;
              return Promise.resolve();
            },
          },
  };
  return ctx;
}

/** A fresh worker evaluation: reset the module graph, stub self/fetch,
    import the real entrypoint, hand back the wiring handles. */
async function bootSW(opts: {
  jarLoad?: Mode;
  dlLoad?: Mode;
  extDownloadsLoad?: Mode;
  extStartup?: Mode;
  extBoot?: Mode;
  prewarm?: Mode;
  transportReady?: Mode;
  claim?: "resolve" | "reject";
  clients?: Array<{ url: string; postMessage(msg: unknown, transfer?: unknown[]): void }>;
  hasRegistration?: boolean;
  matchAllError?: boolean;
  routeReadyHang?: boolean;
  handleFetch?: null | ((e: { respondWith(r: Response | Promise<Response>): void; waitUntil(p: Promise<unknown>): void; [k: string]: unknown }) => void);
} = {}): Promise<{ ctx: FakeCtx; hooks: typeof bag; DIAG: typeof import("../diag")["DIAG"]; flush(): Promise<void> }> {
  vi.resetModules();
  /* per-boot counters: a fresh worker evaluation's calls read clean
     even when several boots happen inside one test */
  for (const k of Object.keys(bag.calls)) {
    const v = (bag.calls as unknown as Record<string, unknown>)[k];
    if (Array.isArray(v)) v.length = 0;
    else (bag.calls as unknown as Record<string, number>)[k] = 0;
  }
  bag.state.jarLoad = opts.jarLoad ?? "resolve";
  bag.state.dlLoad = opts.dlLoad ?? "resolve";
  bag.state.extDownloadsLoad = opts.extDownloadsLoad ?? "resolve";
  bag.state.extStartup = opts.extStartup ?? "resolve";
  bag.state.extBoot = opts.extBoot ?? "resolve";
  bag.state.prewarm = opts.prewarm ?? "resolve";
  bag.state.transportReady = opts.transportReady ?? "resolve";
  bag.state.claim = opts.claim ?? "resolve";
  bag.state.hasRegistration = opts.hasRegistration ?? true;
  bag.state.matchAllError = opts.matchAllError ?? false;
  bag.state.routeReadyHang = opts.routeReadyHang ?? false;
  bag.state.settleRoute = null;
  bag.state.handleFetch = opts.handleFetch ?? null;
  const ctx = makeFakeSelf({ claim: opts.claim, clients: opts.clients, hasRegistration: opts.hasRegistration, matchAllError: opts.matchAllError });
  vi.stubGlobal("self", ctx.swself);
  /* engineSha (update broadcast) fetches the worker script: stubbed to
     a 404 so sha resolves null without network and without crypto. */
  vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
  await import("../sw");
  const { DIAG } = await import("../diag");
  const flush = () => new Promise<void>((r) => setImmediate(r));
  await flush();
  return { ctx, hooks: bag, DIAG, flush };
}

/** Extendable-event fake whose waitUntil records what it was handed
    (and observes rejections so the suite never trips unhandled
    rejection on a behavior it is asserting about). */
function mkExtendable() {
  const held: Array<Promise<unknown>> = [];
  return {
    ev: {
      waitUntil: (p: Promise<unknown>) => {
        held.push(p);
        void p.catch(() => {});
      },
    } as unknown as ExtendableEvent,
    held,
  };
}

/** Fetch-event fake: respondWith records the armed promise (with a
    no-op catch attached purely for unhandled-rejection hygiene). */
function mkFetchEvent() {
  const armed: Array<Promise<Response>> = [];
  const waitUntil: Array<Promise<unknown>> = [];
  const preventDefault = vi.fn();
  const request = { url: ORIGIN + "/j/route", method: "GET", headers: new Headers() };
  const target = {
    request,
    clientId: "c-fetch",
    resultingClientId: "c-new",
    respondWith: (p: Promise<Response>) => {
      armed.push(p);
      void p.catch(() => {});
    },
    waitUntil: (p: Promise<unknown>) => {
      waitUntil.push(p);
    },
    preventDefault,
  };
  return { target: target as unknown as Record<string, unknown>, armed, waitUntil, preventDefault, request };
}

const BOOT_DEADLINE = 10_000;
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  for (const k of Object.keys(bag.calls)) {
    const v = (bag.calls as unknown as Record<string, unknown>)[k];
    if (Array.isArray(v)) v.length = 0;
    else (bag.calls as unknown as Record<string, number>)[k] = 0;
  }
  bag.state.siteProfile = null;
  (bag.state as { ghosterySeam?: unknown }).ghosterySeam = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* composition invariants                                              */
/* ------------------------------------------------------------------ */

describe("composition invariants", () => {
  it("wires exactly one listener per event and survives evaluation", async () => {
    const { ctx } = await bootSW();
    expect([...ctx.listeners.keys()].sort()).toEqual(["activate", "fetch", "install", "message"]);
    for (const arr of ctx.listeners.values()) expect(arr).toHaveLength(1);
    expect(ctx.errors).toHaveLength(0);
  });

  it("module evaluation survives a self without a registration object", async () => {
    /* updates.ts guards the updatefound listener but used to poll
       registration.update() unguarded: one sync TypeError killed the
       entire sw.ts evaluation - no listeners wired at all. In a real
       service worker registration always exists; the guard is for
       non-SW evaluation contexts (tests, tooling, harnesses). */
    const { ctx } = await bootSW({ hasRegistration: false });
    expect(ctx.errors).toHaveLength(0);
    expect([...ctx.listeners.keys()].sort()).toEqual(["activate", "fetch", "install", "message"]);
  });

  it("hands the transport the degraded-flag seam and ghostery a coercing fetcher", async () => {
    const { hooks } = await bootSW();
    const seam = hooks.calls.initTransport[0] as { setDegraded: unknown };
    expect(typeof seam.setDegraded).toBe("function");
    const ghosterySeam = (hooks.state as { ghosterySeam?: (input: unknown, init: unknown) => unknown }).ghosterySeam as (input: unknown, init: unknown) => unknown;
    expect(typeof ghosterySeam).toBe("function");
    /* the dest coercion table sw.ts owns */
    ghosterySeam("https://g.example/list", { cache: "no-store" });
    ghosterySeam(new URL("https://g.example/u"), undefined);
    ghosterySeam({ url: "https://g.example/req" }, undefined);
    expect((hooks.calls.ghosteryFetch as unknown[]).map((entry) => (entry as unknown[])[0])).toEqual([
      "https://g.example/list",
      "https://g.example/u",
      "https://g.example/req",
    ]);
  });

  it("hands transform the live seams it documented", async () => {
    const { hooks } = await bootSW();
    const d = hooks.calls.initTransform[0] as {
      routeReady(): unknown;
      routeKey(): unknown;
      fpScript(): unknown;
      siteScript(base: string): Promise<unknown>;
      setDegraded(v: unknown): void;
      lazyImages(): unknown;
    };
    expect(d.routeReady()).toBeInstanceOf(Promise);
    expect(d.routeKey()).toBe("route-key");
    expect(d.fpScript()).toBe("fp-script");
    expect(d.lazyImages()).toBe(false);
    await expect(d.siteScript("https://a.example/")).resolves.toBeNull();
    hooks.state.siteProfile = { script: "site-script" };
    await expect(d.siteScript("https://a.example/")).resolves.toBe("site-script");
  });

  it("injects its boot promise into the engine and the control plane", async () => {
    const { hooks } = await bootSW();
    expect(hooks.calls.initEngine).toHaveLength(1);
    const boot = hooks.calls.initEngine[0] as Promise<void>;
    expect(boot).toBeInstanceOf(Promise);
    await expect(boot).resolves.toBeUndefined();
    const deps = hooks.calls.controlDeps[0]!;
    expect(deps.ready).toBeInstanceOf(Promise);
    await expect(deps.ready).resolves.toBeUndefined();
    expect(deps.persistRoute).toBeInstanceOf(Function);
  });

  it("wires every dispatcher and the permissions backend during boot", async () => {
    const { hooks } = await bootSW();
    for (const key of ["tabsDispatch", "tabsMessageDispatch", "scriptingDispatch", "extDownloadsDispatch", "notifyDispatch", "actionDispatch", "permsBackend", "alarmWake", "mgmtWire"] as const) {
      expect(hooks.calls[key].length).toBeGreaterThanOrEqual(1);
    }
    /* resume fetch rides the wisp transport */
    expect(hooks.calls.setResumeFetch).toHaveLength(1);

    const backend = hooks.calls.permsBackend[0] as (id: string, op: string, perms: string[]) => Promise<unknown>;
    await expect(backend("ext1", "grant", ["tabs"])).resolves.toEqual({
      permissions: ["tabs"],
      origins: ["*://granted/*"],
    });
    await expect(backend("ext1", "revoke", ["tabs"])).resolves.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* install lifecycle                                                   */
/* ------------------------------------------------------------------ */

describe("install lifecycle (prewarm seam)", () => {
  it("skipWaiting stays and a resolved prewarm settles install", async () => {
    const { ctx, hooks } = await bootSW({ prewarm: "resolve" });
    const { ev, held } = mkExtendable();
    ctx.dispatch("install", ev);
    expect(ctx.skipWaiting).toBe(1);
    expect(held).toHaveLength(1);
    await expect(held[0]!).resolves.toBeUndefined();
    expect(ctx.errors).toHaveLength(0);
    expect(hooks.calls.jarLoad).toBe(1);
  });

  it("a rejecting prewarm settles install undefined, never fails it", async () => {
    const { ctx } = await bootSW({ prewarm: "reject" });
    const { ev, held } = mkExtendable();
    ctx.dispatch("install", ev);
    await expect(held[0]!).resolves.toBeUndefined();
    expect(ctx.errors).toHaveLength(0);
  });

  it("a hanging prewarm is bounded by the boot deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { ctx, DIAG } = await bootSW({ prewarm: "hang" });
    const { ev, held } = mkExtendable();
    ctx.dispatch("install", ev);
    let settled = false;
    void held[0]!.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(BOOT_DEADLINE - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const rows = DIAG.snapshot(0).events.filter((e) => e.message.includes("rewriter prewarm"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("SERVICE_WORKER");
  });

  it("a sync-throwing prewarm seam still arms waitUntil (no listener death)", async () => {
    /* installLifecycle called prewarm() outside any guard: a sync
       throw escaped the listener, waitUntil was never armed, and the
       install event died. */
    const { ctx } = await bootSW({ prewarm: "throw" });
    const { ev, held } = mkExtendable();
    ctx.dispatch("install", ev);
    expect(ctx.errors).toHaveLength(0);
    expect(held).toHaveLength(1);
    await expect(held[0]!).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* activate lifecycle                                                  */
/* ------------------------------------------------------------------ */

describe("activate lifecycle (claim, broadcast, transport warm)", () => {
  const hostClient = { url: ORIGIN + "/", postMessage: () => {} };

  it("claims, broadcasts the engine update, warms the transport", async () => {
    const { ctx, hooks } = await bootSW({ clients: [hostClient] });
    const { ev, held } = mkExtendable();
    ctx.dispatch("activate", ev);
    await expect(held[0]!).resolves.toBeUndefined();
    expect(ctx.claimCalls).toBe(1);
    expect(ctx.posted.length).toBe(1);
    expect((ctx.posted[0]!.msg as { type: string }).type).toBe("zl:engineUpdate");
    expect(hooks.calls.transportReady).toBe(1);
  });

  it("a refused claim still broadcasts to the visible clients and warms the transport", async () => {
    /* clients.claim() rejection used to skip the update broadcast AND
       the transport warm-up silently, and reject waitUntil. Neither
       depends on claim succeeding. */
    const { ctx, hooks } = await bootSW({ claim: "reject", clients: [hostClient] });
    const { ev, held } = mkExtendable();
    ctx.dispatch("activate", ev);
    await expect(held[0]!).resolves.toBeUndefined();
    expect(ctx.claimCalls).toBe(1);
    expect(ctx.posted.length).toBe(1);
    expect(hooks.calls.transportReady).toBe(1);
  });

  it("a failing update broadcast costs one cycle, not the warm-up", async () => {
    const { ctx, hooks } = await bootSW({ matchAllError: true });
    const { ev, held } = mkExtendable();
    ctx.dispatch("activate", ev);
    await expect(held[0]!).resolves.toBeUndefined();
    expect(hooks.calls.transportReady).toBe(1);
  });

  it("a transport that cannot warm settles activate anyway (suite records transport-missing)", async () => {
    const { ctx, hooks } = await bootSW({ transportReady: "reject", clients: [hostClient] });
    const { ev, held } = mkExtendable();
    ctx.dispatch("activate", ev);
    await expect(held[0]!).resolves.toBeUndefined();
    expect(hooks.calls.transportReady).toBe(1);
    expect(ctx.posted.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* boot fault injection (the initReady composition)                    */
/* ------------------------------------------------------------------ */

describe("boot fault injection", () => {
  it("a rejecting jar restore degrades to the in-memory jar, boot still completes", async () => {
    const { hooks } = await bootSW({ jarLoad: "reject" });
    await expect(hooks.calls.initEngine[0] as Promise<void>).resolves.toBeUndefined();
    await expect(hooks.calls.controlDeps[0]!.ready).resolves.toBeUndefined();
  });

  it("a hanging jar restore is bounded for the control plane and named in DIAG", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hooks, DIAG } = await bootSW({ jarLoad: "hang" });
    const ready = hooks.calls.controlDeps[0]!.ready;
    let open = false;
    void ready.then(() => {
      open = true;
    });
    await vi.advanceTimersByTimeAsync(BOOT_DEADLINE - 1);
    expect(open).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toBe(true);
    const rows = DIAG.snapshot(0).events.filter((e) => e.message.includes("control-plane boot"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("SERVICE_WORKER");
    expect(rows[0]!.severity).toBe("error");
  });

  it("rejecting download registries never fail boot", async () => {
    const { hooks } = await bootSW({ dlLoad: "reject", extDownloadsLoad: "reject" });
    await expect(hooks.calls.controlDeps[0]!.ready).resolves.toBeUndefined();
    expect(hooks.calls.setResumeFetch).toHaveLength(1);
  });

  it("extension phases fail independently: a dead registry restore does not skip the wiring", async () => {
    const { hooks, DIAG } = await bootSW({ extStartup: "reject" });
    await expect(hooks.calls.controlDeps[0]!.ready).resolves.toBeUndefined();
    expect(hooks.calls.extBoot).toBe(1);
    expect(hooks.calls.alarmWake.length).toBe(1);
    expect(hooks.calls.mgmtWire.length).toBe(1);
    const rows = DIAG.snapshot(0).events.filter((e) => e.category === "EXTENSION" && e.message.includes("registry restore"));
    expect(rows).toHaveLength(1);
  });

  it("a sync-throwing extension phase is contained the same as a rejection", async () => {
    const { hooks, DIAG } = await bootSW({ extStartup: "throw" });
    await expect(hooks.calls.controlDeps[0]!.ready).resolves.toBeUndefined();
    expect(hooks.calls.extBoot).toBe(1);
    expect(DIAG.snapshot(0).events.some((e) => e.category === "EXTENSION")).toBe(true);
  });

  it("a failed enabled-extension boot still wires alarms and management", async () => {
    const { hooks } = await bootSW({ extBoot: "reject" });
    await expect(hooks.calls.controlDeps[0]!.ready).resolves.toBeUndefined();
    expect(hooks.calls.alarmWake.length).toBe(1);
    expect(hooks.calls.mgmtWire.length).toBe(1);
  });

  it("PIN (delta): the control-plane ready gate is sequential - a hung route shape blocks the initReady race from arming", async () => {
    /* Deliberate composition: routeReady is awaited first, then
       raceBoot(initReady). Both are individually bounded (the route
       restore rides raceBoot in request.ts), so the gate is
       wedged-but-bounded: worst-case open time is the SUM of the two
       deadlines, not the max. Pinned, not changed: sequential gating
       is the documented order, and the fetch gate runs the same
       promises concurrently. */
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hooks, DIAG } = await bootSW({ routeReadyHang: true, jarLoad: "hang" });
    const ready = hooks.calls.controlDeps[0]!.ready;
    let open = false;
    void ready.then(() => {
      open = true;
    });
    /* the full engine-boot deadline passes with the route shape hung:
       the gate has not even armed the initReady race */
    await vi.advanceTimersByTimeAsync(BOOT_DEADLINE);
    expect(open).toBe(false);
    expect(DIAG.snapshot(0).events.filter((e) => e.message.includes("control-plane boot"))).toHaveLength(0);
    /* the route shape settles; now the initReady bound counts */
    bag.state.settleRoute?.();
    await vi.advanceTimersByTimeAsync(BOOT_DEADLINE);
    expect(open).toBe(true);
    expect(DIAG.snapshot(0).events.filter((e) => e.message.includes("control-plane boot"))).toHaveLength(1);
  });

  it("a fresh worker evaluation re-runs the restores (restart-safe init)", async () => {
    const first = await bootSW();
    expect(first.hooks.calls.jarLoad).toBe(1);
    const second = await bootSW();
    expect(second.hooks.calls.jarLoad).toBe(1);
    expect(second.ctx.listeners.get("fetch")).toHaveLength(1);
    expect(second.hooks.calls.initEngine).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* the fetch seam: proxy + withCorp                                    */
/* ------------------------------------------------------------------ */

describe("fetch seam (respondWith proxy + withCorp funnel)", () => {
  const drive = async (
    respond: (e: { respondWith(r: Response | Promise<Response>): void; waitUntil(p: Promise<unknown>): void; [k: string]: unknown }) => void,
  ) => {
    const { ctx } = await bootSW({ handleFetch: (e) => respond(e) });
    const fe = mkFetchEvent();
    ctx.dispatch("fetch", fe.target);
    return fe;
  };

  it("funnels a plain Response through withCorp", async () => {
    const fe = await drive((e) => {
      e.respondWith(new Response("body", { status: 201, headers: { "x-t": "1" } }));
    });
    const served = await fe.armed[0]!;
    expect(served.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(served.status).toBe(201);
    expect(served.headers.get("x-t")).toBe("1");
    await expect(served.text()).resolves.toBe("body");
  });

  it("funnels a promised Response the same way", async () => {
    const fe = await drive((e) => {
      e.respondWith(Promise.resolve(new Response("late")));
    });
    const served = await fe.armed[0]!;
    expect(served.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    await expect(served.text()).resolves.toBe("late");
  });

  it("a null-body 204 still carries CORP", async () => {
    const fe = await drive((e) => {
      e.respondWith(new Response(null, { status: 204 }));
    });
    const served = await fe.armed[0]!;
    expect(served.status).toBe(204);
    expect(served.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("PIN: an error Response and a locked-body Response pass through unrebuilt (withCorp honest limits)", async () => {
    const errResp = Response.error();
    const fe1 = await drive((e) => {
      e.respondWith(errResp);
    });
    await expect(fe1.armed[0]!).resolves.toBe(errResp);

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("z"));
        c.close();
      },
    });
    const locked = new Response(stream);
    void locked.body!.getReader(); /* lock the body: rebuild must throw */
    const fe2 = await drive((e) => {
      e.respondWith(locked);
    });
    const served = await fe2.armed[0]!;
    expect(served).toBe(locked);
    expect(served.headers.get("cross-origin-resource-policy")).toBeNull();
  });

  it("an escaped engine rejection is observable in DIAG, not silently swallowed", async () => {
    /* #250's mirror at the fetch seam: the engine contract is "every
       failure becomes an honest Response", but a rejection that
       escapes anyway used to reach the browser as a silent network
       error with no diagnostic anywhere. The seam now records a RUNTIME
       row and still rethrows - nothing is fabricated. */
    const { ctx, hooks } = await bootSW({
      handleFetch: (e) => {
        e.respondWith(Promise.reject(new Error("engine escape")));
      },
    });
    const fe = mkFetchEvent();
    ctx.dispatch("fetch", fe.target);
    await expect(fe.armed[0]!).rejects.toThrow("engine escape");
    const { DIAG } = await import("../diag");
    const rows = DIAG.snapshot(0).events.filter((e) => e.message.includes("respondWith rejection escaped"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("RUNTIME");
    expect(rows[0]!.technicalReason).toContain("engine escape");
    void hooks;
  });

  it("waitUntil, property reads and method binding pass through the proxy", async () => {
    const waitP = Promise.resolve();
    let seenRequest: unknown;
    let seenClientId: unknown;
    const fe = await drive((e) => {
      seenRequest = e.request;
      seenClientId = e.clientId;
      e.waitUntil(waitP);
      (e.preventDefault as () => void)();
      e.respondWith(new Response("ok"));
    });
    expect(seenRequest).toBe(fe.request);
    expect(seenClientId).toBe("c-fetch");
    expect(fe.waitUntil).toContain(waitP);
    expect(fe.preventDefault).toHaveBeenCalled();
    await expect(fe.armed[0]!).resolves.toBeInstanceOf(Response);
  });
});

/* ------------------------------------------------------------------ */
/* dispatcher delivery (real wireDispatchers + real cpgate gate)        */
/* ------------------------------------------------------------------ */

describe("dispatcher delivery through the sw boot wiring", () => {
  it("host-only ops reach host pages only", async () => {
    const clients = [
      { url: ORIGIN + "/", postMessage: () => {} },
      { url: ORIGIN + "/j/some-route", postMessage: () => {} },
      { url: "not a url", postMessage: () => {} },
    ];
    const { ctx, hooks } = await bootSW({ clients });
    const tabsDispatch = hooks.calls.tabsDispatch[0] as (op: unknown) => void;
    tabsDispatch({ op: "query" });
    await tick();
    expect(ctx.posted).toHaveLength(1);
    expect((ctx.posted[0]!.msg as { type: string }).type).toBe("zl:tabsOp");
  });

  it("a scripting reply port transfers to exactly one matching client and closes when unmatched", async () => {
    const codec = await import("../codec");
    codec.setScheme("/j/");
    codec.setRouteKey(codec.b64uEncode(new Uint8Array(16).map((_, i) => i + 32)));
    const route = ORIGIN + codec.encodeDestLegacy("https://site.example/page");
    const clients = [
      { url: route, postMessage: () => {} },
      { url: ORIGIN + "/", postMessage: () => {} },
    ];
    const { ctx, hooks } = await bootSW({ clients });
    const scripting = hooks.calls.scriptingDispatch[0] as (msg: { dest: string }, reply: { close(): void } | null) => void;

    const port = { close: vi.fn() };
    scripting({ dest: "https://site.example/page" }, port);
    await tick();
    expect(ctx.posted).toHaveLength(1);
    expect((ctx.posted[0]!.msg as { dest: string }).dest).toBe("https://site.example/page");

    ctx.posted.length = 0;
    const dead = { close: vi.fn() };
    scripting({ dest: "https://other.example/no-match" }, dead);
    await tick();
    expect(ctx.posted).toHaveLength(0);
    expect(dead.close).toHaveBeenCalled();
  });

  it("tab messages deliver only to the client whose decoded destination matches", async () => {
    const codec = await import("../codec");
    codec.setScheme("/j/");
    codec.setRouteKey(codec.b64uEncode(new Uint8Array(16).map((_, i) => i + 48)));
    const route = ORIGIN + codec.encodeDestLegacy("https://site.example/inbox");
    const clients = [
      { url: route, postMessage: () => {} },
      { url: ORIGIN + "/j/other", postMessage: () => {} },
    ];
    const { ctx, hooks } = await bootSW({ clients });
    const msgDispatch = hooks.calls.tabsMessageDispatch[0] as (tabId: number, tabUrl: string, extId: string, payload: unknown) => void;
    msgDispatch(1, "https://site.example/inbox", "ext1", { hello: true });
    await tick();
    expect(ctx.posted).toHaveLength(1);
    expect((ctx.posted[0]!.msg as { type: string }).type).toBe("zl:tabMessage");
  });
});
