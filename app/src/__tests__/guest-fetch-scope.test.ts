/* #477 P3 regression tests: the URL-scope router the live request
   path calls before the ordinary engine pipeline. Scope matching is
   the real service-worker contract (origin equality plus path
   prefix); no match fails closed to the ordinary path. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestKernel } from "../kernel/guests/executor";

type FakePort = {
  sent: unknown[];
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

function mkPort(): FakePort {
  const p: FakePort = {
    sent: [],
    postMessage(data: unknown) {
      p.sent.push(data);
    },
    close() {},
    onmessage: null,
  };
  return p;
};

function spawnUp(kernel: GuestKernel, host: FakePort, origin: string, scope?: string): FakePort {
  const guest = mkPort();
  kernel.spawn(
    {
      pageUrl: origin + "/",
      scriptURL: origin + "/sw.js",
      scope,
      script: "self.addEventListener('fetch',function(){})",
    },
    () => {},
  );
  host.onmessage!({ data: { kind: "zl:guestSpawned", origin, port: guest } });
  return guest;
};

function fetchEventOf(guest: FakePort): { id: number } {
  const ev = guest.sent.find(
    (m) => typeof m === "object" && m !== null && (m as { zl?: unknown; type?: unknown }).zl === "guestEvent" && (m as { type?: unknown }).type === "fetch",
  );
  return (ev as { data: { id: number } }).data;
}

function up(): { kernel: GuestKernel; host: FakePort } {
  const kernel = new GuestKernel(() => 1000);
  const host = mkPort();
  kernel.registerHost(host);
  return { kernel, host };
}

describe("GuestKernel.dispatchFetchForUrl (#477 P3 scope router)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches to the running guest whose scope matches the URL", async () => {
    const { kernel, host } = up();
    const guest = spawnUp(kernel, host, "https://site.example");
    const url = "https://site.example/app/page?q=1";
    const pr = kernel.dispatchFetchForUrl(url, { url, method: "GET" });
    const ev = fetchEventOf(guest);
    expect(ev.id).toBeGreaterThan(0);
    guest.onmessage!({ data: { zl: "guestFetchResponse", id: ev.id, response: { status: 200, headers: {}, body: null } } });
    await expect(pr).resolves.toEqual({ handled: true, status: 200, headers: {}, body: null });
  });

  it("fails closed for a URL outside every guest scope", async () => {
    const { kernel, host } = up();
    const guest = spawnUp(kernel, host, "https://site.example");
    const url = "https://other.example/x";
    const pr = kernel.dispatchFetchForUrl(url, { url, method: "GET" });
    await expect(pr).resolves.toEqual({ handled: false });
    /* No synthetic event may reach the guest for another origin. */
    expect(guest.sent).toEqual([
      { zl: "guestEvent", type: "install" },
      { zl: "guestEvent", type: "activate" },
    ]);
  });

  it("honors a sub-path scope: outside fails closed, inside dispatches", async () => {
    const { kernel, host } = up();
    const guest = spawnUp(kernel, host, "https://site.example", "https://site.example/app/");
    const outUrl = "https://site.example/outside/page";
    const outPr = kernel.dispatchFetchForUrl(outUrl, { url: outUrl, method: "GET" });
    await expect(outPr).resolves.toEqual({ handled: false });
    expect(guest.sent).toHaveLength(2);
    const inUrl = "https://site.example/app/page";
    const inPr = kernel.dispatchFetchForUrl(inUrl, { url: inUrl, method: "GET" });
    const ev = fetchEventOf(guest);
    expect(ev.id).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(260);
    await expect(inPr).resolves.toEqual({ handled: false });
  });

  it("never dispatches to a non-running guest", async () => {
    const kernel = new GuestKernel(() => 1000);
    const host = mkPort();
    kernel.registerHost(host);
    kernel.spawn(
      {
        pageUrl: "https://site.example/",
        scriptURL: "https://site.example/sw.js",
        script: "self.addEventListener('fetch',function(){})",
      },
      () => {},
    );
    /* Still spawning: no synthetic dispatch may leak. */
    const url = "https://site.example/x";
    const pr = kernel.dispatchFetchForUrl(url, { url, method: "GET" });
    await expect(pr).resolves.toEqual({ handled: false });
    expect(host.sent).toHaveLength(1);
  });
});
