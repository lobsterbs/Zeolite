import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  GUEST_HANDSHAKE_MS,
  GUEST_SCRIPT_MAX,
  GuestKernel,
  guestHarness,
  type GuestPortLike,
  type GuestReply,
  type GuestSpawnMessage,
} from "../kernel/guests/executor";
/* #477 wave 1: the guest kernel state machine. Every fix and honest
   limit in the kernel ships with a unit proof here; the live worker
   spawn needs the guest-host page in a real browser, so this suite
   pins the protocol instead. */

class FakePort implements GuestPortLike {
  sent: unknown[] = [];
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    if (this.onmessage) this.onmessage({ data });
  }
}

function spawnMsg(over: Partial<GuestSpawnMessage> = {}): GuestSpawnMessage {
  return {
    pageUrl: "https://a.example/",
    scriptURL: "https://a.example/sw.js",
    script: "self.x=1;",
    ...over,
  };
}

function collect(): { replies: GuestReply[]; push: (r: GuestReply) => void } {
  const replies: GuestReply[] = [];
  return { replies, push: (r) => replies.push(r) };
}

describe("guest kernel", () => {
  it("refuses a spawn with no host page connected and keeps no state", () => {
    const k = new GuestKernel(() => 0);
    const c = collect();
    k.spawn(spawnMsg(), c.push);
    expect(c.replies[0].ok).toBe(false);
    expect(c.replies[0].error).toContain("no guest host page connected");
    expect(k.active()).toEqual([]);
  });

  it("validates the registration identity fail-closed", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    const c = collect();
    k.spawn(spawnMsg({ scriptURL: "https://evil.example/sw.js" }), c.push);
    expect(c.replies[0].ok).toBe(false);
    expect(c.replies[0].error).toContain("must share the verified page origin");
    expect(k.active()).toEqual([]);
  });

  it("refuses a script body above the size cap", () => {
    const k = new GuestKernel(() => 0);
    k.registerHost(new FakePort());
    const c = collect();
    k.spawn(spawnMsg({ script: "a".repeat(GUEST_SCRIPT_MAX + 1) }), c.push);
    expect(c.replies[0].ok).toBe(false);
    expect(c.replies[0].error).toContain("size cap");
    expect(k.active()).toEqual([]);
  });

  it("completes the spawn handshake and dispatches install before activate", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    const c = collect();
    k.spawn(spawnMsg(), c.push);
    expect(c.replies[0].ok).toBe(true);
    expect(c.replies[0].origin).toBe("https://a.example");
    const frame = host.sent[0] as { op: string; origin: string; script: string };
    expect(frame.op).toBe("spawn");
    expect(frame.origin).toBe("https://a.example");
    /* The body rides verbatim after the harness prelude. */
    expect(frame.script).toContain("self.x=1;");
    expect(frame.script).toContain("harnessPort");
    const guest = new FakePort();
    host.deliver({ kind: "zl:guestSpawned", origin: frame.origin, port: guest });
    expect(guest.sent[0]).toEqual({ zl: "guestEvent", type: "install" });
    expect(guest.sent[1]).toEqual({ zl: "guestEvent", type: "activate" });
    expect(k.active()).toEqual([{ origin: frame.origin, state: "running" }]);
  });

  it("routes guest messages to the listener and contains malformed frames", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const frame = host.sent[0] as { origin: string };
    const guest = new FakePort();
    host.deliver({ kind: "zl:guestSpawned", origin: frame.origin, port: guest });
    const hits: [string, unknown][] = [];
    k.listener((origin, data) => hits.push([origin, data]));
    guest.deliver({ zl: "guestMessage", data: { n: 1 } });
    expect(hits).toEqual([["https://a.example", { n: 1 }]]);
    /* Malformed frames must not throw and must not reach the listener. */
    expect(() => guest.deliver({ zl: "bogus" })).not.toThrow();
    expect(() => guest.deliver("garbage")).not.toThrow();
    expect(hits.length).toBe(1);
    /* A throwing listener is contained too. */
    k.listener(() => {
      throw new Error("listener crash");
    });
    expect(() => guest.deliver({ zl: "guestMessage", data: 2 })).not.toThrow();
  });

  it("terminates on host request and on guest unregister, confirming each exact generation", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const firstFrame = host.sent[0] as { origin: string; scope: string; id: number };
    const firstGuest = new FakePort();
    host.deliver({ kind: "zl:guestSpawned", ...firstFrame, port: firstGuest });

    const c = collect();
    k.terminate(firstFrame.origin, c.push);
    expect(c.replies[0].ok).toBe(true);
    expect(host.sent.filter((m) => (m as { op?: string }).op === "terminate")).toHaveLength(1);
    host.deliver({ kind: "zl:guestTerminated", ...firstFrame });
    expect(k.active()).toEqual([]);

    /* A new running generation can independently unregister itself. */
    k.spawn(spawnMsg(), () => {});
    const frames = host.sent.filter((m) => (m as { op?: string }).op === "spawn") as Array<{ origin: string; scope: string; id: number }>;
    const secondFrame = frames[1];
    const secondGuest = new FakePort();
    host.deliver({ kind: "zl:guestSpawned", ...secondFrame, port: secondGuest });
    secondGuest.deliver({ zl: "guestControl", op: "unregister" });
    expect(host.sent.filter((m) => (m as { op?: string }).op === "terminate")).toHaveLength(2);
    host.deliver({ kind: "zl:guestTerminated", ...secondFrame });
    expect(k.active()).toEqual([]);

    const second = collect();
    k.terminate(firstFrame.origin, second.push);
    expect(second.replies[0].ok).toBe(false);
    expect(second.replies[0].error).toContain("no guest for origin");
  });

  it("reaps a dead spawn on its deadline and frees the origin", () => {
    let t = 0;
    const k = new GuestKernel(() => t);
    const host = new FakePort();
    k.registerHost(host);
    const first = collect();
    k.spawn(spawnMsg(), first.push);
    expect(first.replies[0].ok).toBe(true);
    /* No guest confirmation ever arrives; the deadline passes. */
    t = GUEST_HANDSHAKE_MS + 1;
    const again = collect();
    k.spawn(spawnMsg(), again.push);
    expect(again.replies[0].ok).toBe(true);
    expect(k.active().length).toBe(1);
    expect(k.active()[0].state).toBe("spawning");
  });

  it("re-registers idempotently and replaces changed script bytes only at the same scope", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const firstFrame = host.sent[0] as { origin: string; scope: string; id: number };
    host.deliver({ kind: "zl:guestSpawned", ...firstFrame, port: new FakePort() });

    const again = collect();
    k.spawn(spawnMsg(), again.push);
    expect(again.replies[0].ok).toBe(true);
    expect(again.replies[0].origin).toBe(firstFrame.origin);
    expect(host.sent.filter((m) => (m as { op?: string }).op === "spawn")).toHaveLength(1);

    const changed = collect();
    k.spawn({ ...spawnMsg(), scriptURL: "https://a.example/sw2.js", script: "self.x=2;" }, changed.push);
    expect(changed.replies[0].ok).toBe(true);
    const frames = host.sent.filter((m) => (m as { op?: string }).op === "spawn") as Array<{ origin: string; scope: string; id: number; script: string }>;
    expect(frames).toHaveLength(2);
    expect(frames[1].scope).toBe(firstFrame.scope);
    expect(frames[1].id).not.toBe(firstFrame.id);
    expect(frames[1].script).toContain("self.x=2;");
    expect(k.active()).toEqual([{ origin: firstFrame.origin, state: "spawning" }]);
  });

  it("drops the record when the host reports a spawn failure", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const origin = (host.sent[0] as { origin: string }).origin;
    host.deliver({ kind: "zl:guestSpawnFailed", origin, error: "SyntaxError: boom" });
    expect(k.active()).toEqual([]);
    const again = collect();
    k.spawn(spawnMsg(), again.push);
    expect(again.replies[0].ok).toBe(true);
  });

  it("ignores a stale guestTerminated from a superseded terminate", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const origin = (host.sent[0] as { origin: string }).origin;
    host.deliver({ kind: "zl:guestSpawned", origin, port: new FakePort() });
    k.terminate(origin);
    /* Re-spawn while the old terminate is in flight. */
    const again = collect();
    k.spawn(spawnMsg(), again.push);
    expect(again.replies[0].ok).toBe(true);
    expect(k.active()[0].state).toBe("spawning");
    /* The stale confirmation from the FIRST terminate arrives late. */
    host.deliver({ kind: "zl:guestTerminated", origin });
    /* The new spawning record must survive it. */
    expect(k.active()).toEqual([{ origin, state: "spawning" }]);
  });

  it("terminates the guest when the host reports a worker error", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const origin = (host.sent[0] as { origin: string }).origin;
    host.deliver({ kind: "zl:guestSpawned", origin, port: new FakePort() });
    host.deliver({ kind: "zl:guestError", origin, error: "Uncaught SyntaxError" });
    const tf = host.sent.find((m) => (m as { op?: string }).op === "terminate");
    expect(tf).toBeTruthy();
    expect(k.active()[0].state).toBe("terminating");
  });
});

