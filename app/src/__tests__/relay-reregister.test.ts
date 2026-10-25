import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/* #354: an idle worker restart drops the stored relay port and
   controllerchange never fires; a relay-routed fetch asks the embedder
   to re-register (zl:relayLost broadcast) and waits once, bounded.
   Fresh module state per test via vi.resetModules. */

describe("relay re-registration after a worker restart (#354)", () => {
  let relayRegister: (p: MessagePort) => void;
  let relayAvailable: () => boolean;
  let requestRelayReRegister: (d: number, t: string, u: string) => Promise<boolean>;
  let pending: () => number;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.resetModules();
    const mod = await import("../relayfetch");
    relayRegister = mod.relayRegister;
    relayAvailable = mod.relayAvailable;
    requestRelayReRegister = mod.requestRelayReRegister;
    pending = mod.relayReRegisterPendingForTests;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  class FakePort {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    posted: unknown[] = [];
    postMessage(data: unknown): void {
      this.posted.push(data);
    }
  }

  it("broadcasts zl:relayLost and resolves true when the embedder re-registers", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("clients", { matchAll: async () => [{ postMessage: (m: unknown) => posts.push(m) }] });
    const p = requestRelayReRegister(5_000, "t1", "https://ddg.example/");
    await vi.advanceTimersByTimeAsync(5);
    expect(posts).toEqual([{ type: "zl:relayLost" }]);
    expect(relayAvailable()).toBe(false);
    relayRegister(new FakePort() as unknown as MessagePort);
    expect(await p).toBe(true);
    expect(relayAvailable()).toBe(true);
  });

  it("answers false on the deadline, then backs off without re-broadcasting", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("clients", { matchAll: async () => [{ postMessage: (m: unknown) => posts.push(m) }] });
    const p = requestRelayReRegister(25, "t2", "https://ddg.example/");
    await vi.advanceTimersByTimeAsync(25);
    expect(await p).toBe(false);
    expect(pending()).toBe(0);
    expect(posts).toHaveLength(1);
    /* backoff window: the second call refuses immediately, no second
       broadcast, no wait. */
    const p2 = requestRelayReRegister(25, "t3", "https://ddg.example/");
    expect(await p2).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it("stays bounded with no clients API in the realm", async () => {
    const p = requestRelayReRegister(10, "t4", "https://x.example/");
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(false);
    expect(pending()).toBe(0);
  });

  it("does not retain expired callbacks through repeated recovery attempts", async () => {
    vi.stubGlobal("clients", { matchAll: async () => [] });
    for (let i = 0; i < 5; i++) {
      const p = requestRelayReRegister(10, "t" + i, "https://x.example/");
      await vi.advanceTimersByTimeAsync(10);
      expect(await p).toBe(false);
      expect(pending()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_001);
    }
    const active = requestRelayReRegister(100, "active", "https://x.example/");
    await vi.advanceTimersByTimeAsync(0);
    expect(pending()).toBe(1);
    relayRegister(new FakePort() as unknown as MessagePort);
    expect(await active).toBe(true);
    expect(pending()).toBe(0);
  });
});
