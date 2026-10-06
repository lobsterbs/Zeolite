import { describe, expect, it, vi, beforeEach } from "vitest";

/* Issue #84 acceptance: contract-level tests around the Transport
   interface. The vendored libcurl client is mocked; the real
   transport behavior (wisp protocol, epoxy, streaming) stays covered
   by the wasm/browser CI jobs and suite/epoxy-diag.mjs. */

const mock = vi.hoisted(() => ({
  initCalls: 0,
  failInit: false,
  failNextFetch: null as string | null,
  fetches: [] as string[],
  resetCalls: 0,
}));

vi.mock("../libcurl-transport-vendored", () => ({
  init: async () => {
    mock.initCalls++;
    if (mock.failInit) throw new Error("init boom");
  },
  fetch: async (url: string, _init?: RequestInit) => {
    mock.fetches.push(url);
    if (mock.failNextFetch !== null) {
      const msg = mock.failNextFetch;
      mock.failNextFetch = null;
      throw new Error(msg);
    }
    return new Response("ok:" + url);
  },
  isConnectClassError: (err: unknown) => err instanceof Error && err.message === "websocket did not open",
  reset: () => {
    mock.resetCalls++;
  },
  setEngine: () => {},
  currentEngine: () => "libcurl",
  openWebSocket: () => ({}) as unknown,
}));

import type { Transport } from "../transport";

const setDegraded = vi.fn((_reason: string) => {});

/* curlReady is module state; each test gets a fresh transport. */
async function freshTransport(): Promise<Transport> {
  vi.resetModules();
  const mod = await import("../transport");
  mod.initTransport({ setDegraded });
  return mod.wispTransport;
}

beforeEach(() => {
  mock.initCalls = 0;
  mock.failInit = false;
  mock.failNextFetch = null;
  mock.fetches = [];
  mock.resetCalls = 0;
  setDegraded.mockClear();
});

describe("Transport contract (#84)", () => {
  it("initializes lazily, once, on the first fetch", async () => {
    const t = await freshTransport();
    const r = await t.fetch("https://target.example/");
    expect(r.status).toBe(200);
    await t.fetch("https://target.example/b");
    expect(mock.initCalls).toBe(1);
    expect(mock.fetches).toEqual(["https://target.example/", "https://target.example/b"]);
  });

  it("ready() initializes without a fetch", async () => {
    const t = await freshTransport();
    await t.ready();
    expect(mock.initCalls).toBe(1);
  });

  it("reports init failure through setDegraded and allows retry", async () => {
    mock.failInit = true;
    const t = await freshTransport();
    await expect(t.ready()).rejects.toThrow("init boom");
    expect(setDegraded.mock.calls.some((c) => String(c[0]).startsWith("libcurl transport: "))).toBe(true);
    mock.failInit = false;
    await t.ready(); /* retry allowed, not a dead singleton */
    expect(mock.initCalls).toBe(2);
  });

  it("resets and retries once on a connect-class failure (#74)", async () => {
    mock.failNextFetch = "websocket did not open";
    const t = await freshTransport();
    const r = await t.fetch("https://target.example/");
    expect(mock.resetCalls).toBe(1);
    expect(mock.initCalls).toBe(2); /* re-init after the reset */
    expect(r.status).toBe(200);
    expect(mock.fetches).toEqual(["https://target.example/", "https://target.example/"]);
  });

  it("propagates non-connect errors without a reset", async () => {
    mock.failNextFetch = "http 500";
    const t = await freshTransport();
    await expect(t.fetch("https://target.example/")).rejects.toThrow("http 500");
    expect(mock.resetCalls).toBe(0);
    expect(setDegraded).not.toHaveBeenCalled();
  });

  it("switchEngine invalidates the initialized client", async () => {
    const t = await freshTransport();
    await t.ready();
    expect(mock.initCalls).toBe(1);
    t.switchEngine("epoxy");
    await t.ready();
    expect(mock.initCalls).toBe(2);
  });
});
