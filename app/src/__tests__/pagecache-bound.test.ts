/* #548: the page-cache entry cap is a hard bound. Room is made
   BEFORE a new entry is admitted, so a failed eviction refuses the
   store instead of admitting an untrimmable entry; one failure
   disables storing for the rest of the worker lifetime (module state
   = the restart recovery point). Fault injection through the
   stubbed caches. */

import { afterEach, describe, expect, it, vi } from "vitest";

const { transport } = vi.hoisted(() => ({
  transport: {
    handler: async (_headers?: Headers, _dest?: string): Promise<Response> => new Response("fresh"),
  },
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (dest: string, init?: { method?: string; headers?: Headers }) =>
      transport.handler(init?.headers, dest),
  },
}));

import { pageCacheStore } from "../request";

const mkResp = () =>
  new Response("body", {
    headers: { "cache-control": "max-age=600", "content-type": "text/plain" },
  });

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
  delete (globalThis as { self?: unknown }).self;
});

describe("page cache hard bound (#548)", () => {
  it("refuses stores once an eviction fails, so the entry count never grows past the cap", async () => {
    const entries = new Map<string, Response>();
    let failDelete = false;
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async () => null,
        delete: async (q: Request) => {
          if (failDelete) return false;
          return entries.delete(q.url);
        },
        put: async (q: Request, r: Response) => void entries.set(q.url, r),
        keys: async () => [...entries.keys()].map((u) => new Request(u)),
      }),
    };
    (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };

    /* Fill exactly to the 60-entry cap: every store evicts nothing. */
    for (let i = 0; i < 60; i++) {
      const r = await pageCacheStore(new Request(`https://e.example/p${i}`), mkResp(), true);
      if (!r) throw new Error(`store ${i} should have succeeded`);
    }
    expect(entries.size).toBe(60);

    /* Evictions now fail: at the cap the 61st store is REFUSED (the
       bound is hard), and every later store is refused too because
       the failure disabled caching for this worker lifetime. */
    failDelete = true;
    expect(await pageCacheStore(new Request("https://e.example/p60"), mkResp(), true)).toBeNull();
    expect(await pageCacheStore(new Request("https://e.example/p61"), mkResp(), true)).toBeNull();
    expect(entries.size).toBe(60);
  });
});
