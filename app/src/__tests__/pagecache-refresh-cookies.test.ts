import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

/* #466: cache refreshes (stale-while-revalidate) and no-cache
   revalidations must admit their Set-Cookie into the requesting
   client's jar, the same seam the live path uses, and must read the
   jar through the same client context. The transport is mocked; the
   node environment provides neither caches nor self, so both are
   stubbed per test (pagecache.test.ts idiom). Set-Cookie rides the
   transport rawHeaders expando (jarHeaders) because Response
   construction drops set-cookie in the browser. */

const { transport } = vi.hoisted(() => ({ transport: { handler: async (_h?: Headers, _d?: string): Promise<Response> => new Response("fresh") } }));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (dest: string, init?: { method?: string; headers?: Headers }) => transport.handler(init?.headers, dest),
  },
}));

import { pageCacheMatch } from "../request";
import { cookieHeaderFor, cookiesResetForTests, setJarProfile } from "../cookies";

type RawResp = Response & { rawHeaders?: Array<[string, string]> };

function served(resp: RawResp, ...setCookies: string[]): RawResp {
  resp.rawHeaders = setCookies.map((c): [string, string] => ["set-cookie", c]);
  return resp;
}

function fakeCaches(match: () => Response | null): Response[] {
  const puts: Response[] = [];
  const fake = {
    match: async () => match(),
    delete: async () => true,
    put: async (_r: Request, resp: Response) => void puts.push(resp),
    keys: async () => [] as Request[],
  };
  const other = { match: async () => null, delete: async () => true, put: async () => {}, keys: async () => [] as Request[] };
  (globalThis as { caches?: unknown }).caches = {
    open: async (name: string) => (name === "zeolite-pages-v2" ? fake : other),
  };
  return puts;
}

const staleEntry = (cc: string) =>
  new Response("stale", {
    headers: {
      "content-type": "text/plain",
      "cache-control": cc,
      "x-zl-cached-at": String(Date.now() - 60 * 60 * 1000),
    },
  });

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
  delete (globalThis as { self?: unknown }).self;
  transport.handler = async () => new Response("fresh");
  cookiesResetForTests();
});

describe("page-cache refresh cookie admission (#466)", () => {
  it("admits a stale-refresh 200 Set-Cookie into the requesting client's jar", async () => {
    const h = new Headers({ "content-type": "text/plain" });
    h.append("set-cookie", "sid=rot; Path=/");
    transport.handler = async () => served(new Response("fresh", { headers: h }), "sid=rot; Path=/");
    const puts = fakeCaches(() => staleEntry("max-age=60"));
    (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };
    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request("https://e.example/p"), (p) => void kept.push(p), { clientId: "clientA" });
    if (!hit) throw new Error("expected the stale copy to be served");
    await kept[0];
    expect(cookieHeaderFor("https://e.example/p", { clientId: "clientA" })).toContain("sid=rot");
    /* #179: the refresh just admitted a jar cookie for this target, so
       the shared page cache refuses to store the credential-bearing view */
    expect(puts.length).toBe(0);
  });

  it("admits Set-Cookie on a no-cache 304 revalidation", async () => {
    transport.handler = async () => served(new Response(null, { status: 304, headers: { etag: '"v1"' } }), "rot2=x; Path=/");
    const puts = fakeCaches(() => staleEntry("no-cache"));
    (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };
    const hit = await pageCacheMatch(new Request("https://e.example/nc"), () => {}, { clientId: "clientB" });
    if (!hit) throw new Error("expected the stored copy after 304");
    expect(await hit.clone().text()).toBe("stale");
    expect(cookieHeaderFor("https://e.example/nc", { clientId: "clientB" })).toContain("rot2=x");
    expect(puts.length).toBe(1);
  });

  it("admits on every refresh hop and the final response", async () => {
    let calls = 0;
    transport.handler = async () => {
      calls++;
      if (calls === 1) return served(new Response(null, { status: 302, headers: { location: "https://e.example/hop2" } }), "hop=a; Path=/");
      return served(new Response("done", { headers: { "content-type": "text/plain" } }), "final=b; Path=/");
    };
    const puts = fakeCaches(() => staleEntry("max-age=60"));
    (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };
    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request("https://e.example/p"), (p) => void kept.push(p), { clientId: "clientC" });
    if (!hit) throw new Error("expected the stale copy to be served");
    await kept[0];
    expect(cookieHeaderFor("https://e.example/p", { clientId: "clientC" })).toContain("hop=a");
    expect(cookieHeaderFor("https://e.example/hop2", { clientId: "clientC" })).toContain("final=b");
    /* #179: same refusal as the single-hop case above */
    expect(puts.length).toBe(0);
  });

  it("scopes the refresh admission to the owner's session profile", async () => {
    expect(setJarProfile("sess", "clientD").profile).toBe("sess");
    const h = new Headers({ "content-type": "text/plain" });
    h.append("set-cookie", "sid=s; Path=/");
    transport.handler = async () => served(new Response("fresh", { headers: h }), "sid=s; Path=/");
    const puts = fakeCaches(() => staleEntry("max-age=60"));
    (globalThis as { self?: unknown }).self = { location: { origin: "https://zl.test" } };
    const kept: Promise<unknown>[] = [];
    const hit = await pageCacheMatch(new Request("https://s.example/x"), (p) => void kept.push(p), { clientId: "clientD" });
    if (!hit) throw new Error("expected the stale copy to be served");
    await kept[0];
    expect(cookieHeaderFor("https://s.example/x", { clientId: "clientD" })).toContain("sid=s");
    /* the default jar never sees the session cookie */
    expect(cookieHeaderFor("https://s.example/x")).toBeNull();
    /* the session namespace keeps the default jar empty, so the entry
       stores - and the stored copy never keeps the set-cookie header */
    expect(puts.length).toBe(1);
    expect(puts[0].headers.get("set-cookie")).toBeNull();
  });
});
