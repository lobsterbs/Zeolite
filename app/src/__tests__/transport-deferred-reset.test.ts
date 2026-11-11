/* #514 regression: a connect-class or stall failure that is not
   retried (isolated list loads, non-idempotent requests) used to
   throw without any state hygiene, leaving the wedged singleton
   serving every later request: the redirect/RSPOOL cascades where
   one failed POST is followed by "Failed to fetch" for everything.
   The reset is deferred to the last in-flight request leaving, so
   in-flight page requests (#577) are never killed. The vendored
   module is mocked, same harness as transport-shared-reset. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: 0,
  resets: 0,
  altResets: 0,
  mode: "fail-until-reset" as "fail-until-reset" | "manual",
  pending: [] as Array<{ resolve: (v: Response) => void; reject: (e: unknown) => void }>,
}));

vi.mock("../libcurl-transport-vendored", () => ({
  uploadStreamingSupported: () => false,
  init: async () => {},
  fetch: () => {
    h.calls++;
    if (h.mode === "manual") {
      return new Promise<Response>((resolve, reject) => h.pending.push({ resolve, reject }));
    }
    if (h.resets === 0) return Promise.reject(new Error("websocket did not open"));
    return Promise.resolve(new Response("ok", { status: 200 }));
  },
  altFetch: () => {
    h.calls++;
    if (h.altResets === 0) return Promise.reject(new Error("websocket did not open"));
    return Promise.resolve(new Response("ok", { status: 200 }));
  },
  isConnectClassError: (err: unknown) =>
    err instanceof Error && /websocket did not open/i.test(err.message),
  reset: () => {
    h.resets++;
  },
  altReset: () => {
    h.altResets++;
  },
  setEngine: () => {},
  currentEngine: () => "libcurl",
  openWebSocket: () => ({}) as unknown,
  altRegister: () => true,
  altConfigured: () => true,
  altEndpoint: () => "wss://alt.example/ws",
}));

import { transportResetForTests, wispTransport, altWispFetch } from "../transport";

beforeEach(() => {
  h.calls = 0;
  h.resets = 0;
  h.altResets = 0;
  h.mode = "fail-until-reset";
  h.pending.length = 0;
  transportResetForTests(500);
});

describe("deferred reset for non-retried transport failures (#514)", () => {
  it("a failed non-idempotent request resets the client once idle, so the next POST rides a fresh client", async () => {
    await expect(
      wispTransport.fetch("https://a.example/echo", { method: "POST", body: "x" }),
    ).rejects.toThrow(/websocket did not open/);
    /* the deferred reset fired at idle, inside the failing request's own leave */
    expect(h.resets).toBe(1);
    /* the cascade is gone: the next POST succeeds on the first attempt */
    const r = await wispTransport.fetch("https://a.example/echo", { method: "POST", body: "y" });
    expect(r.status).toBe(200);
    expect(h.calls).toBe(2); /* 1 failed attempt + 1 fresh success, no retry storm */
  });

  it("an isolated failure defers the reset until the last in-flight request leaves", async () => {
    h.mode = "manual";
    const fetchAny = wispTransport.fetch as unknown as (
      dest: string,
      init?: RequestInit,
      traceId?: string,
      opts?: { isolated?: boolean },
    ) => Promise<Response>;
    const isolated = fetchAny("https://a.example/list", undefined, "", { isolated: true });
    const page = wispTransport.fetch("https://a.example/page");
    for (let i = 0; i < 50 && h.pending.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    /* the isolated list load fails first */
    h.pending[0].reject(new Error("websocket did not open"));
    await expect(isolated).rejects.toThrow(/websocket did not open/);
    /* in-flight page request still rides the client: no reset yet */
    expect(h.resets).toBe(0);
    h.pending[1].resolve(new Response("p", { status: 200 }));
    expect((await page).status).toBe(200);
    /* now idle: the deferred reset fires */
    expect(h.resets).toBe(1);
  });

  it("the alt wisp route resets its client after a non-retried failure", async () => {
    await expect(
      altWispFetch("https://a.example/route", { method: "POST", body: "x" }),
    ).rejects.toThrow(/websocket did not open/);
    expect(h.altResets).toBe(1);
    const r = await altWispFetch("https://a.example/route", { method: "POST", body: "y" });
    expect(r.status).toBe(200);
  });
});

