import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Issue #687 regression: the #685 context-less realm fallback
   (fallbackRealmDest -> latestWindowContext) resolved a blob realm's
   root-relative path against the GLOBALLY most-recent window context.
   With two proxied tabs in one engine context (site B open first, site A
   opened last), a blob worker spawned by the site-B page was routed to
   site A - and the no-initiator cookie path attached site A's jar to the
   upstream request, fully readable by the spawning page (the blob realm
   shares the engine origin).

   Contract pinned here:
   - TWO live window contexts on DIFFERENT origins => the fallback is
     ambiguous => fail closed to the #101 passthrough; the engine
     transport must never see the other site's dest (nor its cookies).
   - ONE live window context (or several on the SAME origin) => the
     fallback resolves against it: the #685 Turnstile-boot behavior in a
     single proxied tab is preserved.
   - Cookie audit: the jar attach is keyed by the resolved dest only, so
     a context-less (no-initiator) request can only ever carry the
     cookies of the dest it was resolved to - never another site's. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  urls: [] as string[],
  cookies: [] as (string | null)[],
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init?: { headers?: Headers }) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      transportMock.cookies.push(init?.headers?.get("cookie") ?? null);
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    process(s: string) { return s; }
    finish() { return ""; }
    add_injection(_p: string) {}
    set_blocked_hosts(_h: string[]) {}
    set_lazy_images() {}
  }
  class JsCssRewriter {
    process(s: string) { return s; }
    finish() { return ""; }
  }
  return {
    JsRewriter,
    JsCssRewriter,
    rewriteCss: (css: string) => css,
    rewriteJsBody: (js: string) => js,
    globalsStats: () => "0,0,0",
    default: async () => {},
  };
});

import { handleFetch } from "../request";

import { encodeDestLegacy } from "../codec";

import { initTransform, type TransformDeps } from "../transform";

import { VCTX } from "../swstate";

import { applySetCookie, cookieHeaderFor, cookiesResetForTests } from "../cookies";

const ORIGIN = "https://w.example.org";

const siteScript = vi.fn(async (_base: string) => null);

function transformDeps(): TransformDeps {
  return {
    routeReady: () => Promise.resolve(),
    routeKey: () => "a2V5",
    fpScript: () => null,
    siteScript,
    setDegraded: vi.fn((_reason: string) => {}),
    lazyImages: () => false,
  };
}

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

