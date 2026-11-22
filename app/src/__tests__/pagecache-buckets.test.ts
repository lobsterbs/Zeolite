import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { pageCacheClear, pageCacheMatch, pageCacheStore } from "../request";

/* #688: static subresources ride their own persistent bucket with the
   asset budget; navigations keep the page bucket. These tests pin the
   routing seam, the per-bucket budgets, and the shared clears. */

type Store = Map<string, Response>;
const pages = new Map() as Store;
const pagesIndex = new Map() as Store;
const assets = new Map() as Store;
const assetsIndex = new Map() as Store;

function openBy(name: string) {
  if (name === "zeolite-pages-v2") return vm(pages);
  if (name === "zeolite-pages-index-v1") return vm(pagesIndex);
  if (name === "zeolite-assets-v1") return vm(assets);
  return vm(assetsIndex);
}
function vm(m: Store) {
  return {
    match: async (req: Request) => m.get(req.url)?.clone() ?? null,
    put: async (req: Request, response: Response) => {
      const kept = response.clone();
      await response.arrayBuffer();
      m.set(req.url, kept);
    },
    delete: async (req: Request) => m.delete(req.url),
    keys: async () => [...m.keys()].map((url) => new Request(url)),
  };
}

afterEach(() => {
  pages.clear();
  pagesIndex.clear();
  assets.clear();
  assetsIndex.clear();
  delete (globalThis as { caches?: unknown }).caches;
  delete (globalThis as { self?: unknown }).self;
});

function setup(): void {
  (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };
  (globalThis as { caches?: unknown }).caches = {
    keys: async () => ["zeolite-pages-v2", "zeolite-pages-index-v1", "zeolite-assets-v1", "zeolite-assets-index-v1"],
    open: async (name: string) => openBy(name),
  };
}

/* Node cannot construct navigate-mode Requests; the fake mirrors the
   fields pageCacheStore/pageCacheMatch read. */
function navReq(url: string): Request {
  return { url, headers: new Headers(), credentials: "omit", signal: undefined, mode: "navigate" } as unknown as Request;
}

const imm = { "cache-control": "public, max-age=31536000", "content-type": "text/plain" };

describe("asset bucket routing and budgets (#688)", () => {
  it("routes navigations to the page bucket and subresources to the asset bucket", async () => {
    setup();
    const nav = navReq("https://site.example/doc");
    const sub = new Request("https://site.example/app.js");
    expect(await pageCacheStore(nav, new Response("doc", { headers: imm }))).not.toBeNull();
    expect(await pageCacheStore(sub, new Response("asset", { headers: imm }))).not.toBeNull();
    expect(pages.has("https://site.example/doc")).toBe(true);
    expect(assets.has("https://site.example/app.js")).toBe(true);
    expect(assets.has("https://site.example/doc")).toBe(false);
    expect(pages.has("https://site.example/app.js")).toBe(false);
    /* match routes by the same request shape */
    expect(((await pageCacheMatch(nav, () => {}, {})) ?? new Response("")).headers.get("content-type")).toContain("text/plain");
    expect(await (await pageCacheMatch(sub, () => {}, {}))?.text()).toBe("asset");
  });

  it("evicts asset entries only within the asset byte budget", async () => {
    setup();
    expect(await pageCacheStore(navReq("https://site.example/keep-page"), new Response("p", { headers: imm }))).not.toBeNull();
    for (let i = 0; i < 20; i++) {
      const url = "https://cdn.example/seed-" + i;
      assets.set(url, new Response("seed", { headers: { ...imm, "x-zl-page-bytes": String(4 * 1024 * 1024), "x-zl-cached-at": "1" } }));
      assetsIndex.set(url, new Response(JSON.stringify({ bytes: 4 * 1024 * 1024, lastUsed: i + 1 })));
    }
    const req = new Request("https://cdn.example/new.js");
    expect(await pageCacheStore(req, new Response("new", { headers: imm }))).not.toBeNull();
    expect(assets.has("https://cdn.example/seed-0")).toBe(false);
    expect(assets.has("https://cdn.example/seed-1")).toBe(false);
    expect(assets.has("https://cdn.example/seed-19")).toBe(true);
    /* the page bucket never joins an asset eviction */
    expect(pages.has("https://site.example/keep-page")).toBe(true);
  });

  it("keeps the page entry limit while the asset bucket holds a larger fleet", async () => {
    setup();
    for (let i = 0; i < 70; i++) {
      expect(await pageCacheStore(new Request("https://cdn.example/a-" + i), new Response("a", { headers: imm }))).not.toBeNull();
    }
    expect(assets.size).toBe(70);
    for (let i = 0; i < 61; i++) {
      expect(await pageCacheStore(navReq("https://site.example/p-" + i), new Response("p", { headers: imm }))).not.toBeNull();
    }
    expect(pages.size).toBe(60);
    expect(pages.has("https://site.example/p-0")).toBe(false);
    expect(pages.has("https://site.example/p-60")).toBe(true);
    expect(assets.size).toBe(70);
  });

  it("stores asset bodies up to the 8 MiB per-entry bound", async () => {
    setup();
    const declared = 5 * 1024 * 1024;
    const body = new Uint8Array(declared);
    const resp = new Response(body, { headers: { ...imm, "content-length": String(declared) } });
    const req = new Request("https://cdn.example/big.js");
    expect(await pageCacheStore(req, resp)).not.toBeNull();
    expect(assetsIndex.get(req.url)).toBeDefined();
  });

  it("keeps the eligibility gates on the asset bucket: no-store, private, credentials", async () => {
    setup();
    expect(await pageCacheStore(new Request("https://site.example/ns.js"), new Response("x", { headers: { "cache-control": "no-store" } }))).toBeNull();
    expect(await pageCacheStore(new Request("https://site.example/priv.js"), new Response("x", { headers: { "cache-control": "private" } }))).toBeNull();
    const authed = new Request("https://site.example/auth.js", { headers: { authorization: "Bearer t" } });
    expect(await pageCacheStore(authed, new Response("x", { headers: imm }))).toBeNull();
    expect(assets.size).toBe(0);
  });

  it("clears both buckets on a profile switch", async () => {
    setup();
    await pageCacheStore(navReq("https://site.example/doc"), new Response("d", { headers: imm }));
    await pageCacheStore(new Request("https://site.example/app.js"), new Response("a", { headers: imm }));
    await pageCacheClear();
    expect(pages.size).toBe(0);
    expect(assets.size).toBe(0);
    expect(pagesIndex.size).toBe(0);
    expect(assetsIndex.size).toBe(0);
  });
});
