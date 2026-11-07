import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: { ready: async () => {} },
  altRegister: () => {},
  altConfig: () => {},
  altConfigured: () => false,
  /* persistRoute reads these; the mock must answer them or the
     silent storage catch swallows the TypeError. */
  altEndpoint: () => null,
  primaryWispOverrideValue: () => null,
}));

vi.mock("../ws-runtime", () => ({
  wsBridge: { open: () => {}, closeAll: () => {} },
}));

import { handleControlEvent, type ControlMessage } from "../control";
import { persistRoute } from "../request";
import { setQueryRoutes } from "../swstate";

/* #633: the route shape must survive both a prefix-less config push
   (the old unconditional "/j/" default poisoned the persisted
   record, so every later idle-killed worker restored /j/ under
   pages still holding routes minted with the deployment prefix -
   the orphaned-route ERR_FAILED storm) and a worker re-evaluation
   (the query-shape flag now persists with the rest of the shape). */

const mkEvent = (sourceUrl: string, msg: ControlMessage) => {
  const posted: unknown[] = [];
  const ev = {
    data: msg,
    ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
    source: { url: sourceUrl, id: "c1" },
  } as unknown as ExtendableMessageEvent;
  return { ev, posted };
};

const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

describe("zl:config prefix semantics (#633)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the live prefix when the push omits it", async () => {
    const a = mkEvent("https://w.example.org/", { type: "zl:config", prefix: "/k/" });
    await handleControlEvent(a.ev, deps);
    expect(a.posted[0]).toMatchObject({ ok: true, prefix: "/k/" });
    const b = mkEvent("https://w.example.org/", { type: "zl:config", imageLazy: true });
    await handleControlEvent(b.ev, deps);
    expect(b.posted[0]).toMatchObject({ ok: true, prefix: "/k/" });
  });

  it("still rotates when the push provides a prefix", async () => {
    const a = mkEvent("https://w.example.org/", { type: "zl:config", prefix: "/m/" });
    await handleControlEvent(a.ev, deps);
    expect(a.posted[0]).toMatchObject({ ok: true, prefix: "/m/" });
  });

  it("still refuses an invalid prefix atomically", async () => {
    const a = mkEvent("https://w.example.org/", { type: "zl:config", prefix: "/bad" });
    await handleControlEvent(a.ev, deps);
    expect(a.posted[0]).toMatchObject({ ok: false });
    expect(String((a.posted[0] as { error?: string }).error)).toContain("bad prefix");
  });
});

describe("persistRoute carries the query-shape flag (#633)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setQueryRoutes(true);
  });

  it("writes the live query-routes value into the route shape", async () => {
    const puts: { url: string; body: string }[] = [];
    vi.stubGlobal("self", { registration: { scope: "https://engine.test/" } });
    vi.stubGlobal("caches", {
      open: async () => ({
        put: async (url: string, res: Response) => {
          puts.push({ url, body: await res.text() });
        },
      }),
    });
    setQueryRoutes(true);
    await persistRoute("/j/");
    expect(puts[0].body).toContain("query-routes #true");
    setQueryRoutes(false);
    await persistRoute("/j/");
    expect(puts[1].body).toContain("query-routes #false");
  });
});
