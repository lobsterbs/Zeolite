import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/* #354: an idle worker restart drops the stored relay port and
   controllerchange never fires; a relay-routed fetch asks the embedder
   to re-register (zl:relayLost broadcast) and waits once, bounded.
   #463: an expired waiter removes itself instead of lingering for the
   worker lifetime. #464: the broadcast reaches HOST clients only.
   Fresh module state per test via vi.resetModules. */

describe("relay re-registration after a worker restart (#354)", () => {
  let relayRegister: (p: MessagePort) => void;
  let relayAvailable: () => boolean;
  let requestRelayReRegister: (d: number, t: string, u: string) => Promise<boolean>;
  let reRegisterWaiterCount: () => number;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.resetModules();
    const mod = await import("../relayfetch");
    relayRegister = mod.relayRegister;
    relayAvailable = mod.relayAvailable;
    requestRelayReRegister = mod.requestRelayReRegister;
    reRegisterWaiterCount = mod.reRegisterWaiterCount;
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

  const stubHostClient = (posts: unknown[], url = "https://app.example/") => {
    vi.stubGlobal("self", {
      location: { origin: "https://app.example" },
      clients: { matchAll: async () => [{ url, postMessage: (m: unknown) => posts.push(m) }] },
    });
  };

  it("broadcasts zl:relayLost to the host client and resolves true when the embedder re-registers (#464)", async () => {
    const posts: unknown[] = [];
    stubHostClient(posts);
    const p = requestRelayReRegister(5_000, "t1", "https://ddg.example/");
    await vi.advanceTimersByTimeAsync(5);
    expect(posts).toEqual([{ type: "zl:relayLost" }]);
    expect(relayAvailable()).toBe(false);
    relayRegister(new FakePort() as unknown as MessagePort);
    expect(await p).toBe(true);
    expect(relayAvailable()).toBe(true);
  });

  it("answers false on the deadline, then backs off; the waiter self-removes (#463)", async () => {
    const posts: unknown[] = [];
    stubHostClient(posts);
    const p = requestRelayReRegister(25, "t2", "https://ddg.example/");
    await vi.advanceTimersByTimeAsync(5);
    expect(reRegisterWaiterCount()).toBe(1); /* the bounded wait is live */
    await vi.advanceTimersByTimeAsync(20);
    expect(await p).toBe(false);
    expect(reRegisterWaiterCount()).toBe(0); /* #463: expired, not lingering */
    expect(posts).toHaveLength(1);
    /* backoff window: the second call refuses immediately, no second
       broadcast, no wait. */
    const p2 = requestRelayReRegister(25, "t3", "https://ddg.example/");
    expect(await p2).toBe(false);
    expect(posts).toHaveLength(1);
    expect(reRegisterWaiterCount()).toBe(0);
  });

  it("stays bounded with no clients API in the realm", async () => {
    const p = requestRelayReRegister(10, "t4", "https://x.example/");
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe(false);
  });
});
