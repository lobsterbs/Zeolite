import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #684: the reCAPTCHA demo loader bootstrap through the engine. Two
   layers:

   1. Codec: a path-preserving split script-src route (the #296 class
      the wasm rewriter mints for <script src>, e.g. the demo page's
      gstatic release tag) minted under the reserved "/zl/" segment
      must still decode when the worker's configured prefix is "/j/"
      (prefix rotation / cold start ahead of the config re-push).
      Before the fix the route stranded in the relative-recovery seam
      and the subresource request resolved against the PAGE's virtual
      origin - the wrong-host request class behind the demo stall.

   2. Engine chain: the demo page's loader flow (document -> api.js
      -> gstatic release script -> anchor frame) driven through
      handleFetch exactly like captcha-trace.test.ts / challenge-frame
      .test.ts do, with a grecaptcha-stub-shaped api.js body (the real
      loader defines window.grecaptcha with only `ready`, then inserts
      the release script tag). Every stage must stay engine-routed:
      the transport sees the real destinations, the release serve gets
      the #451 carve-out (literal pass relaxed), the anchor frame
      navigation is challenge-routed with co= virtualized to the page
      origin, and the captcha trace records ASSET_LOAD / FRAME_HANDSHAKE
      for the recaptcha provider. Detection/rendering only - no solve
      logic anywhere. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  urls: [] as string[],
  bodies: new Map<string, { body: string; ct: string }>(),
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      const hit = transportMock.bodies.get(url);
      if (hit) return new Response(hit.body, { headers: { "content-type": hit.ct } });
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
  altConfigured: () => false,
  altRegister: () => {},
  altEndpoint: () => null,
  altWispFetch: async () => {
    throw new Error("no alt transport in test");
  },
  canReplayAfterFailure: () => false,
}));

const wsOpenUrls = vi.hoisted(() => [] as string[]);
vi.mock("../ws-runtime", () => ({
  wsBridge: {
    open: (_port: unknown, url: string) => {
      wsOpenUrls.push(url);
    },
    closeAll: () => {},
  },
}));

/* wasm glue stub: record the origin-pinning-skip relax calls so the
   #451 carve-out wiring is observable, pass bodies through. */
const wasmState = vi.hoisted(() => ({
  pinSkip: [] as Array<[string, boolean]>,
  scriptCalls: [] as string[],
}));
vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    base: string;
    constructor(_o: string, base: string) {
      this.base = base;
    }
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
    add_injection(_p: string) {}
    set_blocked_hosts(_h: string[]) {}
    set_lazy_images() {}
    set_origin_pinning_skip(v: boolean) {
      wasmState.pinSkip.push([this.base, v]);
    }
    set_location_policy() {
      return true;
    }
    rewrite_script(js: string) {
      wasmState.scriptCalls.push(this.base);
      return js;
    }
    take_location_events() {
      return "";
    }
    globalsStats() {
      return "0,0,0";
    }
    free() {}
  }
  class JsCssRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
  }
  return {
    JsRewriter,
    JsCssRewriter,
    rewriteCss: (css: string) => css,
    rewriteJsBody: (js: string) => js,
    globalsStats: () => "0,0,0",
    hasOriginPinningRegex: (js: string) => js.includes("^https?:"),
    default: async () => {},
  };
});

import { b64uEncode, decodePath, encodeDest, encodeDestLegacy, recoverPath, setRouteKeys, setScheme } from "../codec";
import { handleFetch } from "../request";
import { initTransform } from "../transform";
import { CAPTCHA_TRACE } from "../captcha-trace";
import { establishContext } from "../vctx";
import { VCTX } from "../swstate";

const ENGINE = "https://engine.example";
const DEMO = "https://www.google.com/recaptcha/api2/demo";
const APIJS = "https://www.google.com/recaptcha/api.js";
const RELEASE = "https://www.gstatic.com/recaptcha/releases/4i3aN5wAweL7i3ADI7BSX4B-/recaptcha__en.js";
const ANCHOR =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-&co=" +
  btoa(ENGINE + ":443").replace(/=+$/, (p) => ".".repeat(p.length)) +
  "&hl=en&v=4i3aN5wAweL7i3ADI7BSX4B-&size=normal";

/* The real api.js loader shape: defines the grecaptcha STUB (only
   `ready`, no `render`), then phase-2 inserts the gstatic release
   script tag (crossorigin + integrity, both neutralized page-side by
   the #77 guard) before the first script element. */
