import { afterEach, describe, expect, it, vi } from "vitest";
import swSrc from "../sw.ts?raw";
import requestSrc from "../request.ts?raw";

/* #381: Ghostery's list fetches ride the transport decision
   (upstreamFetch, relay included) instead of the raw wisp lambda
   that is auth-refused on relay-only embedders; a failed list
   load emits a TRANSPORT diag row instead of failing silently. */

vi.mock("@ghostery/adblocker", () => ({
  FiltersEngine: {
    fromPrebuiltAdsAndTracking: async () => {
      throw new Error("list host down");
    },
  },
  Request: { fromRawDetails: (d: unknown) => d },
}));

class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(data: unknown): void {
    this.posted.push(data);
  }
  deliver(m: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: m }));
  }
}

const LIST_URL =
  "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ads.json";

describe("ghostery list transport (#381)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("wires the list fetch through ghosteryListFetch, not the raw wisp client", () => {
    expect(swSrc).toContain("ghosteryListFetch(dest, init)");
    expect(swSrc).not.toContain("wispTransport.fetch(dest, init)");
    expect(requestSrc).toContain("export function ghosteryListFetch");
  });

  it("routes a list fetch through the relay when the policy says relay", async () => {
    vi.resetModules();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('rule "ghl" { route "relay" }', { status: 200 })) as typeof fetch;
    try {
      const { ghosteryListFetch } = await import("../request");
      const { relayRegister } = await import("../relayfetch");
      const { wispTransport } = await import("../transport");
      const wisp = vi.spyOn(wispTransport, "fetch");
      const port = new FakePort();
      relayRegister(port as unknown as MessagePort);
      const respP = ghosteryListFetch(LIST_URL);
      for (let i = 0; i < 1000 && !port.posted.length; i++) await Promise.resolve();
      const sent = port.posted[0] as { type: string; rid: number };
      expect(sent.type).toBe("zl:fetchRelay");
      port.deliver({ type: "zl:relayHead", rid: sent.rid, status: 200, statusText: "", headers: [["content-type", "application/json"]] });
      port.deliver({ type: "zl:relayEnd", rid: sent.rid });
      const resp = await respP;
      expect(resp.status).toBe(200);
      expect(wisp).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("emits a TRANSPORT row when the list load fails instead of failing silently", async () => {
    const { DIAG } = await import("../diag");
    const emit = vi.spyOn(DIAG, "emit");
    const { configureGhostery, ghosteryBlock, ghosteryLoadInProgress } = await import("../ghostery");
    configureGhostery(() => Promise.reject(new Error("list host down")));
    expect(ghosteryBlock(LIST_URL, "script")).toBeNull();
    const pending = ghosteryLoadInProgress();
    if (pending) await pending;
    const row = emit.mock.calls
      .map((c) => c[0])
      .find((e) => String(e.message).startsWith("ghostery filter-list load failed"));
    expect(row).toBeTruthy();
    expect(row!.category).toBe("TRANSPORT");
  });
});