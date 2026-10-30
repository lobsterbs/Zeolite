/* #538 regression tests: bounded waitUntil. Every promise a guest
   hands to an event's waitUntil opens a kernel-side tracker with a
   hard deadline; settlement closes it, the deadline abandons it, and
   teardown of the realm clears every tracker for the origin. The
   engine never blocks a response on waitUntil. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_WAITUNTIL_MS, GuestKernel, guestHarness } from "../kernel/guests/executor";

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
    { pageUrl: ORIGIN + "/", scriptURL: ORIGIN + "/sw.js", script: "self.x=1;" },
    () => {},
  );
  host.onmessage!({ data: { kind: "zl:guestSpawned", origin: ORIGIN, port: guest } });
  return { kernel, host, guest };
}

describe("bounded waitUntil (#538)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks a waitUntil promise and closes the tracker on settlement", () => {
    const { kernel, guest } = kernelUp();
    expect(kernel.pendingWaits()).toBe(0);
    guest.onmessage!({ data: { zl: "guestWait", wid: 1 } });
    expect(kernel.pendingWaits()).toBe(1);
    guest.onmessage!({ data: { zl: "guestWaitDone", wid: 1, ok: true } });
    expect(kernel.pendingWaits()).toBe(0);
    vi.advanceTimersByTime(GUEST_WAITUNTIL_MS + 1);
    expect(kernel.pendingWaits()).toBe(0);
  });

  it("abandons the tracker at the hard budget and tolerates the late done frame", () => {
    const { kernel, guest } = kernelUp();
    guest.onmessage!({ data: { zl: "guestWait", wid: 2 } });
    expect(kernel.pendingWaits()).toBe(1);
    vi.advanceTimersByTime(GUEST_WAITUNTIL_MS + 1);
    expect(kernel.pendingWaits()).toBe(0);
    expect(() => guest.onmessage!({ data: { zl: "guestWaitDone", wid: 2, ok: false, error: "late" } })).not.toThrow();
    expect(kernel.pendingWaits()).toBe(0);
  });

  it("ignores malformed wait frames", () => {
    const { kernel, guest } = kernelUp();
    expect(() => guest.onmessage!({ data: { zl: "guestWait" } })).not.toThrow();
    expect(() => guest.onmessage!({ data: { zl: "guestWait", wid: "x" } })).not.toThrow();
    expect(() => guest.onmessage!({ data: { zl: "guestWaitDone" } })).not.toThrow();
    expect(kernel.pendingWaits()).toBe(0);
  });

  it("clears every tracker for the origin on terminate", () => {
    const { kernel, guest } = kernelUp();
    guest.onmessage!({ data: { zl: "guestWait", wid: 3 } });
    guest.onmessage!({ data: { zl: "guestWait", wid: 4 } });
    expect(kernel.pendingWaits()).toBe(2);
    kernel.terminate(ORIGIN);
    expect(kernel.pendingWaits()).toBe(0);
    vi.advanceTimersByTime(GUEST_WAITUNTIL_MS + 1);
    expect(kernel.pendingWaits()).toBe(0);
  });
});

describe("guest harness waitUntil facade (#538)", () => {
  it("reports waitUntil settlement over the port", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.addEventListener('install',function(e){e.waitUntil(Promise.resolve(7));});" +
      "self.addEventListener('activate',function(e){e.waitUntil(Promise.reject(new Error('nope')));});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({
      data: { zl: "harnessPort" },
      ports: [port],
    });
    port.onmessage!({ data: { zl: "guestEvent", type: "install" } });
    port.onmessage!({ data: { zl: "guestEvent", type: "activate" } });
    expect(port.sent).toContainEqual({ zl: "guestWait", wid: 1 });
    expect(port.sent).toContainEqual({ zl: "guestWait", wid: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(port.sent).toContainEqual({ zl: "guestWaitDone", wid: 1, ok: true });
    expect(port.sent).toContainEqual({ zl: "guestWaitDone", wid: 2, ok: false, error: "Error: nope" });
  });
});
