import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* CF managed-challenge serving contracts (live repro: rumble.com,
   4chan.org interstitials corrupted by rewrite; discord.com/login
   challenge script MIME-blocked). Two defects pinned here:

   D1: a cf-mitigated: challenge response must serve VERBATIM (the
   NativeReason CF_CHALLENGE_VERBATIM existed in the taxonomy but no
   code path emitted it, so interstitials got DOCUMENT_REWRITE_REQUIRED
   and the bootstrap splice). Planner-level + handleFetch-level.

   D2: a root-relative site path (/cdn-cgi/... challenge script) issued
   by a context-less child realm of a proxied page (blob: challenge
   iframe/worker - no decodable client URL, opaque referrer) used to hit
   the #101 passthrough, whose origin-server 404 carries no content-type
   + nosniff and MIME-blocks the script. It must resolve against the
   most recent live window context; the host shell (top-level, non-engine
   path) must keep the passthrough so /main.js etc. still serve from dist. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  urls: [] as string[],
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
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
import { decideTransport, planResponseTransit } from "../transit";
import { initTransform, type TransformDeps } from "../transform";
import { VCTX } from "../swstate";

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

describe("D1: cf-mitigated challenge documents decide verbatim (planner)", () => {
  const site = "https://site.example/";

  it("demotes a rewrite-fallback document to NativeTransit CF_CHALLENGE_VERBATIM when the response carries cf-mitigated: challenge", () => {
    const plan = planResponseTransit(
      decideTransport(site, "document"),
      "text/html; charset=utf-8",
      "document",
      site,
      null,
      { get: (n: string) => (n.toLowerCase() === "cf-mitigated" ? "challenge" : null) },
    );
    expect(plan.decision).toEqual({ mode: "NativeTransit", reason: "CF_CHALLENGE_VERBATIM" });
    expect(plan.strategy).toBe("native");
    expect(plan.evidence).toBe("challenge-namespace");
  });

  it("leaves the document rewrite-required when no response headers are given (old call shape) or the flag is absent", () => {
    const noHeaders = planResponseTransit(decideTransport(site, "document"), "text/html", "document", site);
    expect(noHeaders.decision).toEqual({ mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" });
    const otherFlag = planResponseTransit(decideTransport(site, "document"), "text/html", "document", site, null, { get: () => "blocked" });
    expect(otherFlag.decision.mode).toBe("RewriteFallback");
  });

  it("never turns a Blocked decision transportable, even challenge-flagged", () => {
    const plan = planResponseTransit(
      { mode: "Blocked", reason: "BLOCKED_RULES" },
      "text/html",
      "document",
      site,
      null,
      { get: () => "challenge" },
    );
    expect(plan.decision.mode).toBe("Blocked");
  });

  it("still exempts /cdn-cgi/ paths without needing the header", () => {
    const cgi = "https://site.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=x";
    const plan = planResponseTransit(decideTransport(cgi, "script"), "application/javascript", "script", cgi);
    expect(plan.decision).toEqual({ mode: "NativeTransit", reason: "CDN_CGI_NATIVE" });
  });
});

describe("D1/D2: handleFetch serving (integration)", () => {
  const mkEvent = (
    url: string,
    mode: string,
    destination: string,
    referrer: string,
    clientId: string,
    resultingClientId?: string,
  ) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url,
        method: "GET",
        mode,
        destination,
        credentials: "same-origin",
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

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.urls = [];
    transportMock.queue = [];
    VCTX.clear();
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
  });

  const CHALLENGE_HTML =
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script nonce="abc">window._cf_chl_opt={cH:"x"};</script></body></html>';

  it("serves a cf-mitigated challenge document byte-verbatim (no bootstrap splice)", async () => {
    transportMock.queue.push(
      new Response(CHALLENGE_HTML, {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" },
      }),
    );
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-1");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(403);
    const body = await served.text();
    expect(body).toBe(CHALLENGE_HTML);
    expect(body).not.toContain("__ZL");
  });

  it("control: an ordinary 200 HTML document is still rewritten (bootstrap spliced)", async () => {
    const DOC = "<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>";
    transportMock.queue.push(new Response(DOC, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const body = await served.text();
    expect(body).toContain("__ZL");
    expect(body).not.toBe(DOC);
  });

  it("D2: resolves a context-less child realm's root-relative /cdn-cgi/ script against the open proxied page", async () => {
    /* establish the proxied page's context with a document navigation */
    transportMock.queue.push(new Response("<!DOCTYPE html><html><head></head><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const nav = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-1", "doc-1");
    handleFetch(nav.ev);
    await nav.armed[0]!;
    expect(VCTX.has("doc-1")).toBe(true);

    /* a blob: challenge iframe (nested window, opaque URL) asks for the CF script */
    clientsMap["blob-1"] = { type: "window", url: "blob:" + ORIGIN + "/9f2c-uuid", frameType: "nested" };
    transportMock.queue.push(new Response("window._cf_chl_opt={};", { status: 200, headers: { "content-type": "application/javascript" } }));
    const scriptUrl = ORIGIN + "/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=r1";
    const sub = mkEvent(scriptUrl, "no-cors", "script", "", "blob-1");
    handleFetch(sub.ev);
    expect(sub.armed.length).toBe(1);
    const served = await sub.armed[0]!;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("window._cf_chl_opt={};");
    /* the decisive signal: the request rode the engine transport to the
       page's virtual origin, not the origin-server passthrough */
    expect(transportMock.urls.some((u) => u === "https://site.example/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=r1")).toBe(true);
  });

  it("D2 guard: the host shell (top-level, non-engine path) keeps the passthrough for its own assets", async () => {
    transportMock.queue.push(new Response("<!DOCTYPE html><html><head></head><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const nav = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-1", "doc-1");
    handleFetch(nav.ev);
    await nav.armed[0]!;

    clientsMap["shell-1"] = { type: "window", url: ORIGIN + "/?url=https%3A%2F%2Fsite.example%2F", frameType: "top-level" };
    const sub = mkEvent(ORIGIN + "/main.js", "no-cors", "script", ORIGIN + "/?url=https%3A%2F%2Fsite.example%2F", "shell-1");
    handleFetch(sub.ev);
    const served = await sub.armed[0]!;
    /* passthrough happened: the browser-side fetch served the dist asset,
       the engine transport never saw the path */
    expect(await served.text()).toBe("shell-asset");
    expect(transportMock.urls.some((u) => u.includes("site.example/main.js"))).toBe(false);
  });

  it("D2 fail-closed: with no proxied window open, a context-less request still passes through", async () => {
    clientsMap["blob-9"] = { type: "window", url: "blob:" + ORIGIN + "/uuid", frameType: "nested" };
    const sub = mkEvent(ORIGIN + "/cdn-cgi/x.js", "no-cors", "script", "", "blob-9");
    handleFetch(sub.ev);
    const served = await sub.armed[0]!;
    expect(await served.text()).toBe("shell-asset");
    expect(transportMock.urls.some((u) => u.includes("/cdn-cgi/"))).toBe(false);
  });
});
