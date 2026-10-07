import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";

/* The request lifecycle moved out of sw.ts (issue #82): the engine
   module no longer registers the service worker, so its seams are
   directly importable under vitest (the entrypoint stays
   unimportable here by design: its module body wires the worker).
   The transport module is mocked the way control.test.ts mocks it:
   the vendored libcurl bundle is a browser/wasm artifact, and these
   tests pin classification and pass-through, not transport. */

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: { ready: async () => {}, fetch: async () => new Response("mock") },
}));

import { classifyRtype, handleFetch, reqDest } from "../request";

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