describe("guest harness prelude", () => {
  it("shadows raw network and storage globals and carries no kernel handles", () => {
    const h = guestHarness("https://a.example/", "https://a.example/sw.js");
    /* #538: fetch and caches are no longer shadowed; they are bridged
       through the engine port so the engine pipeline owns every byte.
       XHR, WebSocket, importScripts and indexedDB stay unavailable. */
    expect(h).toContain('"XMLHttpRequest","WebSocket","importScripts","indexedDB"');
    expect(h).toContain("guestNetFetch");
    expect(h).toContain("guestCaches");
    expect(h).toContain("harnessPort");
    expect(h).toContain("guestReady");
    expect(h).toContain('"scope":"https://a.example/"');
    /* No kernel handle may leak into the guest realm. */
    expect(h).not.toContain("caches.open");
    expect(h).not.toContain("indexedDB.open");
    expect(h).not.toMatch(/kernel|storage\.open|fetchEvent/);
  });

  it("ends with a newline so the guest body starts on its own line", () => {
    const h = guestHarness("https://a.example/", "https://a.example/sw.js");
    expect(h.endsWith("})();\n")).toBe(true);
  });

  it("installs facades over getter-only accessors like a real Worker realm", () => {
    /* Real-Chromium oracle (2026-10-30 probe): WorkerGlobalScope.caches
       is a getter-only accessor, so plain self.caches = ... throws in
       strict mode, the harness aborts, and the install event then dies
       on an undefined registration facade. Every override must install
       through Object.defineProperty and never throw. */
    const h = guestHarness("https://a.example/", "https://a.example/sw.js");
    const proto: Record<string, unknown> = {
      addEventListener(t: string, f: unknown) {
        const s = this as { __l?: Record<string, unknown[]> };
        (s.__l ??= {})[t] = [f];
      },
    };
    Object.defineProperty(proto, "caches", { get() { return { native: true }; } });
    const fakeSelf = Object.create(proto) as Record<string, unknown>;
    const run = new Function("self", h) as (s: unknown) => void;
    expect(() => run(fakeSelf)).not.toThrow();
    const caches = fakeSelf.caches as Record<string, unknown>;
    expect(typeof caches.open).toBe("function");
    expect(caches.native).toBeUndefined();
    expect(typeof fakeSelf.fetch).toBe("function");
    const reg = fakeSelf.registration as { scope?: string };
    expect(reg.scope).toBe("https://a.example/");
    expect(typeof fakeSelf.skipWaiting).toBe("function");
  });
});