const APIJS_BODY =
  "(function(){var w=window,C='___grecaptcha_cfg',cfg=w[C]=w[C]||{},N='grecaptcha';var gr=w[N]=w[N]||{};" +
  "gr.ready=gr.ready||function(f){(cfg['fns']=cfg['fns']||[]).push(f);};" +
  "w['__recaptcha_api']='https://www.google.com/recaptcha/api2/';" +
  "var d=document,po=d.createElement('script');po.type='text/javascript';po.async=true;po.charset='utf-8';" +
  "po.src='https://www.gstatic.com/recaptcha/releases/4i3aN5wAweL7i3ADI7BSX4B-/recaptcha__en.js';" +
  "po.crossOrigin='anonymous';po.integrity='sha384-9kWldX1GBV0fyoXG9yQ5yIrkqyWnjgRBm6nILiadZBzlNoT3mlsHud6Afn9RimQk';" +
  "var s=d.getElementsByTagName('script')[0];s.parentNode.insertBefore(po, s);})();";
/* The release body pins origins (anchored ^https?: regex, the #449
   detector's trigger) and carries the single RPC-base literal the #451
   carve-out keeps engine-mediated. */
const RELEASE_BODY =
  "var va=/^https?:\\/\\/www\\.gstatic\\.com\\/recaptcha\\/releases\\//;" +
  "window['__recaptcha_api']='https://www.google.com/recaptcha/api2/';" +
  "var grecaptcha={render:function(){},execute:function(){},ready:function(f){f()}};";

const KEY = b64uEncode(new Uint8Array(16).fill(7));

function mkEvent(routeUrl: string, mode: string, destination: string, referrer: string) {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "GET",
      mode,
      destination,
      credentials: "same-origin",
      referrer,
      body: null,
      headers: new Headers(),
    },
    clientId: "demo-client",
    resultingClientId: "demo-client-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
}

