/* #415: a connect-class failure fans across every concurrent
   request on the same wedged singleton. The reset+re-init must be
   shared per client generation: one reset per generation, later
   failures await it and retry on the fresh client, instead of each
   request running its own reset (the chatgpt singleton-reset
   storm). The vendored module is mocked. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: 0,
  resets: 0,
  mode: "fail-until-reset" as "fail-until-reset" | "manual",
  pending: [] as Array<{ resolve: (v: Response) => void; reject: (e: unknown) => void }>,
}));

vi.mock("../libcurl-transport-vendored", () => ({
  init: async () => {},
  fetch: () => {
    h.calls++;
    if (h.mode === "manual") {
      return new Promise<Response>((resolve, reject) => h.pending.push({ resolve, reject }));
    }
    if (h.resets === 0) return Promise.reject(new Error("websocket did not open"));
    return Promise.resolve(new Response("ok", { status: 200 }));
  },
  isConnectClassError: (err: unknown) =>
    err instanceof Error && /websocket did not open/i.test(err.message),
  reset: () => {
    h.resets++;
  },
  setEngine: () => {},
  currentEngine: () => "libcurl",
  openWebSocket: () => ({}) as unknown,
}));

import { transportResetForTests, wispTransport } from "../transport";

beforeEach(() => {
  h.calls = 0;
  h.resets = 0;
  h.mode = "fail-until-reset";
  h.pending.length = 0;
  transportResetForTests(500);
});

describe("shared reset+re-init (#415)", () => {
  it("one reset serves a concurrent failure fan", async () => {
    const rs = await Promise.all([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    for (const r of rs) expect(r.status).toBe(200);
    /* 3 first attempts + 3 retries, but only ONE reset+re-init */
    expect(h.calls).toBe(6);
    expect(h.resets).toBe(1);
  });

  it("a late failure from the old generation does not reset the fresh client", async () => {
    h.mode = "manual";
    const a = wispTransport.fetch("https://a.example/a");
    const b = wispTransport.fetch("https://a.example/b");
    /* both first attempts are pending on the mock */
    for (let i = 0; i < 50 && h.pending.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    h.pending[0].reject(new Error("websocket did not open"));
    /* A's retry resolves on the fresh client */
    for (let i = 0; i < 50 && h.pending.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    h.pending[2].resolve(new Response("a", { status: 200 }));
    expect((await a).status).toBe(200);
    expect(h.resets).toBe(1);
    /* B's failure lands late, after the generation moved on: it
       must not reset the fresh client again */
    h.pending[1].reject(new Error("websocket did not open"));
    for (let i = 0; i < 50 && h.pending.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    h.pending[3].resolve(new Response("b", { status: 200 }));
    expect((await b).status).toBe(200);
    expect(h.resets).toBe(1);
  });
});
