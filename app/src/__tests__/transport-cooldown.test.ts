/* Stall-storm cooldown (2026-10-11 YouTube diag): three first-byte
   stalls within the window flip the transport into relay-first
   cooldown. Without a relay channel the wisp path stays honest (and
   a success clears the storm); with a registered embedder relay the
   requests ride it instead of eating another 30s deadline. The
   vendored module is mocked: these tests exercise the storm state
   machine, not the wasm transport. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetchImpl: (_d: string, _i?: RequestInit): Promise<Response> => new Promise<Response>(() => {}),
}));

vi.mock("../libcurl-transport-vendored", () => ({
  init: async () => {},
  fetch: (d: string, i?: RequestInit) => h.fetchImpl(d, i),
  isConnectClassError: () => false,
  reset: () => {},
  setEngine: () => {},
  currentEngine: () => "libcurl",
  openWebSocket: () => {
    throw new Error("not used here");
  },
}));

import { transportResetForTests, wispCoolingForTests, wispTransport } from "../transport";
import { relayRegister } from "../relayfetch";

beforeEach(() => {
  transportResetForTests(15);
});

class FakePort {
  sent: unknown[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  postMessage(m: unknown): void {
    this.sent.push(m);
    const rid = (m as { rid: number }).rid;
    const fire = (data: unknown) => this.onmessage?.(new MessageEvent("message", { data }));
    setTimeout(() => {
      fire({ type: "zl:relayHead", rid, status: 200, statusText: "OK", headers: [["content-type", "text/plain"]] });
      fire({ type: "zl:relayEnd", rid });
    }, 0);
  }
}

describe("wisp stall-storm cooldown", () => {
  it("three stalls within the window arm the cooldown; without a relay the wisp path stays honest", async () => {
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    /* no relay registered: the cooldown cannot carry the request, the
       wisp stall surfaces honestly instead of failing fast */
    const fourth = await wispTransport.fetch("https://a.example/4").then(
      () => "resolved",
      (err: Error) => String(err),
    );
    expect(fourth).toContain("no first byte within 15ms");
  });

  it("a first-byte wisp success clears the storm window and the cooldown", async () => {
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    h.fetchImpl = () => Promise.resolve(new Response("ok", { status: 200 }));
    const resp = await wispTransport.fetch("https://a.example/heal");
    expect(await resp.text()).toBe("ok");
    expect(wispCoolingForTests()).toBe(false);
  });

  it("during cooldown a registered relay serves the request", async () => {
    /* re-arm: the healed impl from the previous test stalls again */
    h.fetchImpl = () => new Promise<Response>(() => {});
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    relayRegister(new FakePort() as unknown as MessagePort);
    const resp = await wispTransport.fetch("https://a.example/relayed");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("");
  });

  it("cooldown relay propagates the abort signal to the embedder (#145)", async () => {
    h.fetchImpl = () => new Promise<Response>(() => {});
    await Promise.allSettled([
      wispTransport.fetch("https://a.example/1"),
      wispTransport.fetch("https://a.example/2"),
      wispTransport.fetch("https://a.example/3"),
    ]);
    expect(wispCoolingForTests()).toBe(true);
    class QuietPort {
      sent: unknown[] = [];
      onmessage: ((ev: MessageEvent) => void) | null = null;
      postMessage(m: unknown): void {
        this.sent.push(m);
      }
    }
    const port = new QuietPort();
    relayRegister(port as unknown as MessagePort);
    const ac = new AbortController();
    const respP = wispTransport.fetch("https://a.example/abortme", { signal: ac.signal });
    ac.abort();
    const err = await respP.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.name).toBe("AbortError");
    expect(port.sent.some((m) => (m as { type: string }).type === "zl:relayCancel")).toBe(true);
  });
});
