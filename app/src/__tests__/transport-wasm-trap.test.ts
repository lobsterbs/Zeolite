/* #514 regression: a wasm trap inside the vendored singleton (a
   RuntimeError, "memory access out of bounds" and the emscripten trap
   family) poisons the client for every later request. The trap must be
   classified connect-class so wispFetch resets the singleton: idempotent
   requests get the one reset+retry, non-idempotent requests fail
   honestly ONCE and schedule the deferred reset - instead of the
   pre-fix behavior where the trap matched no class, no reset was ever
   scheduled, and every later fetch/navigation died with the same trap
   (the CI "upstream fetch failed -> goto-timeout cascade").

   The vendored module is mocked except isConnectClassError, which is
   the REAL classifier under test. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: 0,
  trapFirst: false,
  resets: 0,
}));

vi.mock("../libcurl-transport-vendored", async (importOriginal) => {
  const real = await importOriginal<typeof import("../libcurl-transport-vendored")>();
  return {
    ...real,
    uploadStreamingSupported: () => false,
    init: async () => {},
    fetch: () => {
      h.calls++;
      if (h.trapFirst) {
        h.trapFirst = false;
        const trap = Object.assign(new Error("memory access out of bounds"), {
          name: "RuntimeError",
        });
        return Promise.reject(trap);
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
    reset: () => {
      h.resets++;
    },
    setEngine: () => {},
    currentEngine: () => "libcurl",
    openWebSocket: () => ({}) as unknown,
    /* the classifier under test stays real */
    isConnectClassError: real.isConnectClassError,
  };
});

import { transportResetForTests, wispTransport } from "../transport";
import { TransportDeliveryError, deliveryStateOf } from "../delivery";

beforeEach(() => {
  h.calls = 0;
  h.trapFirst = false;
  h.resets = 0;
  transportResetForTests(15);
});

describe("#514 wasm trap classification", () => {
  it("the real classifier treats a wasm RuntimeError trap as connect-class", async () => {
    const { isConnectClassError } = await import("../libcurl-transport-vendored");
    const trap = Object.assign(new Error("memory access out of bounds"), { name: "RuntimeError" });
    expect(isConnectClassError(trap)).toBe(true);
    expect(isConnectClassError(new Error("RuntimeError: memory access out of bounds"))).toBe(true);
    expect(isConnectClassError(new Error("ordinary failure"))).toBe(false);
  });

  it("GET traps are reset and retried once on a fresh client", async () => {
    h.trapFirst = true;
    const r = await wispTransport.fetch("https://a.example/");
    expect(r.status).toBe(200);
    expect(h.calls).toBe(2);
    expect(h.resets).toBe(1);
  });

  it("POST traps are not retried (no duplicated side effect) but still schedule the reset", async () => {
    h.trapFirst = true;
    const err = await wispTransport
      .fetch("https://a.example/", { method: "POST", body: "x=1" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TransportDeliveryError);
    expect(deliveryStateOf(err)).toBe("delivery-unknown");
    expect(h.calls).toBe(1);
    /* the deferred reset runs once the load drains (the finally in
       wispFetch), un-wedging the singleton for later requests */
    await new Promise((r) => setTimeout(r, 50));
    expect(h.resets).toBe(1);
  });

  it("after a trap+reset, later requests ride the fresh client and succeed", async () => {
    h.trapFirst = true;
    await expect(wispTransport.fetch("https://a.example/", { method: "POST", body: "x=1" })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    const r = await wispTransport.fetch("https://b.example/");
    expect(r.status).toBe(200);
    expect(h.calls).toBe(2); // the trapped POST + the recovered GET
  });
});
