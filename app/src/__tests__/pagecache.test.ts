import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

/* Page-cache behavior seams: the stale-while-revalidate refresh must
   not block the response it serves, and no-cache must be honored.
   The transport is mocked with a gated fetch so the test can prove
   the stale hit returns BEFORE the upstream refresh settles; the
   node test environment has neither caches nor self, so both are
   provided per test. */

const gate = vi.hoisted(() => {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
});

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      await gate.promise;
      return new Response("fresh");
    },
  },
}));

import { cacheTtl, pageCacheMatch } from "../request";

describe("cacheTtl", () => {
  it("treats no-store and no-cache as never cacheable", () => {
    expect(cacheTtl(new Headers({ "cache-control": "no-store" }))).toBe(0);
    expect(cacheTtl(new Headers({ "cache-control": "no-cache" }))).toBe(0);
    expect(cacheTtl(new Headers({ "cache-control": "max-age=60, no-cache" }))).toBe(0);
  });

  it("honors max-age, capped at one day", () => {
    expect(cacheTtl(new Headers({ "cache-control": "max-age=60" }))).toBe(60_000);
    expect(cacheTtl(new Headers({ "cache-control": "max-age=999999" }))).toBe(24 * 60 * 60 * 1000);
  });

  it("falls back to the default TTL without cache-control", () => {
    expect(cacheTtl(new Headers())).toBeGreaterThan(0);
  });
});

describe("pageCacheMatch stale serving", () => {
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
    delete (globalThis as { self?: unknown }).self;
  });

  it("serves the stale hit before the refresh settles and registers the refresh with keepAlive", async () => {
    const stored = new Response("stale", {
      headers: {
        "content-type": "text/plain",
        "cache-control": "max-age=60",
        "x-zl-cached-at": String(Date.now() - 60 * 60 * 1000),
      },
    });
    const puts: unknown[] = [];
    const fake = {
      match: async () => stored,
      delete: async () => true,
      put: async (_req: Request, resp: Response) => void puts.push(resp),
      keys: async () => [] as Request[],
    };
    (globalThis as { caches?: unknown }).caches = { open: async () => fake };
    /* pageCacheStore reads self.location.origin when it stores the
       refreshed copy; the node environment has no self. */
    (globalThis as { self?: unknown }).self = {
      location: { origin: "https://zl.test" },
    };

    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request("https://e.example/p"), (p) => void kept.push(p));
    if (!hit) throw new Error("expected the stale copy to be served");
    /* The gated upstream fetch has not settled, yet the stale copy is
       here: the refresh no longer blocks the response. */
    expect(await hit.clone().text()).toBe("stale");
    expect(kept.length).toBe(1);

    gate.release();
    await kept[0];
    expect(puts.length).toBe(1);
  });

  it("skips a no-cache entry entirely", async () => {
    const stored = new Response("stale", {
      headers: {
        "content-type": "text/plain",
        "cache-control": "no-cache",
        "x-zl-cached-at": String(Date.now()),
      },
    });
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async () => stored,
        delete: async () => true,
        put: async () => {},
        keys: async () => [] as Request[],
      }),
    };
    expect(await pageCacheMatch(new Request("https://e.example/p"))).toBeNull();
  });
});
