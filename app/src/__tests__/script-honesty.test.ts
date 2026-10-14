import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #158/#159: a script or worker destination never receives an HTML
   or CSS body. SPA catch-alls answer missing module paths with a 200
   HTML document (live: chatgpt's root-relative modules), upstream
   error pages are HTML, and claude answers a mangled specifier with
   CSS - module graphs hard-fail on the MIME mismatch and classic
   scripts execute the body as JS. Both the fresh path and the cache
   hit serve an honest JS-typed comment carrying the upstream status
   and type instead. The transport is mocked like request.test.ts. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      transportMock.calls++;
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { handleFetch } from "../request";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://sh.test";

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

const noCache = () =>
  vi.stubGlobal("caches", {
    open: async () => {
      throw new Error("no cache storage");
    },
  });

describe("script destination body honesty (#158/#159)", () => {
  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.queue = [];
    stubSelf();
    noCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves a JS-typed comment when the SPA catch-all answers a module path with a 200 HTML document", async () => {
    transportMock.queue = [
      new Response("<html>spa shell</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/native-home-x.js"), "script");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/javascript");
    expect(await served.text()).toContain("upstream 200 text/html");
  });

  it("keeps the upstream status on a 404 HTML error page at a script destination", async () => {
    transportMock.queue = [
      new Response("<html>404</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/missing.js"), "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(404);
    expect(served.headers.get("content-type")).toContain("application/javascript");
  });

  it("serves a CSS answer at a script destination JS-typed too (claude's mangled specifier class)", async () => {
    transportMock.queue = [
      new Response("body{}", { headers: { "content-type": "text/css" } }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/mangled.js"), "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.headers.get("content-type")).toContain("application/javascript");
    expect(await served.text()).toContain("text/css");
  });

  it("serves the JS-typed comment from a cache hit as well, never the document rewrite", async () => {
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async () =>
          new Response("<html>cached shell</html>", {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-zl-cached-at": String(Date.now()),
            },
          }),
        put: async () => {},
        delete: async () => true,
        keys: async () => [] as Request[],
      }),
    });
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/native-home-x.js"), "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/javascript");
    expect(transportMock.calls).toBe(0);
  });

  it("leaves a JS body at a script destination on the normal JS path", async () => {
    transportMock.queue = [
      new Response("console.log(1);", {
        headers: { "content-type": "application/javascript" },
      }),
    ];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy("https://site.example/app.js"), "script");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type") ?? "").toContain("javascript");
  });
});
