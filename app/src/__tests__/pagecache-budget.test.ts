import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { pageCacheStore } from "../request";

const pages = new Map<string, Response>();
const metadata = new Map<string, Response>();

const pageCache = {
  match: async (req: Request) => pages.get(req.url)?.clone() ?? null,
  put: async (req: Request, response: Response) => {
    const retained = response.clone();
    await response.arrayBuffer();
    pages.set(req.url, retained);
  },
  delete: async (req: Request) => pages.delete(req.url),
  keys: async () => [...pages.keys()].map((url) => new Request(url)),
};

const indexCache = {
  match: async (req: Request) => metadata.get(req.url)?.clone() ?? null,
  put: async (req: Request, response: Response) => {
    const retained = response.clone();
    await response.text();
    metadata.set(req.url, retained);
  },
  delete: async (req: Request) => metadata.delete(req.url),
  keys: async () => [...metadata.keys()].map((url) => new Request(url)),
};

afterEach(() => {
  pages.clear();
  metadata.clear();
  delete (globalThis as { caches?: unknown }).caches;
  delete (globalThis as { self?: unknown }).self;
});

function setup(): void {
  (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };
  (globalThis as { caches?: unknown }).caches = {
    keys: async () => ["zeolite-pages-v2", "zeolite-pages-index-v1"],
    open: async (name: string) => name === "zeolite-pages-index-v1" ? indexCache : pageCache,
  };
}

const headers = { "cache-control": "max-age=600", "content-type": "text/plain" };

describe("page cache byte budget and LRU", () => {
  it("measures unknown-length entries from the cache stream", async () => {
    setup();
    const req = new Request("https://assets.example/small");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    }), { headers });

    expect(await pageCacheStore(req, response.clone())).not.toBeNull();
    expect(JSON.parse(await metadata.get(req.url)!.clone().text())).toMatchObject({ bytes: 5 });
  });

  it("rejects an oversized cache branch without breaking the live response", async () => {
    setup();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 4; i++) controller.enqueue(chunk);
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }), { headers });
    const live = response.clone();

    expect(await pageCacheStore(new Request("https://assets.example/large"), live, true)).toBeNull();
    expect((await live.arrayBuffer()).byteLength).toBe(4 * 1024 * 1024 + 1);
  });

  it("evicts the least-recently-used entry to stay within the total byte budget", async () => {
    setup();
    for (let i = 0; i < 8; i++) {
      const url = `https://assets.example/seed-${i}`;
      pages.set(url, new Response("seed", {
        headers: {
          ...headers,
          "x-zl-page-bytes": String(4 * 1024 * 1024),
          "x-zl-cached-at": "1",
        },
      }));
      metadata.set(url, new Response(JSON.stringify({ bytes: 4 * 1024 * 1024, lastUsed: i + 1 })));
    }

    const req = new Request("https://assets.example/new");
    expect(await pageCacheStore(req, new Response("new", { headers }))).not.toBeNull();
    expect(pages.has("https://assets.example/seed-0")).toBe(false);
    expect(pages.has("https://assets.example/seed-7")).toBe(true);
    expect(pages.size).toBe(8);
  });
});
