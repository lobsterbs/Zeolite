import { describe, expect, it, vi } from "vitest";

/* #96: a wire 304 handed to respondWith() bare never settles in
   Chromium (the browser cache normally splices a cached body into a
   wire 304; a SW-served 304 has none), so the engine converts a
   not-modified result into a marked 200. These tests pin the
   conversion contract of surfaceNotModified. The transport module is
   mocked the way request.test.ts mocks it: the vendored libcurl bundle
   is a browser/wasm artifact and these tests pin response synthesis,
   not transport. */

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: { ready: async () => {}, fetch: async () => new Response("mock") },
}));

import { surfaceNotModified } from "../request";

describe("surfaceNotModified (#96 not-modified conversion)", () => {
  it("answers 200, never 304", () => {
    const h = new Headers({ etag: '"v1"' });
    expect(surfaceNotModified(h).status).toBe(200);
  });

  it("marks the conversion with x-zl-not-modified: 1", () => {
    const r = surfaceNotModified(new Headers({ etag: '"v1"' }));
    expect(r.headers.get("x-zl-not-modified")).toBe("1");
  });

  it("preserves validator headers (etag) so consumers stay honest", () => {
    const r = surfaceNotModified(new Headers({ etag: '"v1"', "cache-control": "max-age=60" }));
    expect(r.headers.get("etag")).toBe('"v1"');
    expect(r.headers.get("cache-control")).toBe("max-age=60");
  });

  it("does not mutate the caller's header set", () => {
    const h = new Headers({ etag: '"v1"' });
    surfaceNotModified(h);
    expect(h.get("x-zl-not-modified")).toBeNull();
  });

  it("carries a null body (no stored copy exists to splice)", async () => {
    const r = surfaceNotModified(new Headers({ etag: '"v1"' }));
    expect(r.body).toBeNull();
    expect(await r.text()).toBe("");
  });
});
