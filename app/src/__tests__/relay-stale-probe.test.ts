import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/* #558/#561: a registered relay port can outlive its embedder. A
   top-level escape (the accounts.google.com ServiceLogin frame-bust
   class) destroys the register page, so the fetch parks on the full
   header deadline with no host page left to ever answer. The stale
   probe looks for any live host client once, past
   RELAY_STALE_PROBE_MS with no first frame: none means channel death,
   so the port is dropped (relayAvailable goes false, the next fetch
   takes the re-register path) and the wedged fetch resolves null so
   idempotent callers fall back. A live host client, or a newer
   registration, must never be clobbered by the probe. Fresh module
   state per test via vi.resetModules. */

describe("relay stale-port probe (#558/#561)", () => {
  let relayRegister: (p: MessagePort, credits?: unknown) => void;
  let relayFetch: (
    dest: string,
    init: { method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal },
    traceId: string,
  ) => Promise<Response | null>;
  let relayAvailable: () => boolean;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.resetModules();
    const mod = await import("../relayfetch");
    relayRegister = mod.relayRegister;
    relayFetch = mod.relayFetch;
    relayAvailable = mod.relayAvailable;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  class FakePort {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    postMessage(): void { /* dead port: silent */ }
  }

  const stubClients = (urls: string[]) => {
    vi.stubGlobal("self", {
      location: { origin: "https://app.example" },
      clients: { matchAll: async () => urls.map((url) => ({ url })) },
    });
  };

  it("drops a stale port when no host client is alive and the fetch falls back (#558)", async () => {
    stubClients([]);
    relayRegister(new FakePort() as unknown as MessagePort);
    expect(relayAvailable()).toBe(true);
    const p = relayFetch("https://www.google.com/", { method: "GET", headers: new Headers() }, "t1");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await p).toBeNull();
    expect(relayAvailable()).toBe(false);
  });

  it("keeps the channel when a host client is alive; the full header deadline stands (#561)", async () => {
    stubClients(["https://app.example/"]);
    relayRegister(new FakePort() as unknown as MessagePort);
    let settled = false;
    const p = relayFetch("https://www.google.com/", { method: "GET", headers: new Headers() }, "t2")
      .then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(7_500);
    expect(settled).toBe(false);
    expect(relayAvailable()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBeNull();
    expect(relayAvailable()).toBe(true);
  });

  it("never clobbers a newer registration with the probe (#558)", async () => {
    stubClients([]);
    const portA = new FakePort() as unknown as MessagePort;
    relayRegister(portA);
    const pA = relayFetch("https://www.google.com/", { method: "GET", headers: new Headers() }, "t3");
    /* a newer registration owns the channel while fetch A is pending */
    relayRegister(new FakePort() as unknown as MessagePort);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(relayAvailable()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pA).toBeNull();
    expect(relayAvailable()).toBe(true);
  });
});
