import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The request lifecycle moved out of sw.ts (issue #82): the engine
   module no longer registers the service worker, so its seams are
   directly importable under vitest (the entrypoint stays
   unimportable here by design: its module body wires the worker).
   The transport module is mocked the way control.test.ts mocks it:
   the vendored libcurl bundle is a browser/wasm artifact, and these
   tests pin classification and pass-through, not transport. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  gate: undefined as undefined | Promise<void>,
  urls: [] as string[],
  queue: [] as Response[],
}));

/* The transport fetch is controllable: the stale-cache tests gate the
   upstream round trip and count calls (dedup coverage). */
vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      if (transportMock.gate) await transportMock.gate;
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { classifyRtype, handleFetch, pageCacheMatch, reqDest, withDeadline } from "../request";
import { establishContext, resolveRelative } from "../vctx";
import { VCTX } from "../swstate";
import { encodeDestLegacy } from "../codec";

describe("reqDest (#82 seam)", () => {
  it("falls back to sec-fetch-dest when destination is empty (Firefox, #40)", () => {
    const req = new Request("https://e.example/x", {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(reqDest(req)).toBe("document");
  });

  it("maps an absent header to the honest empty destination", () => {
    expect(reqDest(new Request("https://e.example/x"))).toBe("empty");
  });

  it("lowercases the header value", () => {
    const req = new Request("https://e.example/x", {
      headers: { "sec-fetch-dest": "IFRAME" },
    });
    expect(reqDest(req)).toBe("iframe");
  });
});

describe("classifyRtype (#82 seam)", () => {
  it("classifies by destination first, content type second, OTHER last", () => {
    expect(classifyRtype("document", "")).toBe("DOCUMENT");
    expect(classifyRtype("style", "")).toBe("STYLE");
    expect(classifyRtype("", "text/css")).toBe("STYLE");
    expect(classifyRtype("script", "text/plain")).toBe("SCRIPT");
    expect(classifyRtype("", "text/javascript;charset=utf-8")).toBe("SCRIPT");
    expect(classifyRtype("image", "")).toBe("IMAGE");
    expect(classifyRtype("", "image/webp")).toBe("IMAGE");
    expect(classifyRtype("font", "")).toBe("FONT");
    expect(classifyRtype("", "font/woff2")).toBe("FONT");
    expect(classifyRtype("audio", "")).toBe("MEDIA");
    expect(classifyRtype("", "video/mp4")).toBe("MEDIA");
    expect(classifyRtype("worker", "")).toBe("WORKER");
    expect(classifyRtype("sharedworker", "")).toBe("WORKER");
    expect(classifyRtype("serviceworker", "")).toBe("WORKER");
    expect(classifyRtype("manifest", "")).toBe("MANIFEST");
    expect(classifyRtype("websocket", "")).toBe("WEBSOCKET");
    expect(classifyRtype("eventsource", "")).toBe("EVENTSOURCE");
    expect(classifyRtype("", "application/wasm")).toBe("WASM");
    expect(classifyRtype("empty", "text/plain")).toBe("FETCH");
    expect(classifyRtype("audioworklet", "text/plain")).toBe("OTHER");
  });
});

describe("handleFetch synchronous pass-through checks (#82 seam)", () => {
  it("leaves opaque-scheme URLs to the browser without arming respondWith", () => {
    const armed: unknown[] = [];
    const ev = {
      request: new Request("data:text/plain,hi"),
      respondWith: (p: unknown) => void armed.push(p),
    } as unknown as FetchEvent;
    handleFetch(ev);
    expect(armed).toEqual([]);
  });

  it("leaves blob: URLs to the browser without arming respondWith", () => {
    const armed: unknown[] = [];
    const ev = {
      request: new Request("blob:https://e.example/1"),
      respondWith: (p: unknown) => void armed.push(p),
    } as unknown as FetchEvent;
    handleFetch(ev);
    expect(armed).toEqual([]);
  });
});


describe("classifyRtype document destinations (#103)", () => {
  it("classifies iframe/frame/fencedframe/embed/object/xslt as DOCUMENT", () => {
    for (const d of ["iframe", "frame", "fencedframe", "embed", "object", "xslt"]) {
      expect(classifyRtype(d, "")).toBe("DOCUMENT");
    }
    expect(classifyRtype("document", "")).toBe("DOCUMENT");
  });

  it("destination still wins over content type; empty stays FETCH", () => {
    expect(classifyRtype("iframe", "text/html")).toBe("DOCUMENT");
    expect(classifyRtype("style", "text/html")).toBe("STYLE");
    expect(classifyRtype("empty", "")).toBe("FETCH");
  });
});

describe("withDeadline (#107)", () => {
  it("returns the settled value or rejection inside the deadline", async () => {
    await expect(withDeadline(Promise.resolve(7), 5000, "x")).resolves.toBe(7);
    await expect(
      withDeadline(Promise.reject(new Error("upstream")), 5000, "x"),
    ).rejects.toThrow("upstream");
  });

  it("rejects with the deadline message when the upstream never answers", async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 25, "no first byte")).rejects.toThrow(
      "no first byte",
    );
  });

  it("a non-positive deadline passes the promise through untouched", async () => {
    const p = Promise.resolve("ok");
    expect(withDeadline(p, 0, "x")).toBe(p);
  });
});