beforeEach(() => {
  setScheme("/j/");
  setRouteKeys([KEY]);
  VCTX.clear();
  CAPTCHA_TRACE.resetForTests();
  transportMock.calls = 0;
  transportMock.urls = [];
  wasmState.pinSkip = [];
  wasmState.scriptCalls = [];
  transportMock.bodies.set(DEMO, {
    body:
      '<html><head><script src="' + RELEASE + '" crossorigin="anonymous" integrity="sha384-x"></script>' +
      '<script src="' + APIJS + '" async defer></script></head>' +
      '<body><div class="g-recaptcha" data-sitekey="K"></div></body></html>',
    ct: "text/html; charset=utf-8",
  });
  transportMock.bodies.set(APIJS, { body: APIJS_BODY, ct: "text/javascript; charset=utf-8" });
  transportMock.bodies.set(RELEASE, { body: RELEASE_BODY, ct: "text/javascript; charset=utf-8" });
  transportMock.bodies.set(ANCHOR.replace(/co=[^&]*/, "co=x"), { body: "<html>anchor</html>", ct: "text/html; charset=utf-8" });
  vi.stubGlobal("self", {
    location: { origin: ENGINE, href: ENGINE + "/sw.js" },
    registration: { scope: ENGINE + "/" },
    clients: { get: async () => ({ id: "demo-client", url: ENGINE + encodeDestLegacy(DEMO) }) },
  });
  vi.stubGlobal("caches", {
    open: async () => {
      throw new Error("no cache storage");
    },
  });
  establishContext(VCTX, "demo-client", DEMO);
  initTransform({
    routeReady: () => Promise.resolve(),
    routeKey: () => KEY,
    siteScript: async () => "",
    fpScript: () => "",
    lazyImages: () => false,
    setDegraded: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setRouteKeys([]);
});

async function drive(target: string, mode: string, destination: string, referrer: string) {
  const { ev, armed } = mkEvent(ENGINE + encodeDestLegacy(target), mode, destination, referrer);
  handleFetch(ev);
  if (!armed.length) return { armed: false as const, status: 0, ct: null, body: "" };
  const resp = await armed[0]!;
  return {
    armed: true as const,
    status: resp.status,
    ct: resp.headers.get("content-type"),
    body: await resp.clone().text(),
    location: resp.headers.get("location"),
  };
}

describe("#684 split script-src routes under the reserved zl segment", () => {
  it("decodes a /zl/ split route when the configured prefix is /j/ (prefix rotation)", () => {
    setScheme("/zl/");
    setRouteKeys([KEY]);
    const originToken = encodeDest("https://www.gstatic.com").slice("/zl/".length);
    const split = "/zl/" + originToken + "/recaptcha/releases/4i3aN5wAweL7i3ADI7BSX4B-/recaptcha__en.js";
    /* minted under /zl/, the worker boots with /j/ (rotation/cold start) */
    setScheme("/j/");
    expect(recoverPath(split)).toBe(RELEASE);
    expect(decodePath(split)).toBeNull();
  });

  it("still decodes under the configured /zl/ prefix as before", () => {
    setScheme("/zl/");
    setRouteKeys([KEY]);
    const originToken = encodeDest("https://www.gstatic.com").slice("/zl/".length);
    const split = "/zl/" + originToken + "/recaptcha/api.js";
    expect(recoverPath(split)).toBe("https://www.gstatic.com/recaptcha/api.js");
  });

  it("fails closed: a foreign key or plaintext tail never decodes via the zl retry", () => {
    setScheme("/zl/");
    setRouteKeys([KEY]);
    const originToken = encodeDest("https://www.gstatic.com").slice("/zl/".length);
    const split = "/zl/" + originToken + "/recaptcha/releases/abc/recaptcha__en.js";
    setScheme("/j/");
    setRouteKeys([b64uEncode(new Uint8Array(16).fill(9))]);
    expect(recoverPath(split)).toBeNull();
    setRouteKeys([KEY]);
    expect(recoverPath("/zl/img/goats.mp4")).toBeNull();
  });
});

describe("#684 reCAPTCHA demo loader bootstrap chain through the engine", () => {
  it("document -> api.js -> release script -> anchor frame all stay engine-routed and traced", async () => {
    const doc = await drive(DEMO, "navigate", "document", "");
    expect(doc.armed).toBe(true);
    expect(doc.status).toBe(200);
    expect(doc.ct).toContain("text/html");

    const referrer = ENGINE + encodeDestLegacy(DEMO);

    /* api.js: script destination, served through the JS body pass */
    const api = await drive(APIJS, "no-cors", "script", referrer);
    expect(api.armed).toBe(true);
    expect(api.status).toBe(200);
    expect(api.ct).toContain("javascript");
    expect(api.body).toContain("grecaptcha");
    expect(wasmState.scriptCalls).toContain(APIJS);

    /* the release script (what api.js phase-2 inserts): engine-routed,
       served, and carrying the #451 carve-out (literal pass relaxed) */
    const rel = await drive(RELEASE, "cors", "script", referrer);
    expect(rel.armed).toBe(true);
    expect(rel.status).toBe(200);
    expect(rel.ct).toContain("javascript");
    expect(wasmState.scriptCalls).toContain(RELEASE);
    expect(wasmState.pinSkip).toContainEqual([RELEASE, false]);

    /* the anchor frame navigation: challenge-routed, co= virtualized
       to the embedding page's origin, never provider-direct */
    const anchor = await drive(ANCHOR, "navigate", "iframe", referrer);
    expect(anchor.armed).toBe(true);
    expect(anchor.status).toBe(200);
    expect(anchor.location).toBeNull();
    const anchorUpstream = transportMock.urls.find((u) => u.includes("/recaptcha/api2/anchor"));
    expect(anchorUpstream).toBeDefined();
    const co = new URL(anchorUpstream!).searchParams.get("co")!;
    expect(co).toBe(btoa("https://www.google.com:443").replace(/=+$/, (p) => ".".repeat(p.length)));

    /* every stage rode the transport to its real destination */
    expect(transportMock.urls).toContain(DEMO);
    expect(transportMock.urls).toContain(APIJS);
    expect(transportMock.urls).toContain(RELEASE);

    /* the trace carries the observable stages for the recaptcha flow */
    const snap = CAPTCHA_TRACE.snapshot();
    expect(snap.attempts.length).toBe(1);
    const a = snap.attempts[0]!;
    expect(a.provider).toBe("recaptcha");
    const stages = a.stages.map((s) => s.stage);
    expect(stages).toContain("ASSET_LOAD");
    expect(stages).toContain("FRAME_HANDSHAKE");
    expect(a.stages.filter((s) => s.stage === "ASSET_LOAD").map((s) => s.url)).toContain(RELEASE);
    expect(a.stages.filter((s) => s.stage === "ASSET_LOAD").some((s) => s.outcome === "200")).toBe(true);
    expect(a.stages.filter((s) => s.stage === "FRAME_HANDSHAKE").some((s) => s.outcome === "200")).toBe(true);
  });

  it("a split-route release request minted under /zl/ still routes to gstatic when the prefix rotated to /j/", async () => {
    setScheme("/zl/");
    const originToken = encodeDest("https://www.gstatic.com").slice("/zl/".length);
    const splitPath = "/zl/" + originToken + "/recaptcha/releases/4i3aN5wAweL7i3ADI7BSX4B-/recaptcha__en.js";
    setScheme("/j/"); /* the boot prefix rotated after the page was minted */
    const referrer = ENGINE + encodeDestLegacy(DEMO);
    const { ev, armed } = mkEvent(ENGINE + splitPath, "cors", "script", referrer);
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const resp = await armed[0]!;
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("javascript");
    /* the transport saw the REAL gstatic destination, not the page host */
    expect(transportMock.urls).toContain(RELEASE);
    expect(transportMock.urls.some((u) => u.includes("/zl/"))).toBe(false);
  });
});
