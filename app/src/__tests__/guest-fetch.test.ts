/* #477 wave 2 regression tests: the kernel-side synthetic fetch
   dispatch seam. Every uncertain path fails closed to the engine path;
   the 250 ms budget is enforced; the harness exposes a bounded fetch
   event facade (plain request + respondWith) and a no-handler fast
   reply. The seam is not wired into the live engine request path yet;
   that wiring (Zeolite SSRF, cookies, policy) is the next wave. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_FETCH_BUDGET_MS, GuestKernel, guestHarness } from "../kernel/guests/executor";

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
}

const ORIGIN = "https://site.example";

function kernelUp(): { kernel: GuestKernel; host: FakePort; guest: FakePort } {
  const kernel = new GuestKernel(() => 1000);
  const host = mkPort();
  const guest = mkPort();
  kernel.registerHost(host);
  kernel.spawn(
    {
      pageUrl: ORIGIN + "/",
      scriptURL: ORIGIN + "/sw.js",
      script: "self.addEventListener('fetch',function(){})",
    },
    () => {},
  );
  expect(host.sent.length).toBe(1);
  host.onmessage!({ data: { kind: "zl:guestSpawned", origin: ORIGIN, port: guest } });
  expect(guest.onmessage).not.toBeNull();
  expect(guest.sent).toEqual([
    { zl: "guestEvent", type: "install" },
    { zl: "guestEvent", type: "activate" },
  ]);
  return { kernel, host, guest };
}

function fetchEvent(guest: FakePort): { id: number; request: { url: string; method: string } } {
  const ev = guest.sent.find(
    (m) => typeof m === "object" && m !== null && (m as { zl?: unknown; type?: unknown }).zl === "guestEvent" && (m as { type?: unknown }).type === "fetch",
  );
  return (ev as { data: { id: number; request: { url: string; method: string } } }).data;
}

describe("guest fetch harness facade (#477 wave 2)", () => {
  it("gives fetch events a plain request and a respondWith that posts one bounded reply", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    /* Seed a capturing addEventListener: the harness registers its
       message bridge through the ambient global before replacing it
       with its own listener capture. */
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.addEventListener('fetch',function(e){e.respondWith({status:201,headers:{'x-a':'1'},body:'ok'});});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({ data: { zl: "harnessPort" }, ports: [port] });
    expect(port.sent).toContainEqual({ zl: "guestReady" });
    port.onmessage!({
      data: { zl: "guestEvent", type: "fetch", data: { id: 7, request: { url: ORIGIN + "/x", method: "GET" } } },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(port.sent).toContainEqual({
      zl: "guestFetchResponse",
      id: 7,
      response: { status: 201, headers: { "x-a": "1" }, body: "ok" },
    });
  });

  it("answers a fetch event with no listener immediately instead of burning the budget", () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    new Function("self", guestHarness(ORIGIN + "/", ORIGIN + "/sw.js"))(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({ data: { zl: "harnessPort" }, ports: [port] });
    port.onmessage!({ data: { zl: "guestEvent", type: "fetch", data: { id: 9, request: { url: ORIGIN + "/y", method: "GET" } } } });
    expect(port.sent).toContainEqual({ zl: "guestFetchNoHandler", id: 9 });
  });
});

describe("GuestKernel.dispatchFetch (#477 wave 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves handled:false immediately with no guest or a non-running guest", async () => {
    const kernel = new GuestKernel(() => 1000);
    const req = { url: ORIGIN + "/x", method: "GET" };
    expect(await kernel.dispatchFetch(ORIGIN, req)).toEqual({ handled: false });
    const host = mkPort();
    const guest = mkPort();
    kernel.registerHost(host);
    kernel.spawn({ pageUrl: ORIGIN + "/", scriptURL: ORIGIN + "/sw.js", script: "" }, () => {});
    /* Still in the spawning state: no synthetic dispatch may leak. */
    expect(await kernel.dispatchFetch(ORIGIN, req)).toEqual({ handled: false });
    host.onmessage!({ data: { kind: "zl:guestSpawned", origin: ORIGIN, port: guest } });
    /* Running with no listener: the harness no-handler fast fail is
       covered at the harness level; here the kernel must still fail
       closed within the budget. */
    const pr = kernel.dispatchFetch(ORIGIN, req);
    await vi.advanceTimersByTimeAsync(GUEST_FETCH_BUDGET_MS + 10);
    await expect(pr).resolves.toEqual({ handled: false });
  });

  it("resolves a well-formed guest response through the validated outcome", async () => {
    const { kernel, guest } = kernelUp();
    const pr = kernel.dispatchFetch(ORIGIN, { url: ORIGIN + "/x", method: "GET" });
    const ev = fetchEvent(guest);
    expect(ev.request).toEqual({ url: ORIGIN + "/x", method: "GET" });
    guest.onmessage!({ data: { zl: "guestFetchResponse", id: ev.id, response: { status: 200, headers: { "x-a": "1" }, body: "x" } } });
    await expect(pr).resolves.toEqual({ handled: true, status: 200, headers: { "x-a": "1" }, body: "x" });
  });

  it("fails closed on a malformed guest response", async () => {
    const { kernel, guest } = kernelUp();
    const pr = kernel.dispatchFetch(ORIGIN, { url: ORIGIN + "/x", method: "GET" });
    const ev = fetchEvent(guest);
    guest.onmessage!({ data: { zl: "guestFetchResponse", id: ev.id, response: { status: "200", headers: {}, body: null } } });
    await expect(pr).resolves.toEqual({ handled: false });
  });

  it("fails closed on the guest no-handler reply", async () => {
    const { kernel, guest } = kernelUp();
    const pr = kernel.dispatchFetch(ORIGIN, { url: ORIGIN + "/x", method: "GET" });
    const ev = fetchEvent(guest);
    guest.onmessage!({ data: { zl: "guestFetchNoHandler", id: ev.id } });
    await expect(pr).resolves.toEqual({ handled: false });
  });

  it("fails closed when the 250 ms budget expires without an answer", async () => {
    const { kernel, guest } = kernelUp();
    const pr = kernel.dispatchFetch(ORIGIN, { url: ORIGIN + "/x", method: "GET" });
    const ev = fetchEvent(guest);
    expect(ev.id).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(GUEST_FETCH_BUDGET_MS + 10);
    await expect(pr).resolves.toEqual({ handled: false });
  });

  it("fails closed for pending fetches when the guest terminates", async () => {
    const { kernel, host, guest } = kernelUp();
    const pr = kernel.dispatchFetch(ORIGIN, { url: ORIGIN + "/x", method: "GET" });
    kernel.terminate(ORIGIN);
    expect(host.sent.some((m) => typeof m === "object" && m !== null && (m as { op?: unknown }).op === "terminate")).toBe(true);
    await expect(pr).resolves.toEqual({ handled: false });
  });
});

