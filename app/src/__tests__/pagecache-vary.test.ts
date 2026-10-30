/* #557: the page cache honors Vary through stored variant metadata.
   The normalized field list and the selecting request's header values
   ride the entry as internal headers; a lookup with different values
   is an honest miss (bypass to the live path), unparseable metadata
   fails closed to a miss, and Vary: * stays uncacheable. Transport,
   self and caches are stubbed like pagecache.test.ts. */

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

import { pageCacheMatch, pageCacheStore, storeVaryMeta, varyFields, varyMatches } from "../request";

const stubCache = (): Map<string, Response> => {
  const entries = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    open: async () => ({
      match: async (q: Request) => entries.get(q.url) ?? null,
      delete: async (q: Request) => entries.delete(q.url),
      put: async (q: Request, r: Response) => void entries.set(q.url, r),
      keys: async () => [...entries.keys()].map((u) => new Request(u)),
    }),
  };
  (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };
  return entries;
};

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
  delete (globalThis as { self?: unknown }).self;
});

describe("varyFields normalization (#557)", () => {
  it("lowercases, trims and drops empty fields", () => {
    expect(varyFields(new Headers({ vary: "Accept-Language, Origin" }))).toEqual([
      "accept-language",
      "origin",
    ]);
    expect(varyFields(new Headers({ vary: "  user-agent " }))).toEqual(["user-agent"]);
    expect(varyFields(new Headers())).toEqual([]);
    expect(varyFields(new Headers({ vary: "*" }))).toEqual(["*"]);
  });
});

describe("varyMatches (#557)", () => {
  it("matches identical values and treats absent-vs-present as a change", () => {
    const h = new Headers();
    storeVaryMeta(h, ["accept-language"], new Headers({ "accept-language": "en-US" }));
    expect(varyMatches(h, new Headers({ "accept-language": "en-US" }))).toBe(true);
    expect(varyMatches(h, new Headers({ "accept-language": "nb-NO" }))).toBe(false);
    expect(varyMatches(h, new Headers())).toBe(false);
  });

  it("fails closed on corrupt or missing metadata, stays unconstrained without Vary", () => {
    const corrupt = new Headers({ "x-zl-vary": "accept-language" });
    expect(varyMatches(corrupt, new Headers({ "accept-language": "en-US" }))).toBe(false);
    expect(varyMatches(new Headers(), new Headers())).toBe(true);
  });

  it("compares every field of a multi-field Vary", () => {
    const h = new Headers();
    storeVaryMeta(
      h,
      ["accept-language", "origin"],
      new Headers({ "accept-language": "en", origin: "https://a.example" }),
    );
    expect(
      varyMatches(h, new Headers({ "accept-language": "en", origin: "https://a.example" })),
    ).toBe(true);
    expect(
      varyMatches(h, new Headers({ "accept-language": "en", origin: "https://b.example" })),
    ).toBe(false);
  });
});

describe("pageCacheStore/Match variant selection (#557)", () => {
  it("stores the snapshot and serves only the same variant", async () => {
    const entries = stubCache();
    const stored = await pageCacheStore(
      new Request("https://e.example/p", { headers: { "accept-language": "en-US" } }),
      new Response("variant-en", {
        headers: {
          "content-type": "text/plain",
          "cache-control": "max-age=600",
          vary: "Accept-Language",
        },
      }),
      true,
    );
    if (!stored) throw new Error("expected the vary response to be stored");
    expect(await stored.clone().text()).toBe("variant-en");
    expect(entries.size).toBe(1);
    const saved = entries.get("https://e.example/p");
    if (!saved) throw new Error("expected the entry to be in the stub cache");
    expect(saved.headers.get("x-zl-vary")).toBe("accept-language");
    expect(saved.headers.get("x-zl-vary-values")).toBe(JSON.stringify(["en-US"]));

    const same = await pageCacheMatch(
      new Request("https://e.example/p", { headers: { "accept-language": "en-US" } }),
    );
    expect(same && (await same.clone().text())).toBe("variant-en");
    const other = await pageCacheMatch(
      new Request("https://e.example/p", { headers: { "accept-language": "nb-NO" } }),
    );
    expect(other).toBeNull();
    /* Headers field names are case-insensitive on both sides. */
    const caseless = await pageCacheMatch(
      new Request("https://e.example/p", { headers: { "ACCEPT-LANGUAGE": "en-US" } }),
    );
    expect(caseless && (await caseless.clone().text())).toBe("variant-en");
  });

  it("rides variant metadata on the entry like the other internal headers", async () => {
    stubCache();
    await pageCacheStore(
      new Request("https://e.example/q", { headers: { "accept-language": "en" } }),
      new Response("v", {
        headers: {
          "content-type": "text/plain",
          "cache-control": "max-age=600",
          vary: "Accept-Language",
        },
      }),
      true,
    );
    const hit = await pageCacheMatch(
      new Request("https://e.example/q", { headers: { "accept-language": "en" } }),
    );
    /* the raw match return carries the internal metadata (the same
       contract as x-zl-cached-at); the fetch-handler serve path strips
       the internal headers before the page sees the copy. */
    expect(hit && hit.headers.get("x-zl-vary")).toBe("accept-language");
    expect(hit && hit.headers.get("x-zl-vary-values")).toBe(JSON.stringify(["en"]));
    /* the upstream vary header itself stays on the entry */
    expect(hit && hit.headers.get("vary")).toBe("Accept-Language");
  });
});
