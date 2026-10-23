import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Injector phase 2 (query-shape committed routes, config-gated): with
   the host's queryRoutes opt-in, zl:navHandle mints the opaque
   initial-navigation token into the query string, so the committed
   URL is <real path>?<real query>&zlNavh=<token>. window.location is
   LegacyUnforgeable, so only the committed-URL shape fixes pathname
   reads; these tests pin the differential contract (the committed
   URL parses natively exactly like the destination), the fail-closed
   seams (garbage tokens, engine-path collisions), the sender gate,
   the config-gated mint, the vloc history virtualization and the
   fetch-handler navigation arms. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  urls: [] as string[],
  queue: [] as Response[],
  inits: [] as Array<{ method?: string; headers?: Headers; body?: unknown } | undefined>,
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init?: { method?: string; headers?: Headers; body?: unknown }) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      transportMock.inits.push(init ? { method: init.method, headers: init.headers, body: init.body } : undefined);
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { dispatchCore, type ControlMessage } from "../control";
import {
  b64uEncode,
  buildQueryHandleUrl,
  decodeClientUrl,
  decodeExpiredNavHandle,
  decodeQueryHandle,
  queryHandleToken,
  setRouteKey,
  setScheme,
} from "../codec";
import { senderIsHostPage, senderIsProxiedPath } from "../cpgate";
import { setQueryRoutes } from "../swstate";
import { applyVloc } from "../bootstrap/vloc";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

const mkEvent = (routeUrl: string, mode: string, destination: string, method = "GET") => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method,
      mode,
      destination,
      credentials: "same-origin",
      referrer: "",
      body: null,
      headers: new Headers(),
    },
    clientId: "c-1",
    resultingClientId: "c-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

