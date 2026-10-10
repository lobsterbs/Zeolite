import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #134: a cached JS body must serve through the same specifier +
   literal passes a fresh response takes. Entries stored by older
   dists (before the JS transform covered script destinations) hold
   raw upstream bodies; serving them verbatim let a module-relative
   import() resolve against the engine route and the escaped-path
   recovery answered the wrong destination (play2048's lazy chunk
   loaded the site's SPA shell as JavaScript). The transport is
   mocked to throw: a fresh cache entry must serve with no upstream
   round trip at all. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      transportMock.calls++;
      throw new Error("the cache hit must serve without an upstream fetch");
    },
  },
}));

import { handleFetch } from "../request";
import { currentPrefix, decodePath, encodeDestLegacy } from "../codec";

const ORIGIN = "https://zl.test";
const MODULE = "https://site.example/assets/app.js";
const RAW_BODY =
  'const Bg={en:()=>pt(()=>import("./index-BynxPbO3.js"),[])};';

/* The engine prefix is deployment-configured (the live services run
   /zl/, the codec default here is /j/): derive it, never hardcode. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROUTE_TAIL = new RegExp(esc(currentPrefix()) + "([A-Za-z0-9_-]+)");

/* Plain-object request/event, the request.test.ts shape: mode
   "navigate" is constructor-illegal on a node Request. */
const mkEvent = (routeUrl: string, destination: string) => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "GET",
      mode: "cors",
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

const stubSelf = () =>
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });

describe("cache-hit JS transform parity (#134)", () => {
  const puts: Response[] = [];

  const stubCache = (body: string) =>
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async () =>
          new Response(body, {
            headers: {
              "content-type": "application/javascript",
              "cache-control": "max-age=600",
              "x-zl-cached-at": String(Date.now()),
            },
          }),
        put: async (_req: Request, resp: Response) => void puts.push(resp),
        delete: async () => true,
        keys: async () => [] as Request[],
      }),
    });

  beforeEach(() => {
    transportMock.calls = 0;
    puts.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("repairs a stale raw JS entry at serve: the dynamic import routes against the module URL", async () => {
    stubSelf();
    stubCache(RAW_BODY);
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(MODULE), "script");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/javascript");
    const body = await served.text();
    /* the specifier folded into an engine route, not the escaped
       root-relative path */
    expect(body).not.toContain('import("./index-BynxPbO3.js")');
    const m = ROUTE_TAIL.exec(body);
    expect(m).toBeTruthy();
    expect(decodePath(currentPrefix() + m![1])).toBe(
      "https://site.example/assets/index-BynxPbO3.js",
    );
    expect(transportMock.calls).toBe(0);
    /* the repaired copy heals the stored entry once */
    for (let i = 0; i < 100 && puts.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(puts.length).toBe(1);
    const healed = await puts[0].text();
    expect(healed).not.toContain('import("./index-BynxPbO3.js")');
  });

  it("serves an already-composed entry unchanged: the passes are idempotent, no write-back", async () => {
    stubSelf();
    const composed =
      'const Bg={en:()=>pt(()=>import("' +
      encodeDestLegacy("https://site.example/assets/chunk.js") +
      '"),[])};';
    stubCache(composed);
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(MODULE), "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(composed);
    expect(transportMock.calls).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(puts.length).toBe(0);
  });

  it("keeps the raw serve for worker-destination hits: cached worker copies are composed by the fresh path", async () => {
    stubSelf();
    stubCache(RAW_BODY);
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(MODULE), "worker");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(RAW_BODY);
    expect(transportMock.calls).toBe(0);
  });
});
