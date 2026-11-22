import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* CF managed-challenge serving contracts (live repro: rumble.com,
   4chan.org interstitials corrupted by rewrite; discord.com/login
   challenge script MIME-blocked). Two defects pinned here:

   D1: a cf-mitigated: challenge response must serve VERBATIM (the
   NativeReason CF_CHALLENGE_VERBATIM existed in the taxonomy but no
   code path emitted it, so interstitials got DOCUMENT_REWRITE_REQUIRED
   and the bootstrap splice). Planner-level + handleFetch-level.
   #694 hardened the trust: the flag only demotes together with the
   Cloudflare edge cf-ray stamp, and the verbatim serve additionally
   carries the storage-firewall prelude (engine-own zl- and zeolite-
   prefixed names denied); a spoof falls back to the rewrite pipe.

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
import { decideTransport, planResponseTransit, relabelChallengeZone, spliceChallengeFirewall, CHALLENGE_FIREWALL_SCRIPT, CHALLENGE_ZONE_PATCH_CAP } from "../transit";
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

  it("demotes a rewrite-fallback document to NativeTransit CF_CHALLENGE_VERBATIM when the response carries the edge-signed pair (cf-mitigated: challenge + cf-ray, #694)", () => {
    const plan = planResponseTransit(
      decideTransport(site, "document"),
      "text/html; charset=utf-8",
      "document",
      site,
      null,
      { get: (n: string) => (n.toLowerCase() === "cf-mitigated" ? "challenge" : n.toLowerCase() === "cf-ray" ? "8f44f9c24f07-Tokyo" : null) },
    );
    expect(plan.decision).toEqual({ mode: "NativeTransit", reason: "CF_CHALLENGE_VERBATIM" });
    expect(plan.strategy).toBe("native");
    expect(plan.evidence).toBe("challenge-namespace");
  });

  it("#694: a header-only spoof (cf-mitigated: challenge without the cf-ray edge stamp) stays on the rewrite path", () => {
    const plan = planResponseTransit(
      decideTransport(site, "document"),
      "text/html; charset=utf-8",
      "document",
      site,
      null,
      { get: (n: string) => (n.toLowerCase() === "cf-mitigated" ? "challenge" : null) },
    );
    expect(plan.decision).toEqual({ mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" });
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

  it("serves an edge-signed cf-mitigated challenge document verbatim except the #694 storage-firewall prelude (no bootstrap splice)", async () => {
    transportMock.queue.push(
      new Response(CHALLENGE_HTML, {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge", "cf-ray": "8f44f9c24f07-Tokyo" },
      }),
    );
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-1");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(403);
    const body = await served.text();
    /* the whole verbatim contract reduces to: original bytes plus the
       firewall prelude, and nothing else */
    expect(body).toBe(spliceChallengeFirewall(CHALLENGE_HTML));
    expect(body).toContain(CHALLENGE_FIREWALL_SCRIPT);
    expect(body).not.toContain("__ZL");
  });

  it("#694: a header-only spoofed flag falls back to the rewrite pipe (bootstrap isolation re-attached), never the verbatim serve", async () => {
    const SPOOF = '<!DOCTYPE html><html><head><title>totally a challenge</title></head><body>hi</body></html>';
    transportMock.queue.push(
      new Response(SPOOF, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" },
      }),
    );
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://attacker.example/"), "navigate", "document", "", "doc-9");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    const body = await served.text();
    expect(body).toContain("__ZL");
    expect(body).not.toBe(SPOOF);
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

/* D3 (CF_CHALLENGE_ZONE_RELABEL, #685 follow-up): the managed-challenge
   orchestrator (chl_page/v1) gates the Turnstile mount on
   `location.hostname === _cf_chl_opt.cZone`; served on the opaque /j/
   realm the frame hostname is the engine host, so a site-host cZone never
   matches and the widget dies on "Unable to connect to the website"
   before any challenges.cloudflare.com request (live: rumble.com,
   dash.cloudflare.com @2c1799b). The engine relabels ONLY the inline
   `cZone: '<host>'` literal to `cZone: location.hostname` in
   cf-mitigated challenge documents - everything else stays byte-verbatim,
   and nothing about the challenge is solved or bypassed. */

describe("D3: relabelChallengeZone (unit)", () => {
  it("relabels a single-quoted inline cZone and leaves every other byte alone", () => {
    const html = '<script nonce="n">window._cf_chl_opt={cH:"x",cZone: \'rumble.com\',cRay:"r1"};</script>';
    const out = relabelChallengeZone(html);
    expect(out).toBe('<script nonce="n">window._cf_chl_opt={cH:"x",cZone: location.hostname,cRay:"r1"};</script>');
  });

  it("relabels a double-quoted cZone", () => {
    expect(relabelChallengeZone('cZone: "dash.cloudflare.com"')).toBe("cZone: location.hostname");
  });

  it("is a no-op when no cZone literal is present", () => {
    const html = "<html><body>no opt here</body></html>";
    expect(relabelChallengeZone(html)).toBe(html);
  });

  it("never touches cZone-like substrings inside longer identifiers", () => {
    const html = "var mycZone: 'x'; cZone: 'a.example';";
    expect(relabelChallengeZone(html)).toBe("var mycZone: 'x'; cZone: location.hostname;");
  });

  it("exposes a sane patch cap", () => {
    expect(CHALLENGE_ZONE_PATCH_CAP).toBeGreaterThan(64 * 1024);
  });
});

describe("D3: handleFetch relabels the cZone literal in cf-mitigated docs only", () => {
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

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.urls = [];
    transportMock.queue = [];
    VCTX.clear();
    clientsMap = {};
    siteScript.mockClear();
    initTransform(transformDeps());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("shell-asset", { status: 200 })));
    vi.stubGlobal("self", {
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async (id: string) => clientsMap[id] ?? null },
    });
    vi.stubGlobal("caches", { open: async () => { throw new Error("no cache storage"); } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    VCTX.clear();
  });

  const CHALLENGE_HTML_ZONE =
    '<!DOCTYPE html><html><head><title>Just a moment...</title><script nonce="abc">window._cf_chl_opt={cH:"x",cZone: \'site.example\',cRay:"r1",cType:\'managed\'};</script></head><body>challenge</body></html>';

  it("serves a cf-mitigated challenge doc with the cZone literal relabeled, status and all other bytes intact", async () => {
    transportMock.queue.push(
      new Response(CHALLENGE_HTML_ZONE, {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge", "cf-ray": "8f44f9c24f07-Tokyo", "content-length": String(CHALLENGE_HTML_ZONE.length) },
      }),
    );
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-z1");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(403);
    const body = await served.text();
    expect(body).toContain("cZone: location.hostname");
    expect(body).not.toContain("cZone: 'site.example'");
    /* every byte is untouched except the #694 firewall prelude */
    expect(body).toBe(spliceChallengeFirewall(CHALLENGE_HTML_ZONE.replace("cZone: 'site.example'", "cZone: location.hostname")));
    expect(body).not.toContain("__ZL");
    /* the stale upstream content-length must not survive a changed body */
    expect(served.headers.get("content-length")).toBeNull();
  });

  it("serves a cf-mitigated doc without a cZone literal with only the #694 firewall splice", async () => {
    const NOZONE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script nonce="abc">window._cf_chl_opt={cH:"x"};</script></body></html>';
    transportMock.queue.push(
      new Response(NOZONE, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge", "cf-ray": "8f44f9c24f07-Tokyo" } }),
    );
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-z2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(403);
    expect(await served.text()).toBe(spliceChallengeFirewall(NOZONE));
  });

  it("does not relabel ordinary (non-challenge-flagged) HTML documents", async () => {
    const DOC = '<!DOCTYPE html><html><head><title>t</title></head><body><script>var cZone: \'site.example\';</script></body></html>';
    transportMock.queue.push(new Response(DOC, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/"), "navigate", "document", "", "doc-z3");
    handleFetch(ev);
    const served = await armed[0]!;
    const body = await served.text();
    /* ordinary docs go through the rewrite stream; the cZone literal must
       not be relabeled by the challenge path */
    expect(body).not.toContain("cZone: location.hostname");
  });
});

/* #694: the storage-firewall prelude riding every verbatim challenge
   serve. Contract: engine-own zl- and zeolite- prefixed names are denied
   and hidden from the doc realm; every other name passes through
   untouched (a genuine CF challenge never opens engine-own names). */
describe("#694: the challenge storage firewall denies engine-own names in the doc realm", () => {
  const run = (w: unknown) => void new Function("window", CHALLENGE_FIREWALL_SCRIPT)(w);

  it("indexedDB: zl-* opens throw, legit names pass through, databases() hides engine-own DBs", async () => {
    const passed: string[] = [];
    const fakeReq = { tag: "req" };
    const w = {
      indexedDB: {
        open: (n: string) => { passed.push(n); return fakeReq; },
        deleteDatabase: (n: string) => { passed.push("del:" + n); return fakeReq; },
        databases: async () => [{ name: "zl-extensions" }, { name: "zl-route" }, { name: "site-notes" }],
        cmp: <T>(a: T, b: T) => (a === b ? 0 : 1),
      },
    };
    run(w);
    const idb = (w as { indexedDB: { open(n: string): unknown; deleteDatabase(n: string): unknown; databases(): Promise<{ name: string }[]>; cmp<T>(a: T, b: T): number } }).indexedDB;
    expect(() => idb.open("zl-extensions")).toThrow("blocked");
    expect(() => idb.open("zl-route")).toThrow("blocked");
    expect(() => idb.deleteDatabase("zl-extensions")).toThrow("blocked");
    expect(passed).toEqual([]);
    expect(idb.open("site-notes")).toBe(fakeReq);
    expect(passed).toEqual(["site-notes"]);
    expect(idb.cmp(fakeReq, fakeReq)).toBe(0);
    const dbs = await idb.databases();
    expect(dbs.map((d) => d.name)).toEqual(["site-notes"]);
  });

  it("caches: zeolite-* open rejects, keys() hides engine-own, has/delete answer false for engine-own, match is fail-closed on a named engine cache", async () => {
    const opened: string[] = [];
    const fakeCache = { tag: "cache" };
    const w = {
      caches: {
        open: async (n: string) => { opened.push(n); return fakeCache; },
        has: async () => true,
        delete: async () => true,
        keys: async () => ["zeolite-engine-v1", "zeolite-jar-profile-v1", "zeolite-pages-v2", "zeolite-pages-index-v1", "zeolite-route-v1", "site-cache"],
        match: async () => "hit" as unknown,
      },
    };
    run(w);
    const c = (w as { caches: { open(n: string): Promise<unknown>; has(n: string): Promise<boolean>; delete(n: string): Promise<boolean>; keys(): Promise<string[]>; match(r: unknown, o?: { cacheName?: string }): Promise<unknown> } }).caches;
    await expect(c.open("zeolite-jar-profile-v1")).rejects.toThrow("blocked");
    await expect(c.open("zeolite-pages-v2")).rejects.toThrow("blocked");
    expect(opened).toEqual([]);
    expect(await c.open("site-cache")).toBe(fakeCache);
    expect(await c.has("zeolite-route-v1")).toBe(false);
    expect(await c.delete("zeolite-pages-index-v1")).toBe(false);
    expect(await c.keys()).toEqual(["site-cache"]);
    expect(await c.match("https://x/", { cacheName: "zeolite-engine-v1" })).toBeUndefined();
    expect(await c.match("https://x/")).toBe("hit");
  });
});