beforeEach(async () => {
  /* the module-eval routeRestore can replace the key set after this
     file first awaits (a fresh idb mints a new key), so let it settle
     BEFORE the key is set: the token must decode on every test. */
  await routeReady;
  setScheme("/j/");
  setRouteKey(KEY);
  setQueryRoutes(false);
  transportMock.calls = 0;
  transportMock.urls = [];
  transportMock.inits = [];
  transportMock.queue = [];
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });
  /* no cache storage: the cache-first lookup misses, the store warns once */
  vi.stubGlobal("caches", {
    open: async () => {
      throw new Error("no cache storage");
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("query-route codec (Injector phase 2)", () => {
  /* Differential corpus: plain, deep, query forms, percent-encoded
     params (byte fidelity vs URLSearchParams re-encoding), unicode
     paths, hashes. The hash rides the committed URL only; the decoded
     destination keeps none (matching buildNavHandleUrl). */
  const CORPUS = [
    ["https://search.brave.com/search?q=what+is+a+hurricane", "https://search.brave.com/search?q=what+is+a+hurricane"],
    ["https://example.com/", "https://example.com/"],
    ["https://example.com/a/b/c/deep/path/", "https://example.com/a/b/c/deep/path/"],
    ["https://example.com/p?a=1&b=two&c=", "https://example.com/p?a=1&b=two&c="],
    ["https://example.com/p?x=a%20b&y=%2Fslash", "https://example.com/p?x=a%20b&y=%2Fslash"],
    ["https://example.com/caf%C3%A9/stra%C3%9Fe?flt=1", "https://example.com/caf%C3%A9/stra%C3%9Fe?flt=1"],
    ["https://example.com/h#frag", "https://example.com/h"],
    ["https://example.com/p?q=1#f2", "https://example.com/p?q=1"],
  ] as const;

  it("the committed URL parses natively like the destination (differential)", () => {
    for (const [dest, expectedDest] of CORPUS) {
      const committed = buildQueryHandleUrl(dest)!;
      expect(committed).toBeTruthy();
      const cu = new URL(committed, ORIGIN);
      const du = new URL(dest);
      /* THE point of the shape: the native pathname read is the real
         destination path, with no shim in the path. */
      expect(cu.pathname).toBe(du.pathname);
      /* the search minus the token component is byte-identical to
         the destination search (raw strip, no re-encode) */
      const stripped = queryHandleToken(cu.search);
      expect(stripped).not.toBeNull();
      const cleaned = cu.search
        .replace(/^[?]/, "")
        .split("&")
        .filter((p) => !p.startsWith("zlNavh="))
        .join("&");
      expect(cleaned).toBe(du.search.replace(/^[?]/, ""));
      /* the hash rides the committed URL natively */
      expect(cu.hash).toBe(du.hash);
      /* decode round-trip: destination byte-exact */
      expect(decodeQueryHandle(cu)?.destination).toBe(expectedDest);
      expect(decodeClientUrl(cu)).toBe(expectedDest);
    }
  });

  it("an impostor zlNavh param stays page data; only the verified token strips", () => {
    const dest = "https://example.com/p?zlNavh=pagevalue&x=1";
    const committed = buildQueryHandleUrl(dest)!;
    const cu = new URL(committed, ORIGIN);
    expect(decodeQueryHandle(cu)?.destination).toBe(dest);
  });

  it("fails closed on garbage, expired and empty tokens", () => {
    const garbage = new URL("/search?q=1&zlNavh=notatoken", ORIGIN);
    expect(queryHandleToken(garbage.search)).toBe("notatoken");
    expect(decodeQueryHandle(garbage)).toBeNull();
    /* not an engine path either: the shared client decode is null,
       never a guess */
    expect(decodeClientUrl(garbage)).toBeNull();

    const expired = buildQueryHandleUrl("https://example.com/e?k=1", -1)!;
    const expiredUrl = new URL(expired, ORIGIN);
    expect(decodeQueryHandle(expiredUrl)).toBeNull();
    expect(decodeClientUrl(expiredUrl)).toBeNull();
    /* the #385 recovery arm still sees the verified expiry */
    /* the query token's payload names the origin only; the committed
       path and query carry the real tail */
    expect(decodeExpiredNavHandle(queryHandleToken(expiredUrl.search)!)?.destination).toBe(
      "https://example.com",
    );

    expect(queryHandleToken("")).toBeNull();
    expect(queryHandleToken("?")).toBeNull();
  });

  it("refuses minting onto the engine's own path vocabulary", () => {
    expect(buildQueryHandleUrl("https://example.com/sw.js")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/index.html")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/j/abc")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/__zl_navh__/x")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/__zl_prel__/x")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/__zl_nav__/x")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/wisp/endpoint")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/zl-ext/x")).toBeNull();
    expect(buildQueryHandleUrl("https://example.com/zl-cs/x")).toBeNull();
    /* a plain site path still mints */
    expect(buildQueryHandleUrl("https://example.com/normal/path")).not.toBeNull();
  });
});

describe("sender gate (cpgate) query-shape arms", () => {
  it("classifies a query-shape sender as proxied, never host", () => {
    expect(senderIsProxiedPath("/whatever", "?zlNavh=anything")).toBe(true);
    expect(senderIsProxiedPath("/whatever", "")).toBe(false);
    expect(senderIsProxiedPath("/j/abc")).toBe(true);
    /* a host pathname with the token is NOT a host page: the engine
       never mints the param for host pages, so presence fails closed */
    expect(senderIsHostPage(ORIGIN + "/?zlNavh=t", ORIGIN)).toBe(false);
    expect(senderIsHostPage(ORIGIN + "/index.html?zlNavh=t", ORIGIN)).toBe(false);
    /* unchanged host classifications */
    expect(senderIsHostPage(ORIGIN + "/", ORIGIN)).toBe(true);
    expect(senderIsHostPage(ORIGIN + "/index.html", ORIGIN)).toBe(true);
  });
});

describe("config-gated mint (zl:config / zl:navHandle)", () => {
  const mkReplies = () => {
    const replies: unknown[] = [];
    return { replies, reply: (payload: unknown) => replies.push(payload) };
  };
  const mkMsgEvent = (sourceUrl: string, msg: ControlMessage) => {
    const ev = {
      data: msg,
      ports: [{ postMessage: () => {}, close: () => {} }],
      source: { url: sourceUrl, id: "c1" },
    } as unknown as ExtendableMessageEvent;
    return ev;
  };
  const ctx = (ev: ExtendableMessageEvent, reply: (p: unknown) => void) => ({
    e: ev,
    reply,
    port: { postMessage: () => {}, close: () => {} },
    persistRoute: async () => {},
  });

  it("mints the query shape only behind the queryRoutes opt-in", async () => {
    const before = mkReplies();
    await dispatchCore(
      { type: "zl:navHandle", dest: "https://s.example/page?q=1" } as unknown as ControlMessage,
      ctx(mkMsgEvent(ORIGIN + "/", { type: "zl:navHandle" } as unknown as ControlMessage), before.reply),
    );
    /* default OFF: the NAVH form */
    expect((before.replies[0] as { url: string }).url.startsWith("/__zl_navh__/")).toBe(true);

    const cfg = mkReplies();
    await dispatchCore(
      { type: "zl:config", prefix: "/j/", queryRoutes: true } as unknown as ControlMessage,
      ctx(mkMsgEvent(ORIGIN + "/", { type: "zl:config" } as unknown as ControlMessage), cfg.reply),
    );
    expect((cfg.replies[0] as { ok: boolean; queryRoutes?: boolean }).queryRoutes).toBe(true);

    const after = mkReplies();
    await dispatchCore(
      { type: "zl:navHandle", dest: "https://s.example/page?q=1" } as unknown as ControlMessage,
      ctx(mkMsgEvent(ORIGIN + "/", { type: "zl:navHandle" } as unknown as ControlMessage), after.reply),
    );
    const url = (after.replies[0] as { url: string }).url;
    expect(url.startsWith("/page?q=1&zlNavh=")).toBe(true);
    expect(decodeClientUrl(new URL(url, ORIGIN))).toBe("https://s.example/page?q=1");

    /* zl:ping echoes the live opt-in */
    const ping = mkReplies();
    await dispatchCore(
      { type: "zl:ping" } as unknown as ControlMessage,
      ctx(mkMsgEvent(ORIGIN + "/", { type: "zl:ping" } as unknown as ControlMessage), ping.reply),
    );
    expect((ping.replies[0] as { queryRoutes?: boolean }).queryRoutes).toBe(true);
  });

  it("falls back to the NAVH form when the query mint refuses an engine path", async () => {
    const replies = mkReplies();
    await dispatchCore(
      { type: "zl:config", prefix: "/j/", queryRoutes: true } as unknown as ControlMessage,
      ctx(mkMsgEvent(ORIGIN + "/", { type: "zl:config" } as unknown as ControlMessage), replies.reply),
    );
    const nav = mkReplies();
    await dispatchCore(
      { type: "zl:navHandle", dest: "https://s.example/sw.js" } as unknown as ControlMessage,
      ctx(mkMsgEvent(ORIGIN + "/", { type: "zl:navHandle" } as unknown as ControlMessage), nav.reply),
    );
    expect((nav.replies[0] as { url: string }).url.startsWith("/__zl_navh__/")).toBe(true);
  });
});

describe("query-route navigation (handleFetch arms)", () => {
  it("serves the destination for a live query route (query kept, token never upstream)", async () => {
    const committed = buildQueryHandleUrl("https://www.google.com/search?q=what+is+a+hurricane")!;
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + committed, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe("https://www.google.com/search?q=what+is+a+hurricane");
  });

  it("re-mints an expired query handle on a GET navigation (#385 mirror)", async () => {
    const expired = buildQueryHandleUrl("https://www.google.com/search?q=sei", -1)!;
    const { ev, armed } = mkEvent(ORIGIN + expired, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(loc.startsWith("/search?q=sei&zlNavh=")).toBe(true);
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe("https://www.google.com/search?q=sei");
    /* nothing went upstream on the expired request itself */
    expect(transportMock.calls).toBe(0);
  });

  it("escapes a leading // run at mint and restores it on decode (#410)", () => {
    const minted = buildQueryHandleUrl("https://host.tld//p?q=1")!;
    expect(minted.startsWith("/%2Fp?q=1&zlNavh=")).toBe(true);
    const dec = decodeQueryHandle(new URL(minted, ORIGIN))!;
    expect(dec.destination).toBe("https://host.tld//p?q=1");
    expect(decodeClientUrl(new URL(minted, ORIGIN))).toBe("https://host.tld//p?q=1");
  });

  it("re-mints an expired query handle with the // run restored and re-escaped (#410)", async () => {
    const expired = buildQueryHandleUrl("https://host.tld//p?q=1", -1)!;
    const { ev, armed } = mkEvent(ORIGIN + expired, "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    const loc = served.headers.get("location")!;
    expect(loc.startsWith("/%2Fp?q=1&zlNavh=")).toBe(true);
    expect(decodeClientUrl(new URL(loc, ORIGIN))).toBe("https://host.tld//p?q=1");
    expect(transportMock.calls).toBe(0);
  });

  it("a garbage token does not shadow the honest route strand", async () => {
    const { ev, armed } = mkEvent(ORIGIN + "/j/" + "a".repeat(40) + "?zlNavh=zzz", "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    /* the ordinary chain keeps the engine-route verdict: a garbage
       param never widens or strands the route classification */
    expect(served.status).toBe(404);
  });
});

describe("vloc query-shape history virtualization", () => {
  function makeWin(href: string) {
    const state = { href };
    const u = () => new URL(state.href);
    const nat = {
      get href() {
        return state.href;
      },
      get hash() {
        return u().hash;
      },
      set hash(v: string) {
        const n = u();
        n.hash = v;
        state.href = n.href;
      },
      get origin() {
        return u().origin;
      },
      assign(x: string) {
        state.href = new URL(x, state.href).href;
      },
      replace(x: string) {
        state.href = new URL(x, state.href).href;
      },
      reload() {},
    };
    const hist = {
      pushState(_s: unknown, _t: string, x?: string | null) {
        if (x != null) state.href = new URL(x, state.href).href;
      },
      replaceState(_s: unknown, _t: string, x?: string | null) {
        if (x != null) state.href = new URL(x, state.href).href;
      },
    };
    const w: Record<string, unknown> = { location: nat, history: hist, addEventListener: () => {} };
    return w;
  }

  it("serves the real path and query from the native URL", () => {
    const w = makeWin(ORIGIN + "/ask?q=hi&zlNavh=tok123");
    applyVloc(w, undefined);
    const zl = w.__zl as { pathname: string; search: string; href: string };
    expect(zl.pathname).toBe("/ask");
    expect(zl.search).toBe("?q=hi");
    expect(zl.href).toBe(ORIGIN + "/ask?q=hi");
  });

  it("pushState commits the real path natively and keeps the token", () => {
    const w = makeWin(ORIGIN + "/ask?q=hi&zlNavh=tok123");
    applyVloc(w, undefined);
    (w.history as { pushState: (s: unknown, t: string, u?: string | null) => void }).pushState(
      null,
      "",
      "/conv/42?x=1",
    );
    const href = (w.location as { href: string }).href;
    expect(href).toBe(ORIGIN + "/conv/42?x=1&zlNavh=tok123");
    /* native fidelity: the committed pathname IS the real path */
    expect(new URL(href).pathname).toBe("/conv/42");
    const zl = w.__zl as { search: string };
    expect(zl.search).toBe("?x=1");
  });

  it("installs for a root query page (entry length 1)", () => {
    const w = makeWin(ORIGIN + "/?zlNavh=tok123");
    applyVloc(w, undefined);
    expect((w.__zl as { pathname: string }).pathname).toBe("/");
  });
});