describe("pageCacheMatch stale-while-revalidate dedup", () => {
  /* A Map-backed cache bucket: pageCacheMatch only needs
     open/match/put/delete/keys on the one bucket. */
  const pagesStub = (urls: string[]) => {
    const store = new Map(urls.map((u) => [u, staleEntry()] as const));
    const cache = {
      match: async (req: Request) => store.get(req.url),
      put: async (req: Request, resp: Response) => void store.set(req.url, resp),
      delete: async (req: Request) => store.delete(req.url),
      keys: async () => [...store.keys()].map((u) => new Request(u)),
    };
    return { open: async () => cache };
  };

  /* No cache-control header: the default 10-minute TTL applies, so a
     cached-at 20 minutes old is stale. */
  const staleEntry = (): Response =>
    new Response("<html></html>", {
      headers: {
        "content-type": "text/html",
        "x-zl-cached-at": String(Date.now() - 20 * 60 * 1000),
      },
    });

  const PAGES = [
    "https://e.example/page",
    "https://e.example/other",
    "https://e.example/again",
  ];

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.gate = undefined;
    vi.stubGlobal("caches", pagesStub(PAGES));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the stale hit without waiting on the upstream refresh", async () => {
    transportMock.gate = new Promise(() => {}); /* never settles */
    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request(PAGES[0]), (p) => {
      kept.push(p);
    });
    expect(hit?.status).toBe(200);
    /* the refresh rides waitUntil, it must not block the response */
    expect(kept.length).toBe(1);
    expect(transportMock.calls).toBe(1);
  });

  it("coalesces concurrent stale hits into one upstream fetch", async () => {
    let release!: () => void;
    transportMock.gate = new Promise<void>((res) => {
      release = res;
    });
    const hits = await Promise.all([
      pageCacheMatch(new Request(PAGES[1])),
      pageCacheMatch(new Request(PAGES[1])),
      pageCacheMatch(new Request(PAGES[1])),
    ]);
    expect(hits.every((h) => h?.status === 200)).toBe(true);
    expect(transportMock.calls).toBe(1);
    release();
  });

  it("starts a new refresh once the in-flight one has settled", async () => {
    let release!: () => void;
    transportMock.gate = new Promise<void>((res) => {
      release = res;
    });
    const kept: Promise<unknown>[] = [];
    await pageCacheMatch(new Request(PAGES[2]), (p) => {
      kept.push(p);
    });
    expect(transportMock.calls).toBe(1);
    release();
    await Promise.all(kept);
    transportMock.gate = undefined;
    await pageCacheMatch(new Request(PAGES[2]), (p) => {
      kept.push(p);
    });
    expect(transportMock.calls).toBe(2);
  });
});

/* #110: a navigation the hop chain redirects must leave the client's
   virtual context on the final destination, or every relative URL the
   page builds resolves against the pre-redirect origin (google.com vs
   www.google.com: the apex 404s /async/hpba where www serves the AI
   Mode panel batch). Plain-object requests/events like the pass-through
   tests above: mode "navigate" is constructor-illegal on a node Request,
   and the navigation path reads FetchEvent fields only. */
describe("redirect finalization updates the client virtual context (#110)", () => {
  const ORIGIN = "https://w.example.org";

  const mkEvent = (routeUrl: string, clientId: string, mode: string, destination: string) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: routeUrl,
        method: "GET",
        mode,
        destination,
        credentials: "same-origin",
        referrer: "",
        body: null,
        headers: new Headers(),
      },
      clientId,
      resultingClientId: clientId + "-new",
      respondWith: (p: Promise<Response>) => void armed.push(p),
      waitUntil: () => {},
    } as unknown as FetchEvent;
    return { ev, armed };
  };

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.gate = undefined;
    transportMock.urls = [];
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

  it("replaces the context with the post-redirect destination after a 301", async () => {
    transportMock.queue = [
      new Response(null, {
        status: 301,
        headers: { location: "https://www.site.example/" },
      }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "nav-1", "navigate", "document");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual(["https://site.example/", "https://www.site.example/"]);
    expect(resolveRelative(VCTX, "nav-1-new", "/async/hpba?yv=3")).toBe(
      "https://www.site.example/async/hpba?yv=3",
    );
  });

  it("keeps the pre-redirect target when the chain does not redirect", async () => {
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "nav-2", "navigate", "document");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual(["https://site.example/"]);
    expect(resolveRelative(VCTX, "nav-2-new", "/x")).toBe("https://site.example/x");
  });

  it("never rewrites the document context from a subresource redirect", async () => {
    establishContext(VCTX, "doc-1", "https://site.example/");
    transportMock.queue = [
      new Response(null, { status: 302, headers: { location: "https://cdn.site.example/m.js" } }),
      new Response("js", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/lib.js"), "doc-1", "cors", "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(resolveRelative(VCTX, "doc-1", "/y")).toBe("https://site.example/y");
  });
});
