import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

/* Page-cache behavior seams: the stale-while-revalidate refresh must
   not block the response it serves, and #115 makes the cache
   conditional - validators ride the refresh, a 304 keeps the stored
   body, and no-cache revalidates before use. The transport is mocked
   with a configurable handler so tests can answer 304 or 200 and
   inspect the conditional headers; the node test environment has
   neither caches nor self, so both are provided per test. */

const { gate, transport } = vi.hoisted(() => {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => (release = r));
  const handler = async (_headers?: Headers): Promise<Response> => {
    await promise;
    return new Response("fresh");
  };
  return { gate: { promise, release }, transport: { handler } };
});

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (_dest: string, init?: { method?: string; headers?: Headers }) =>
      transport.handler(init?.headers),
  },
}));

import { cacheStorable, cacheTtl, pageCacheMatch } from "../request";

describe("cacheTtl / cacheStorable", () => {
  it("gives no-cache and no-store a zero TTL", () => {
    expect(cacheTtl(new Headers({ "cache-control": "no-store" }))).toBe(0);
    expect(cacheTtl(new Headers({ "cache-control": "no-cache" }))).toBe(0);
    expect(cacheTtl(new Headers({ "cache-control": "max-age=60, no-cache" }))).toBe(0);
  });

  it("stores no-cache but never no-store (#115)", () => {
    expect(cacheStorable(new Headers({ "cache-control": "no-cache" }))).toBe(true);
    expect(cacheStorable(new Headers({ "cache-control": "no-store" }))).toBe(false);
    expect(cacheStorable(new Headers())).toBe(true);
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
    transport.handler = async () => {
      await gate.promise;
      return new Response("fresh");
    };
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

  it("sends If-None-Match on the stale refresh and keeps the stored body on 304 (#115)", async () => {
    const seen: Headers[] = [];
    transport.handler = async (headers?: Headers) => {
      seen.push(headers ?? new Headers());
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    };
    const makeEntry = () =>
      new Response("stale", {
        headers: {
          "content-type": "text/plain",
          "cache-control": "max-age=60",
          etag: '"v1"',
          "x-zl-cached-at": String(Date.now() - 60 * 60 * 1000),
        },
      });
    const puts: Response[] = [];
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async () => makeEntry(),
        delete: async () => true,
        put: async (_req: Request, resp: Response) => void puts.push(resp),
        keys: async () => [] as Request[],
      }),
    };
    (globalThis as { self?: unknown }).self = {
      location: { origin: "https://zl.test" },
    };

    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request("https://e.example/p"), (p) => void kept.push(p));
    if (!hit) throw new Error("expected the stale copy to be served");
    expect(await hit.clone().text()).toBe("stale");
    expect(kept.length).toBe(1);
    await kept[0];

    /* the refresh was conditional */
    expect(seen.length).toBe(1);
    expect(seen[0].get("if-none-match")).toBe('"v1"');
    /* 304: the stored body went back with a bumped stored-at, not the
       empty 304 and not a fresh transfer */
    expect(puts.length).toBe(1);
    expect(await puts[0].clone().text()).toBe("stale");
    expect(Number(puts[0].headers.get("x-zl-cached-at"))).toBeGreaterThan(
      Date.now() - 60 * 1000,
    );
  });

  it("omits conditional headers when the stored entry has no validators (#115)", async () => {
    const seen: Headers[] = [];
    transport.handler = async (headers?: Headers) => {
      seen.push(headers ?? new Headers());
      return new Response("fresh2");
    };
    const makeEntry = () =>
      new Response("stale", {
        headers: {
          "content-type": "text/plain",
          "cache-control": "max-age=60",
          "x-zl-cached-at": String(Date.now() - 60 * 60 * 1000),
        },
      });
    const puts: Response[] = [];
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async () => makeEntry(),
        delete: async () => true,
        put: async (_req: Request, resp: Response) => void puts.push(resp),
        keys: async () => [] as Request[],
      }),
    };
    (globalThis as { self?: unknown }).self = {
      location: { origin: "https://zl.test" },
    };

    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request("https://e.example/p"), (p) => void kept.push(p));
    if (!hit) throw new Error("expected the stale copy to be served");
    expect(await hit.clone().text()).toBe("stale");
    await kept[0];

    expect(seen.length).toBe(1);
    expect(seen[0].get("if-none-match")).toBeNull();
    expect(seen[0].get("if-modified-since")).toBeNull();
    /* validators absent: the unconditional behavior is unchanged - a
       200 stores the fresh copy */
    expect(puts.length).toBe(1);
    expect(await puts[0].clone().text()).toBe("fresh2");
  });

  it("revalidates a no-cache entry before use: a 304 serves the stored body (#115)", async () => {
    const seen: Headers[] = [];
    transport.handler = async (headers?: Headers) => {
      seen.push(headers ?? new Headers());
      return new Response(null, { status: 304, headers: { etag: '"v2"' } });
    };
    const entry = () =>
      new Response("stale", {
        headers: {
          "content-type": "text/plain",
          "cache-control": "no-cache",
          etag: '"v1"',
          "x-zl-cached-at": String(Date.now()),
        },
      });
    const puts: Response[] = [];
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async () => entry(),
        delete: async () => true,
        put: async (_req: Request, resp: Response) => void puts.push(resp),
        keys: async () => [] as Request[],
      }),
    };
    (globalThis as { self?: unknown }).self = {
      location: { origin: "https://zl.test" },
    };

    const served = await pageCacheMatch(new Request("https://e.example/p"));
    if (!served) throw new Error("expected the revalidated copy to be served");
    /* revalidate-before-use: the conditional fetch happened, then the
       stored body was served without a fresh transfer */
    expect(seen.length).toBe(1);
    expect(seen[0].get("if-none-match")).toBe('"v1"');
    expect(await served.clone().text()).toBe("stale");
    /* the 304's updated validator landed on the stored view */
    expect(puts.length).toBe(1);
    expect(puts[0].headers.get("etag")).toBe('"v2"');
  });

  it("revalidates a no-cache entry before use: a 200 stores and serves the fresh view (#115)", async () => {
    transport.handler = async () =>
      new Response("fresh3", {
        headers: { "content-type": "text/plain", "cache-control": "no-cache" },
      });
    const puts: Response[] = [];
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async () =>
          new Response("stale", {
            headers: {
              "content-type": "text/plain",
              "cache-control": "no-cache",
              "x-zl-cached-at": String(Date.now()),
            },
          }),
        delete: async () => true,
        put: async (_req: Request, resp: Response) => void puts.push(resp),
        keys: async () => [] as Request[],
      }),
    };
    (globalThis as { self?: unknown }).self = {
      location: { origin: "https://zl.test" },
    };

    const served = await pageCacheMatch(new Request("https://e.example/p"));
    if (!served) throw new Error("expected the fresh view to be served");
    expect(await served.clone().text()).toBe("fresh3");
    expect(puts.length).toBe(1);
  });

  it("bypasses to the live path when the no-cache revalidation fails (#115)", async () => {
    transport.handler = async () => {
      throw new Error("offline");
    };
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async () =>
          new Response("stale", {
            headers: {
              "content-type": "text/plain",
              "cache-control": "no-cache",
              "x-zl-cached-at": String(Date.now()),
            },
          }),
        delete: async () => true,
        put: async () => {},
        keys: async () => [] as Request[],
      }),
    };
    /* the stale copy must NOT be served without a successful
       revalidation: the honest result comes from the live path */
    expect(await pageCacheMatch(new Request("https://e.example/p"))).toBeNull();
  });
});
