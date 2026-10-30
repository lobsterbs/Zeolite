/* #538 regression tests: registration.update(). The script refetch
   rides the engine bridge (never a raw path); identical bytes answer
   no-change; changed bytes resolve the caller, terminate the old
   realm, and spawn the replacement over the same record with the
   site's caches preserved. Every failure fails closed. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_NETFETCH_BUDGET_MS, GuestKernel, guestHarness } from "../kernel/guests/executor";

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
const OLD_SCRIPT = "self.old=1;";
const NEW_SCRIPT = "self.new=1;";

function kernelUp(script: string): { kernel: GuestKernel; host: FakePort; guest: FakePort } {
  const kernel = new GuestKernel(() => 1000);
  const host = mkPort();
  const guest = mkPort();
  kernel.registerHost(host);
  kernel.spawn(
    { pageUrl: ORIGIN + "/", scriptURL: ORIGIN + "/sw.js", script },
    () => {},
  );
  host.onmessage!({ data: { kind: "zl:guestSpawned", origin: ORIGIN, port: guest } });
  return { kernel, host, guest };
}

function updateResult(guest: FakePort): { ok: boolean; error?: string } | undefined {
  const frames = guest.sent.filter(
    (m) => typeof m === "object" && m !== null && (m as { zl?: unknown }).zl === "guestUpdateResult",
  );
  return frames[frames.length - 1] as { ok: boolean; error?: string } | undefined;
}

describe("registration.update() (#538)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed when no engine bridge is wired", () => {
    const { guest } = kernelUp(OLD_SCRIPT);
    guest.onmessage!({ data: { zl: "guestControl", op: "update", id: 1 } });
    expect(updateResult(guest)?.ok).toBe(false);
    expect(updateResult(guest)?.error).toContain("bridge unavailable");
  });

  it("answers no-change when the refetched bytes are identical", async () => {
    const { kernel, host, guest } = kernelUp(OLD_SCRIPT);
    const calls: string[] = [];
    kernel.wireFetch(async (r) => {
      calls.push(r.url);
      return { status: 200, headers: {}, body: OLD_SCRIPT };
    });
    guest.onmessage!({ data: { zl: "guestControl", op: "update", id: 2 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([ORIGIN + "/sw.js"]);
    expect(updateResult(guest)?.ok).toBe(true);
    expect(kernel.pendingNetFetches()).toBe(0);
    /* No realm replacement happened. */
    expect(host.sent.filter((m) => (m as { op?: string }).op === "terminate")).toEqual([]);
    expect(kernel.active()).toEqual([{ origin: ORIGIN, state: "running" }]);
  });

  it("replaces the realm when the script changed, preserving the caches", async () => {
    const { kernel, host, guest } = kernelUp(OLD_SCRIPT);
    kernel.wireFetch(async (r) => {
      if (r.url === ORIGIN + "/sw.js") return { status: 200, headers: {}, body: NEW_SCRIPT };
      return { status: 200, headers: {}, body: "sub" };
    });
    /* Seed one cache entry so the swap's preservation is observable. */
    guest.onmessage!({
      data: { zl: "guestCaches", id: 10, op: "open", payload: { name: "v1" } },
    });
    guest.onmessage!({
      data: {
        zl: "guestCaches",
        id: 11,
        op: "put",
        payload: { name: "v1", url: ORIGIN + "/keep", entry: { status: 200, statusText: "", headers: {}, body: "kept" } },
      },
    });
    guest.onmessage!({ data: { zl: "guestControl", op: "update", id: 3 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateResult(guest)?.ok).toBe(true);
    /* The replacement is deferred one tick after the reply. */
    vi.advanceTimersByTime(1);
    const spawnFrames = host.sent.filter((m) => (m as { op?: string }).op === "spawn") as Array<{
      origin: string;
      script: string;
    }>;
    expect(spawnFrames.length).toBe(2);
    expect(spawnFrames[1].script).toContain(NEW_SCRIPT);
    expect(spawnFrames[1].script).not.toContain(OLD_SCRIPT);
    expect(spawnFrames[1].script.startsWith(guestHarness(ORIGIN + "/", ORIGIN + "/sw.js"))).toBe(true);
    /* The new realm handshakes to running over the same record. */
    const reborn = mkPort();
    host.onmessage!({ data: { kind: "zl:guestSpawned", origin: ORIGIN, port: reborn } });
    expect(kernel.active()).toEqual([{ origin: ORIGIN, state: "running" }]);
    expect(reborn.sent).toEqual([
      { zl: "guestEvent", type: "install" },
      { zl: "guestEvent", type: "activate" },
    ]);
    /* The site's caches survived the realm swap. */
    reborn.onmessage!({
      data: { zl: "guestCaches", id: 12, op: "match", payload: { name: "v1", url: ORIGIN + "/keep" } },
    });
    const frames = reborn.sent.filter((m) => (m as { zl?: unknown }).zl === "guestCachesResult");
    expect((frames[0] as { result: { body: string } }).result.body).toBe("kept");
  });

  it("fails closed when the refetch errors, is not 200, or the budget expires", async () => {
    const { kernel, guest } = kernelUp(OLD_SCRIPT);
    kernel.wireFetch(async () => {
      throw new Error("network down");
    });
    guest.onmessage!({ data: { zl: "guestControl", op: "update", id: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateResult(guest)?.error).toContain("network down");
    kernel.wireFetch(async () => ({ status: 404, headers: {}, body: "not found" }));
    guest.onmessage!({ data: { zl: "guestControl", op: "update", id: 2 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updateResult(guest)?.error).toContain("404");
    kernel.wireFetch(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    guest.onmessage!({ data: { zl: "guestControl", op: "update", id: 3 } });
    vi.advanceTimersByTime(GUEST_NETFETCH_BUDGET_MS + 1);
    expect(updateResult(guest)?.error).toContain("budget");
    expect(kernel.pendingNetFetches()).toBe(0);
    expect(kernel.active()).toEqual([{ origin: ORIGIN, state: "running" }]);
  });
});

describe("guest harness update facade (#538)", () => {
  it("resolves update() from the port reply", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.up=null;self.upErr=null;" +
      "self.addEventListener('install',function(e){" +
      "self.registration.update().then(function(v){self.up=v;},function(err){self.upErr=String(err);});});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({
      data: { zl: "harnessPort" },
      ports: [port],
    });
    port.onmessage!({ data: { zl: "guestEvent", type: "install" } });
    const frame = port.sent.find((m) => (m as { zl?: unknown; op?: unknown }).zl === "guestControl") as {
      id: number;
      op: string;
    };
    expect(frame.op).toBe("update");
    port.onmessage!({ data: { zl: "guestUpdateResult", id: frame.id, ok: true, changed: false } });
    await new Promise((r) => setTimeout(r, 10));
    expect((self as { up: unknown }).up).toBe(true);
    expect((self as { upErr: unknown }).upErr).toBeNull();
  });
});