describe("guest host page contract", () => {
  it("registers with the control-plane type field, not a foreign shape", () => {
    const html = readFileSync(new URL("../../guest-host.html", import.meta.url), "utf8");
    /* handleControlEvent dispatches on msg.type; a kind field would
       be silently ignored and the host page would never register. */
    expect(html).toContain('postMessage({ type: "zl:guestHost" }');
    expect(html).not.toContain('kind: "zl:guestHost"');
    /* The kernel frames arrive on the port with the op field. */
    expect(html).toContain('d.op === "spawn"');
    expect(html).toContain('d.op === "terminate"');
  });
});

describe("guest clients facade (#596)", () => {
  it("kernel answers matchAll from the wired provider and [] unwired", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const frame = host.sent[0] as { origin: string };
    const guest = new FakePort();
    host.deliver({ kind: "zl:guestSpawned", origin: frame.origin, port: guest });
    /* Unwired: honest empty list, never a hang. */
    guest.deliver({ zl: "guestControl", op: "matchAll", id: 1 });
    expect(guest.sent.find((m) => (m as { zl?: string; id?: number }).zl === "guestClientsResult")).toEqual({
      zl: "guestClientsResult",
      id: 1,
      clients: [],
    });
    /* Wired: the engine's live virtual contexts enumerate. */
    k.wireClients(() => [
      { id: "c1", url: "https://a.example/", kind: "window" },
      { id: "w1", url: "https://a.example/w.js", kind: "worker" },
    ]);
    guest.deliver({ zl: "guestControl", op: "matchAll", id: 2 });
    expect(guest.sent.filter((m) => (m as { id?: number }).id === 2)[0]).toEqual({
      zl: "guestClientsResult",
      id: 2,
      clients: [
        { id: "c1", url: "https://a.example/", kind: "window" },
        { id: "w1", url: "https://a.example/w.js", kind: "worker" },
      ],
    });
  });

  it("kernel drops a matchAll from a realm that is not running", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const guest = new FakePort();
    /* Pre-spawn: the record is still in the handshake, so no reply. */
    guest.deliver({ zl: "guestControl", op: "matchAll", id: 1 });
    expect(guest.sent.some((m) => (m as { zl?: string }).zl === "guestClientsResult")).toBe(false);
  });

  it("realm facade maps matchAll/get clients and filters by type", async () => {
    const h = guestHarness("https://a.example/", "https://a.example/sw.js");
    const listeners: Record<string, Array<(ev: { data: unknown; ports?: unknown[] }) => void>> = {};
    const proto: Record<string, unknown> = {
      addEventListener(t: string, f: (ev: { data: unknown; ports?: unknown[] }) => void) {
        (listeners[t] ??= []).push(f);
      },
    };
    Object.defineProperty(proto, "caches", { get() { return { native: true }; } });
    const fakeSelf = Object.create(proto) as Record<string, unknown>;
    const run = new Function("self", h) as (s: unknown) => void;
    expect(() => run(fakeSelf)).not.toThrow();
    const guestPort = new FakePort();
    listeners["message"][0]({ data: { zl: "harnessPort" }, ports: [guestPort] });
    const clients = fakeSelf.clients as {
      matchAll(o?: { type?: string; includeUncontrolled?: boolean }): Promise<unknown[]>;
      get(id: string): Promise<unknown>;
    };
    const asks = () =>
      guestPort.sent.filter((m) => (m as { zl?: string; op?: string }).op === "matchAll") as Array<{ id: number }>;
    /* Native default (includeUncontrolled:false) answers [] with no
       kernel round-trip: the engine tracks no control relationship. */
    expect(await clients.matchAll()).toEqual([]);
    expect(asks().length).toBe(0);
    expect(await clients.matchAll({ type: "window" })).toEqual([]);
    expect(asks().length).toBe(0);
    /* window filter drops the worker-kind client; frameType maps by kind. */
    const winP = clients.matchAll({ type: "window", includeUncontrolled: true });
    guestPort.deliver({
      zl: "guestClientsResult",
      id: asks()[asks().length - 1].id,
      clients: [
        { id: "c1", url: "https://a.example/", kind: "window" },
        { id: "w1", url: "https://a.example/w.js", kind: "worker" },
      ],
    });
    expect(await winP).toEqual([{ id: "c1", url: "https://a.example/", frameType: "top-level", type: "window" }]);
    /* all returns the worker-kind client with the honest none frameType. */
    const allP = clients.matchAll({ type: "all", includeUncontrolled: true });
    guestPort.deliver({
      zl: "guestClientsResult",
      id: asks()[asks().length - 1].id,
      clients: [{ id: "w1", url: "https://a.example/w.js", kind: "worker" }],
    });
    expect(await allP).toEqual([{ id: "w1", url: "https://a.example/w.js", frameType: "none", type: "worker" }]);
    /* get resolves a snapshot entry by id. */
    const getP = clients.get("c1");
    guestPort.deliver({
      zl: "guestClientsResult",
      id: asks()[asks().length - 1].id,
      clients: [{ id: "c1", url: "https://a.example/", kind: "window" }],
    });
    expect(await getP).toEqual({ id: "c1", url: "https://a.example/", frameType: "top-level", type: "window" });
  });

  it("registration.unregister is truthful end to end and openWindow stays rejected", async () => {
    const h = guestHarness("https://a.example/", "https://a.example/sw.js");
    const listeners: Record<string, Array<(ev: { data: unknown; ports?: unknown[] }) => void>> = {};
    const proto: Record<string, unknown> = {
      addEventListener(t: string, f: (ev: { data: unknown; ports?: unknown[] }) => void) {
        (listeners[t] ??= []).push(f);
      },
    };
    Object.defineProperty(proto, "caches", { get() { return { native: true }; } });
    const fakeSelf = Object.create(proto) as Record<string, unknown>;
    const run = new Function("self", h) as (s: unknown) => void;
    run(fakeSelf);
    /* Without a port the realm is not ready: the honest answer is false. */
    const reg0 = fakeSelf.registration as { unregister(): Promise<boolean> };
    await expect(reg0.unregister()).resolves.toBe(false);
    const guestPort = new FakePort();
    listeners["message"][0]({ data: { zl: "harnessPort" }, ports: [guestPort] });
    /* With the port up the kernel terminate arm owns the realm: the
       round-trip fires and the promise resolves true. */
    const reg = fakeSelf.registration as { unregister(): Promise<boolean> };
    await expect(reg.unregister()).resolves.toBe(true);
    expect(guestPort.sent).toContainEqual({ zl: "guestControl", op: "unregister" });
    const clients = fakeSelf.clients as { openWindow(u: string): Promise<unknown> };
    await expect(clients.openWindow("https://a.example/")).rejects.toThrow("unsupported");
  });
});
