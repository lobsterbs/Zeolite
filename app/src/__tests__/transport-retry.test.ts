/* #251/#255 acceptance: the automatic reset+retry only rides
   idempotent requests with replayable bodies ("websocket did not
   open" is pre-send and safe for any method), and the first-byte
   deadline aborts the abandoned upstream fetch through the signal
   the vendored request accepts. The vendored module is mocked; the
   cancel/backpressure surface of the vendored stream lives in
   transport-patch.test.ts. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ dest: string; method?: string; body?: unknown; signal?: AbortSignal | null }>,
  failFirst: null as string | null,
  stall: false,
}));

vi.mock("../libcurl-transport-vendored", () => ({
  init: async () => {},
  fetch: (dest: string, init?: RequestInit) => {
    h.calls.push({ dest, method: init?.method, body: init?.body, signal: init?.signal });
    if (h.failFirst !== null) {
      const msg = h.failFirst;
      h.failFirst = null;
      return Promise.reject(new Error(msg));
    }
    if (h.stall) {
      /* abort-aware stalled upstream: never answers, rejects when
         the transport aborts it (#255) */
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("The operation was aborted.")),
          { once: true },
        );
      });
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  },
  isConnectClassError: (err: unknown) =>
    err instanceof Error && /websocket did not open|failed sending data/i.test(err.message),
  reset: () => {},
  setEngine: () => {},
  currentEngine: () => "libcurl",
  openWebSocket: () => ({}) as unknown,
}));

import { transportResetForTests, wispTransport } from "../transport";
import { TransportDeliveryError, deliveryStateOf } from "../delivery";

beforeEach(() => {
  h.calls.length = 0;
  h.failFirst = null;
  h.stall = false;
  transportResetForTests(15);
});

describe("transport retry safety (#251)", () => {
  it("GET is retried once on a connect-class failure", async () => {
    h.failFirst = "failed sending data";
    const r = await wispTransport.fetch("https://a.example/");
    expect(r.status).toBe(200);
    expect(h.calls.length).toBe(2);
  });

  it("POST is not retried on a connect-class failure (no duplicated side effect)", async () => {
    h.failFirst = "failed sending data";
    await expect(
      wispTransport.fetch("https://a.example/", { method: "POST", body: "x=1" }),
    ).rejects.toThrow("failed sending data");
    expect(h.calls.length).toBe(1);
  });

  it("a failed dispatched POST has an explicit delivery-unknown state and transport", async () => {
    h.failFirst = "websocket did not open";
    const err = await wispTransport.fetch("https://a.example/", { method: "POST", body: "x=1" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TransportDeliveryError);
    expect(deliveryStateOf(err)).toBe("delivery-unknown");
    expect((err as TransportDeliveryError).transport).toBe("wisp");
    expect(h.calls).toHaveLength(1);
  });

  it("POST error text cannot prove non-delivery", async () => {
    h.failFirst = "websocket did not open";
    await expect(wispTransport.fetch("https://a.example/", { method: "POST", body: "x=1" })).rejects.toThrow("websocket did not open");
    expect(h.calls.length).toBe(1);
  });

  it("a stream body is never retried, even on a GET", async () => {
    h.failFirst = "failed sending data";
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    await expect(
      wispTransport.fetch("https://a.example/", { method: "GET", body }),
    ).rejects.toThrow("failed sending data");
    expect(h.calls.length).toBe(1);
  });

  it("PUT and DELETE with byte bodies are replayable and retried", async () => {
    for (const method of ["PUT", "DELETE"]) {
      h.calls.length = 0;
      h.failFirst = "failed sending data";
      const r = await wispTransport.fetch("https://a.example/", { method, body: "abc" });
      expect(r.status).toBe(200);
      expect(h.calls.length).toBe(2);
    }
  });
});

describe("first-byte deadline cancels abandoned fetches (#255)", () => {
  it("the deadline aborts the stalled upstream fetch and surfaces a stall", async () => {
    h.stall = true;
    const err = await wispTransport.fetch("https://a.example/").then(
      () => null,
      (e: Error) => e,
    );
    expect(String(err)).toContain("no first byte within 15ms");
    /* the abort reached the vendored fetch: the stalled upstream
       was cancelled, not left running (#255) */
    expect(h.calls[0].signal?.aborted).toBe(true);
  });

  it("a non-idempotent stall is not retried", async () => {
    h.stall = true;
    await expect(
      wispTransport.fetch("https://a.example/", { method: "POST", body: "x=1" }),
    ).rejects.toThrow("no first byte within 15ms");
    expect(h.calls.length).toBe(1);
  });

  it("a caller abort stays an honest abort error, not a stall", async () => {
    h.stall = true;
    const caller = new AbortController();
    const p = wispTransport.fetch("https://a.example/", { signal: caller.signal });
    /* abort mid-flight, once the transport has wired its signal */
    setTimeout(() => caller.abort(), 5);
    await expect(p).rejects.toThrow("The operation was aborted.");
  });
});
