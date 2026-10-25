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
  inits: [] as Array<{ method?: string; headers?: Headers; body?: unknown } | undefined>,
}));

/* The transport fetch is controllable: the stale-cache tests gate the
   upstream round trip and count calls (dedup coverage). */
vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init?: { method?: string; headers?: Headers; body?: unknown }) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      /* snapshot: the hop loop mutates one shared Headers object across hops (the cross-origin Authorization drop), so a live reference would show hop N state at hop 0 */
      transportMock.inits.push(init ? { method: init.method, headers: new Headers(init.headers), body: init.body } : undefined);
      if (transportMock.gate) await transportMock.gate;
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { classifyRtype, forwardedHeaders, handleFetch, mergeRouteSearch, pageCacheMatch, reqDest, scheduleJarClientPrune, stripCrossOriginHopHeaders, withDeadline } from "../request";
import { setFingerprint, setSiteEnabled } from "../swstate";
import { establishContext, resolveRelative } from "../vctx";
import { VCTX } from "../swstate";
import { b64uEncode, encodeDestLegacy, setScheme } from "../codec";

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
    "https://e.example/hop",
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

  it("runs refresh redirect hops through the live-path upgrade gate (#376)", async () => {
    transportMock.queue = [
      new Response(null, { status: 302, headers: { location: "http://tracker.example/x" } }),
    ];
    const base = transportMock.urls.length;
    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request(PAGES[3]), (p) => {
      kept.push(p);
    });
    expect(hit?.status).toBe(200);
    await Promise.all(kept);
    /* the http: redirect target is upgraded before the next hop, like
       the live path */
    expect(transportMock.urls[base + 1]).toBe("https://tracker.example/x");
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


/* 2026-10-14 report: the hop chain buffers a stream body once before
   the loop, so 307/308 (and any body-carrying hop) replay it; the
   remaining one-shot case is an announced Content-Length over the
   cap, which surfaces the redirect to the page per spec. */
describe("redirect body replay (307/308, cap, Authorization)", () => {
  const ORIGIN = "https://w.example.org";

  const streamBody = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });

  const mkPostEvent = (target: string, body: unknown, headers: Headers) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: ORIGIN + encodeDestLegacy(target),
        method: "POST",
        mode: "navigate",
        destination: "document",
        credentials: "same-origin",
        referrer: "",
        body,
        headers,
      },
      clientId: "post-1",
      resultingClientId: "post-1-new",
      respondWith: (p: Promise<Response>) => void armed.push(p),
      waitUntil: () => {},
    } as unknown as FetchEvent;
    return { ev, armed };
  };

  const bytesOf = (b: unknown) =>
    new TextDecoder().decode(new Uint8Array(b as ArrayBuffer));

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.gate = undefined;
    transportMock.urls = [];
    transportMock.queue = [];
    transportMock.inits = [];
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
    });
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("no cache storage");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replays a streamed POST body on a 307 hop", async () => {
    transportMock.queue = [
      new Response(null, { status: 307, headers: { location: "https://site.example/next" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkPostEvent("https://site.example/form", streamBody(["he", "llo=1"]), new Headers());
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual(["https://site.example/form", "https://site.example/next"]);
    expect(transportMock.inits.map((i) => i?.method)).toEqual(["POST", "POST"]);
    expect(transportMock.inits[0]?.body).toBeInstanceOf(ArrayBuffer);
    expect(bytesOf(transportMock.inits[0]?.body)).toBe("hello=1");
    expect(bytesOf(transportMock.inits[1]?.body)).toBe("hello=1");
  });

  it("replays a streamed POST body on a 308 hop", async () => {
    transportMock.queue = [
      new Response(null, { status: 308, headers: { location: "https://site.example/next" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkPostEvent("https://site.example/form", streamBody(["a", "=2"]), new Headers());
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual(["https://site.example/form", "https://site.example/next"]);
    expect(bytesOf(transportMock.inits[1]?.body)).toBe("a=2");
  });

  it("surfaces the 307 when the announced body is over the replay cap", async () => {
    const headers = new Headers({ "content-length": String(33 * 1024 * 1024) });
    transportMock.queue = [
      new Response(null, { status: 307, headers: { location: "https://site.example/next" } }),
    ];
    const { ev, armed } = mkPostEvent("https://site.example/form", streamBody(["x"]), headers);
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(307);
    expect(transportMock.calls).toBe(1);
  });

  it("drops Authorization on a cross-origin hop, keeps it same-origin", async () => {
    transportMock.queue = [
      new Response(null, { status: 307, headers: { location: "https://other.example/x" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkPostEvent(
      "https://site.example/form",
      streamBody(["a"]),
      new Headers({ authorization: "Bearer tok" }),
    );
    handleFetch(ev);
    await armed[0]!;
    expect(transportMock.inits[0]?.headers?.get("authorization")).toBe("Bearer tok");
    expect(transportMock.inits[1]?.headers?.get("authorization")).toBe(null);

    transportMock.queue = [
      new Response(null, { status: 307, headers: { location: "https://site.example/next" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    transportMock.inits = [];
    const second = mkPostEvent(
      "https://site.example/form",
      streamBody(["a"]),
      new Headers({ authorization: "Bearer tok" }),
    );
    handleFetch(second.ev);
    await second.armed[0]!;
    expect(transportMock.inits[1]?.headers?.get("authorization")).toBe("Bearer tok");
  });

  it("withDeadline aborts the upstream controller when the deadline fires", async () => {
    const ctl = new AbortController();
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 25, "no first byte", ctl)).rejects.toThrow(
      "no first byte",
    );
    expect(ctl.signal.aborted).toBe(true);
  });
});

/* Storage Access Headers ship in Chrome 133: the persona claim decides
   whether Sec-Fetch-Storage-Access rides a credentialed cross-site
   fetch (the physical browser's value is never forwarded). */
describe("Sec-Fetch-Storage-Access persona synthesis (Chrome 133+)", () => {
  const UA149 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
  const UA124 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const req = (credentials: RequestCredentials) =>
    ({
      method: "GET",
      mode: "cors",
      destination: "script",
      credentials,
      headers: new Headers(),
      referrer: "",
    }) as unknown as Request;

  afterEach(() => {
    setFingerprint(null);
  });

  it("synthesizes none for a 133+ persona on a credentialed cross-site fetch", () => {
    expect(setFingerprint({ userAgent: UA149 }).ok).toBe(true);
    const out = forwardedHeaders(req("include"), "https://cdn.other.example/x.js", "https://site.example/");
    expect(out.get("sec-fetch-site")).toBe("cross-site");
    expect(out.get("sec-fetch-storage-access")).toBe("none");
  });

  it("omits it for a pre-133 persona, same-site targets and credential-less fetches", () => {
    expect(setFingerprint({ userAgent: UA124 }).ok).toBe(true);
    expect(
      forwardedHeaders(req("include"), "https://cdn.other.example/x.js", "https://site.example/").get(
        "sec-fetch-storage-access",
      ),
    ).toBe(null);
    expect(setFingerprint({ userAgent: UA149 }).ok).toBe(true);
    expect(
      forwardedHeaders(req("include"), "https://site.example/x.js", "https://site.example/").get(
        "sec-fetch-storage-access",
      ),
    ).toBe(null);
    expect(
      forwardedHeaders(req("omit"), "https://cdn.other.example/x.js", "https://site.example/").get(
        "sec-fetch-storage-access",
      ),
    ).toBe(null);
  });
});

/* #186: the engine-side hop chain runs the request gates for every
   hop target, not only the first. #194: a cross-origin hop drops the
   page-minted Referer and the headers injected for the previous
   host. */
describe("redirect hop gates and cross-origin header scoping (#186, #194)", () => {
  const ORIGIN = "https://w.example.org";

  const mkEvent = (routeUrl: string, clientId: string, referrer: string) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: routeUrl,
        method: "GET",
        mode: "navigate",
        destination: "document",
        credentials: "same-origin",
        referrer,
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
    transportMock.inits = [];
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
    });
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("no cache storage");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSiteEnabled("blocked.example", true);
  });

  it("keeps profile UA and requested hints together, with native opt-out (#429/#437)", async () => {
    const nativeUa = "Mozilla/5.0 (X11; CrOS x86_64 16123.0.0) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";
    const profileUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.7827.12 Safari/537.36";
    try {
      for (const matchUserAgent of [false, true]) {
        expect(setFingerprint({ userAgent: profileUa, matchUserAgent }).ok).toBe(true);
        transportMock.inits = [];
        transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
        const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/identity-" + matchUserAgent), "identity-437", "");
        (ev.request as any).headers = new Headers({ "user-agent": nativeUa, "sec-ch-ua-platform": '"Chrome OS"',
          "sec-ch-ua-full-version": '"154.0.1234.2"', "sec-ch-ua-model": '"physical-device"' });
        handleFetch(ev);
        expect((await armed[0]!).status).toBe(200);
        const sent = transportMock.inits[0]?.headers!;
        expect(sent.get("user-agent")).toBe(matchUserAgent ? profileUa : nativeUa);
        expect(sent.get("sec-ch-ua-platform")).toBe(matchUserAgent ? '"Windows"' : '"Chrome OS"');
        expect(sent.get("sec-ch-ua-full-version")).toBe(matchUserAgent ? '"149.0.7827.12"' : '"154.0.1234.2"');
        expect(sent.get("sec-ch-ua-model")).toBe(matchUserAgent ? null : '"physical-device"');
      }
    } finally { setFingerprint(null); }
  });

  it("blocks a redirect hop to a disabled site (#186)", async () => {
    setSiteEnabled("blocked.example", false);
    transportMock.queue = [
      new Response(null, { status: 302, headers: { location: "https://blocked.example/x" } }),
      new Response("no", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "hop-186", "");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(403);
    expect(transportMock.calls).toBe(1);
    expect(transportMock.urls).toEqual(["https://site.example/"]);
  });

  it("allows a same-origin hop to a disabled site of another host (#186 control)", async () => {
    setSiteEnabled("blocked.example", false);
    transportMock.queue = [
      new Response(null, { status: 302, headers: { location: "https://site.example/next" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "hop-186b", "");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.calls).toBe(2);
  });

  it("drops the Referer on a cross-origin hop, keeps it same-origin (#194)", async () => {
    transportMock.queue = [
      new Response(null, { status: 302, headers: { location: "https://other.example/x" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    const ref = ORIGIN + encodeDestLegacy("https://page.example/a");
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "hop-194", ref);
    handleFetch(ev);
    await armed[0]!;
    expect(transportMock.inits[0]?.headers?.get("referer")).toBe("https://page.example/a");
    expect(transportMock.inits[1]?.headers?.get("referer")).toBe(null);

    transportMock.queue = [
      new Response(null, { status: 302, headers: { location: "https://site.example/next" } }),
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    transportMock.inits = [];
    const second = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "hop-194b", ref);
    handleFetch(second.ev);
    await second.armed[0]!;
    expect(transportMock.inits[1]?.headers?.get("referer")).toBe("https://page.example/a");
  });

  it("strips referer and injected keys, keeps the rest (#194 unit)", () => {
    const h = new Headers({
      referer: "https://a.example/x",
      "x-inject": "1",
      "x-mine": "2",
      authorization: "Bearer t",
    });
    stripCrossOriginHopHeaders(h, ["x-inject"]);
    expect(h.get("referer")).toBe(null);
    expect(h.get("x-inject")).toBe(null);
    expect(h.get("x-mine")).toBe("2");
    expect(h.get("authorization")).toBe("Bearer t");
  });
});


/* 2026-10-16 live strand (Brave Ask): a JS-literal mint encodes the
   full destination - query inside the token. The Ask SPA then does a
   query-only relative navigation ("?q=..."), so the route search must
   REPLACE the token-encoded query (browser "?x" resolution), never
   concatenate it ("...?a=1?b=2" strands the new question upstream). */
describe("route search replaces a token-encoded query (Brave Ask strand)", () => {
  const ORIGIN = "https://w.example.org";

  const mkEvent = (routeUrl: string, clientId: string) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: routeUrl,
        method: "GET",
        mode: "navigate",
        destination: "document",
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
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("no cache storage");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces the token-encoded query with the route search", async () => {
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const route =
      ORIGIN + encodeDestLegacy("https://site.example/ask?q=old+question&source=web");
    const { ev, armed } = mkEvent(route + "?q=new+question&conversation=", "ask-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls).toEqual([
      "https://site.example/ask?q=new+question&conversation=",
    ]);
  });

  it("keeps the token-encoded query when the route carries no search", async () => {
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const route =
      ORIGIN + encodeDestLegacy("https://site.example/ask?q=old+question&source=web");
    const { ev, armed } = mkEvent(route, "ask-2");
    handleFetch(ev);
    await armed[0]!;
    expect(transportMock.urls).toEqual([
      "https://site.example/ask?q=old+question&source=web",
    ]);
  });

  it("appends the route search onto a query-free decode (#38 shape)", async () => {
    transportMock.queue = [new Response("ok", { headers: { "content-type": "text/plain" } })];
    const route = ORIGIN + encodeDestLegacy("https://site.example/ask") + "?q=x";
    const { ev, armed } = mkEvent(route, "ask-3");
    handleFetch(ev);
    await armed[0]!;
    expect(transportMock.urls).toEqual(["https://site.example/ask?q=x"]);
  });

  it("mergeRouteSearch unit: replace, append, and no-op shapes", () => {
    expect(mergeRouteSearch("https://s.example/a?b=1", "?c=2")).toBe("https://s.example/a?c=2");
    expect(mergeRouteSearch("https://s.example/a", "?c=2")).toBe("https://s.example/a?c=2");
    expect(mergeRouteSearch("https://s.example/a?b=1", "")).toBe("https://s.example/a?b=1");
  });
});

/* #366: the prune matchAll must count worker and shared-worker clients,
   or their jar-root bindings are pruned every 128 fetches. */
describe("jar client prune options (#366)", () => {
  const ORIGIN = "https://pr.example";

  it("prunes with includeUncontrolled and type all", async () => {
    let seen: Record<string, unknown> | null = null;
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: {
        get: async () => null,
        matchAll: async (o: Record<string, unknown>) => {
          seen = o;
          return [];
        },
      },
    });
    /* scheduleJarClientPrune fires every 128th call; the module counter
       is shared with the tests above, so drive a full window. */
    for (let i = 0; i < 128; i++) scheduleJarClientPrune();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual({ includeUncontrolled: true, type: "all" });
  });
});

/* #389: a route-shaped same-origin path nothing decodes must be
   answered by the engine, never passed to the origin: LB answers a
   /zl/ hit with a misleading 503 "Engine offline". */
describe("escape seam fails closed on route-shaped paths (#389)", () => {
  const ORIGIN = "https://esc.example";

  const mkEvent = (routeUrl: string, clientId: string) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: routeUrl,
        method: "GET",
        mode: "cors",
        destination: "empty",
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
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
    });
    vi.stubGlobal("caches", { open: async () => { throw new Error("no cache storage"); } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers an undecodable /zl/ tail from the engine, not the origin", async () => {
    const { ev, armed } = mkEvent(ORIGIN + "/zl/w44garbg", "esc-1");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(404);
    expect(transportMock.calls).toBe(0);
  });

  it("keeps the #101 passthrough for non-route-shaped paths", async () => {
    vi.stubGlobal("fetch", async () => new Response("origin-asset", { status: 200 }));
    const { ev, armed } = mkEvent(ORIGIN + "/assets/index-9f2.js", "esc-2");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("origin-asset");
  });
});

/* Wave 46 follow-up (the split-origin URL-bar strand): a legacy
   /zl/<b64u> route minted under a prefix this worker has not
   configured (LB split mode: the app worker owns /zl/, the
   content worker keeps its own prefix) reaches the escape seam,
   where the settled client context used to resolve the ROUTE PATH
   against the previous page's virtual origin - a guaranteed
   upstream 404 for every URL-bar navigation once the previous
   page had settled. The legacy decode wins ahead of the context
   recovery; genuine escaped relative paths are untouched. */
describe("split-origin legacy routes decode ahead of the context recovery", () => {
  const ORIGIN = "https://esc46.example";

  const mkEvent = (routeUrl: string, clientId: string) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: routeUrl,
        method: "GET",
        mode: "navigate",
        destination: "document",
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
    transportMock.urls = [];
    transportMock.queue = [
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    setScheme("/j/");
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
    });
    vi.stubGlobal("caches", { open: async () => { throw new Error("no cache storage"); } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the decoded destination, never the previous page's virtual origin", async () => {
    establishContext(VCTX, "esc-46a", "https://prev.example/dir/page.html");
    const tail = b64uEncode(new TextEncoder().encode("https://target.example/path?q=1"));
    const { ev, armed } = mkEvent(ORIGIN + "/zl/" + tail, "esc-46a");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe("https://target.example/path?q=1");
  });

  it("keeps the settled-context recovery for a genuine escaped path", async () => {
    establishContext(VCTX, "esc-46b", "https://prev.example/dir/page.html");
    const { ev, armed } = mkEvent(ORIGIN + "/dir/img.png", "esc-46b");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.urls[0]).toBe("https://prev.example/dir/img.png");
  });
});
