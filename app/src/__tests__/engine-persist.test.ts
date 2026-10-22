import { beforeAll, describe, expect, it, vi } from "vitest";
/* #390: the zl:transport choice must survive an idle worker restart.
   controllerchange never fires for an instance restart, so the
   embedder cannot re-send its toggle; engineReady() replays the
   persisted choice before the first init and every switch persists
   it. The vendored bundle is node-safe to import here (transport-
   select.test.ts pins its pure surface directly). */

const store = new Map<string, Response>();
vi.stubGlobal("caches", {
  open: async () => ({
    match: async (r: Request) => store.get(r.url) ?? null,
    put: async (r: Request, v: Response) => {
      store.set(r.url, v);
    },
  }),
});

let transport: typeof import("../transport");
beforeAll(async () => {
  transport = await import("../transport");
});

/* engineKeyUrl(): the node-test realm has no self.location, so the
   fallback origin is used. Keep in sync with transport.ts. */
const KEY = "http://zeolite.test/zl-engine-choice";

/* switchEngine persists fire-and-forget; yield until the put lands. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("engine choice persistence (#390)", () => {
  it("restores the persisted choice at worker start", async () => {
    store.set(KEY, new Response("epoxy"));
    await transport.engineReady();
    expect(transport.currentEngine()).toBe("epoxy");
  });

  it("persists a switch for the next worker instance", async () => {
    transport.wispTransport.switchEngine("libcurl");
    expect(transport.currentEngine()).toBe("libcurl");
    await settle();
    const cached = store.get(KEY);
    expect(cached).toBeTruthy();
    expect(await cached!.text()).toBe("libcurl");
  });
});
