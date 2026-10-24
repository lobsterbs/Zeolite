import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ queue: [] as Response[], rewrites: 0, fetches: 0 }));
vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => { seam.fetches++; return seam.queue.shift()!; },
  },
}));
/* Exercise the request lifecycle without a browser WASM loader. API
   data must never call the document transformer; document loads must. */
vi.mock("../transform", async () => {
  const { docKind, jsBody } = await import("../transit");
  return {
    isHtml: (r: Response) => docKind(r.headers.get("content-type") ?? "") === "html",
    isCss: (r: Response) => docKind(r.headers.get("content-type") ?? "") === "css",
    isJs: (r: Response) => jsBody(r.headers.get("content-type") ?? ""),
    rewriteStream: () => { seam.rewrites++; return "document rewrite"; },
    cssRewriteStream: () => "css rewrite",
    rewriteJsBody: async (s: string) => s,
    workerPrelude: async () => "",
    rawFrom: () => null,
  };
});

import { handleFetch } from "../request";
import { encodeDestLegacy, setScheme } from "../codec";
import { DOC_DESTS, transitResetForTests, transitStats } from "../transit";

const ORIGIN = "https://engine.example";
let cached: Response | undefined;

function run(method: string, destination = "") {
  let response!: Promise<Response>;
  const event = {
    request: {
      url: ORIGIN + encodeDestLegacy("https://api.example/user/api.php"),
      method, destination, mode: DOC_DESTS.has(destination) ? "navigate" : "cors",
      credentials: "same-origin", headers: new Headers(), referrer: "", body: null,
    },
    clientId: "api-client", resultingClientId: "api-result",
    respondWith: (r: Promise<Response>) => { response = r; },
    waitUntil: () => {},
  } as unknown as FetchEvent;
  handleFetch(event);
  return response;
}

beforeEach(() => {
  seam.queue = [];
  seam.rewrites = seam.fetches = 0;
  cached = undefined;
  transitResetForTests();
  setScheme("/j/");
  vi.stubGlobal("self", {
    location: { origin: ORIGIN }, registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async () => cached?.clone(),
      put: async () => {}, delete: async () => true, keys: async () => [],
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("HTML-typed API payloads (#414)", () => {
  it("preserves the exact uploaded-file URL from a PHP POST response", async () => {
    const body = "https://files.example/upload.mp4";
    seam.queue.push(new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(await (await run("POST")).text()).toBe(body);
    expect(seam.rewrites).toBe(0);
    expect(transitStats().fallback).toBe(0);
  });

  it("leaves fetched HTML fragments as application data", async () => {
    const body = '<a href="/result">result</a>\r\n';
    seam.queue.push(new Response(body, { headers: { "content-type": "application/xhtml+xml" } }));
    expect(await (await run("GET")).text()).toBe(body);
    expect(seam.rewrites).toBe(0);
  });

  it("preserves a cached HTML API response without document injection", async () => {
    const body = '<div data-page="1">cached fragment</div>';
    cached = new Response(body, { headers: {
      "content-type": "text/html", "x-zl-cached-at": String(Date.now()),
    } });
    expect(await (await run("GET")).text()).toBe(body);
    expect(seam.fetches).toBe(0);
    expect(seam.rewrites).toBe(0);
    expect(transitStats().fallback).toBe(0);
  });

  it("retains document rewriting for all document-loading destinations", async () => {
    for (const destination of DOC_DESTS) {
      seam.queue.push(new Response("<html><a href='/'>home</a></html>", {
        headers: { "content-type": "text/html" },
      }));
      expect(await (await run("GET", destination)).text()).toBe("document rewrite");
    }
    expect(seam.rewrites).toBe(DOC_DESTS.size);
  });
});