describe("#687: context-less realm fallback never crosses sites", () => {
  const mkEvent = (
    url: string,
    mode: string,
    destination: string,
    referrer: string,
    clientId: string,
    credentials = "include",
    resultingClientId?: string,
  ) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url,
        method: "GET",
        mode,
        destination,
        credentials,
        referrer,
        body: null,
        headers: new Headers(),
      },
      clientId,
      resultingClientId: resultingClientId ?? clientId,
      respondWith: (p: Promise<Response>) => void armed.push(p),
      waitUntil: () => {},
    } as unknown as FetchEvent;
    return { ev, armed };
  };

  let clientsMap: Record<string, { type: string; url: string; frameType?: string }>;
  let fetchStub: ReturnType<typeof vi.fn>;

  const HTML = "<!DOCTYPE html><html><head></head><body>ok</body></html>";

  async function establish(site: string, clientId: string): Promise<void> {
    transportMock.queue.push(new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }));
    const nav = mkEvent(ORIGIN + encodeDestLegacy(site), "navigate", "document", "", clientId, "include", clientId);
    handleFetch(nav.ev);
    await nav.armed[0]!;
    expect(VCTX.has(clientId)).toBe(true);
  }

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.urls = [];
    transportMock.cookies = [];
    transportMock.queue = [];
    VCTX.clear();
    cookiesResetForTests();
    clientsMap = {};
    siteScript.mockClear();
    initTransform(transformDeps());
    fetchStub = vi.fn(async () => new Response("shell-asset", { status: 200, headers: { "content-type": "application/javascript" } }));
    vi.stubGlobal("fetch", fetchStub);
    vi.stubGlobal("self", {
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
      registration: { scope: ORIGIN + "/" },
      clients: {
        get: async (id: string) => clientsMap[id] ?? null,
        matchAll: async () => [] as unknown[],
      },
    });
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("no cache storage");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    VCTX.clear();
    cookiesResetForTests();
  });

  it("two tabs on DIFFERENT sites: a blob worker's /cdn-cgi/ request keeps the #101 passthrough and never rides the engine transport to the other site (with its cookies)", async () => {
    /* tab B (example.com) opened first, tab A (en.wikipedia.org) last:
       the globally-latest window context is wikipedia - exactly the
       scout's live repro. */
    await establish("https://example.com/", "doc-b");
    await establish("https://en.wikipedia.org/", "doc-a");
    expect(VCTX.size).toBe(2);

    /* site jars hold cookies for both virtual sites */
    applySetCookie("https://en.wikipedia.org/", resp(["cf_clearance=wiki-secret; Path=/"]));
    applySetCookie("https://example.com/", resp(["sid=ex; Path=/"]));

    /* a blob worker spawned by the example.com tab (opaque client URL,
       no referrer, no context) asks for a root-relative site path */
    clientsMap["blob-w7"] = { type: "worker", url: "blob:" + ORIGIN + "/9f2c-wprobe-7" };
    transportMock.queue.push(new Response("wiki-404", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }));
    const sub = mkEvent(ORIGIN + "/cdn-cgi/zl-scout-wprobe-7", "no-cors", "script", "", "blob-w7", "include");
    handleFetch(sub.ev);
    expect(sub.armed.length).toBe(1);
    const served = await sub.armed[0]!;

    /* FAIL-CLOSED: the browser serves it (passthrough), the engine
       transport never sees the request at all - so neither
       en.wikipedia.org's dest nor its jar cookies can ride upstream */
    expect(await served.text()).toBe("shell-asset");
    /* the passthrough went to the browser fetch with the engine-origin
       URL (not to the engine transport) */
    expect(fetchStub.mock.calls.some((c) => (c[0] as { url?: string })?.url === ORIGIN + "/cdn-cgi/zl-scout-wprobe-7")).toBe(true);
    /* the only engine-transport rows are the two tab navigations' site
       roots - no /cdn-cgi/ dest on any site, least of all the other tab's */
    expect(transportMock.urls.some((u) => u.includes("/cdn-cgi/"))).toBe(false);
    expect(transportMock.urls.some((u) => u.includes("wikipedia.org/cdn-cgi"))).toBe(false);
    expect(transportMock.urls.some((u) => u.includes("example.com/cdn-cgi"))).toBe(false);
  });

  it("two tabs on DIFFERENT sites: a blob challenge IFRAME (nested window client) also keeps the passthrough", async () => {
    await establish("https://example.com/", "doc-b");
    await establish("https://en.wikipedia.org/", "doc-a");

    clientsMap["blob-f1"] = { type: "window", url: "blob:" + ORIGIN + "/9f2c-iframe", frameType: "nested" };
    const sub = mkEvent(ORIGIN + "/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=r1", "no-cors", "script", "", "blob-f1", "include");
    handleFetch(sub.ev);
    const served = await sub.armed[0]!;
    expect(await served.text()).toBe("shell-asset");
    expect(fetchStub.mock.calls.some((c) => (c[0] as { url?: string })?.url === ORIGIN + "/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=r1")).toBe(true);
    expect(transportMock.urls.some((u) => u.includes("/cdn-cgi/"))).toBe(false);
    expect(transportMock.urls.some((u) => u.includes("wikipedia.org/cdn-cgi"))).toBe(false);
  });

  it("#685 preserved: a SINGLE proxied tab - the blob worker's /cdn-cgi/ script still resolves against that tab's site (Turnstile boot)", async () => {
    await establish("https://example.com/", "doc-b");
    expect(VCTX.size).toBe(1);

    clientsMap["blob-w1"] = { type: "worker", url: "blob:" + ORIGIN + "/9f2c-boot" };
    transportMock.queue.push(new Response("window._cf_chl_opt={};", { status: 200, headers: { "content-type": "application/javascript" } }));
    const sub = mkEvent(ORIGIN + "/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=r1", "no-cors", "script", "", "blob-w1", "include");
    handleFetch(sub.ev);
    const served = await sub.armed[0]!;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("window._cf_chl_opt={};");
    /* resolved to the tab's OWN site, never another site's dest */
    expect(transportMock.urls).toContain("https://example.com/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=r1");
    expect(transportMock.urls.some((u) => u.includes("wikipedia.org"))).toBe(false);
  });

  it("two tabs on the SAME site: the fallback still resolves (same-origin ambiguity is safe)", async () => {
    await establish("https://example.com/one", "doc-b1");
    await establish("https://example.com/two", "doc-b2");

    clientsMap["blob-w2"] = { type: "worker", url: "blob:" + ORIGIN + "/9f2c-same" };
    transportMock.queue.push(new Response("ok", { status: 200, headers: { "content-type": "application/javascript" } }));
    const sub = mkEvent(ORIGIN + "/cdn-cgi/x.js", "no-cors", "script", "", "blob-w2", "include");
    handleFetch(sub.ev);
    const served = await sub.armed[0]!;
    expect(await served.text()).toBe("ok");
    expect(transportMock.urls).toContain("https://example.com/cdn-cgi/x.js");
  });

  it("cookie audit: a no-initiator (context-less) request can only ever carry the jar of the dest it was resolved to", () => {
    applySetCookie("https://en.wikipedia.org/", resp(["cf_clearance=wiki-secret; Path=/"]));
    applySetCookie("https://example.com/", resp(["sid=ex; Path=/"]));
    const ctx = { clientId: "blob-w7", initiator: undefined, navigation: false };
    /* resolved to wikipedia => only wikipedia's cookies */
    expect(cookieHeaderFor("https://en.wikipedia.org/cdn-cgi/zl-scout-wprobe-7", ctx)).toBe("cf_clearance=wiki-secret");
    /* resolved to example.com => only example.com's cookies */
    expect(cookieHeaderFor("https://example.com/cdn-cgi/zl-scout-wprobe-7", ctx)).toBe("sid=ex");
    /* a passthrough never reaches this seam at all; and no dest ever
       matches the other site's jar */
    expect(cookieHeaderFor("https://en.wikipedia.org/", { clientId: "blob-w7" })).toBe("cf_clearance=wiki-secret");
    expect(cookieHeaderFor("https://other.example/", ctx)).toBeNull();
  });
});
