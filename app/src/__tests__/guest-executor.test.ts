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

  it("terminates on request and on guest unregister, and confirms cleanup", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const origin = (host.sent[0] as { origin: string }).origin;
    const guest = new FakePort();
    host.deliver({ kind: "zl:guestSpawned", origin, port: guest });
    const c = collect();
    k.terminate(origin, c.push);
    expect(c.replies[0].ok).toBe(true);
    const tf = host.sent.find((m) => (m as { op?: string }).op === "terminate");
    expect(tf).toBeTruthy();
    /* Guest-initiated unregister also triggers termination. */
    guest.deliver({ zl: "guestControl", op: "unregister" });
    expect(host.sent.filter((m) => (m as { op?: string }).op === "terminate").length).toBe(2);
    host.deliver({ kind: "zl:guestTerminated", origin });
    expect(k.active()).toEqual([]);
    const second = collect();
    k.terminate(origin, second.push);
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

  it("refuses a second spawn while the guest is running", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    k.spawn(spawnMsg(), () => {});
    const origin = (host.sent[0] as { origin: string }).origin;
    host.deliver({ kind: "zl:guestSpawned", origin, port: new FakePort() });
    const again = collect();
    k.spawn(spawnMsg(), again.push);
    expect(again.replies[0].ok).toBe(false);
    expect(again.replies[0].error).toContain("already active");
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
  it("shadows network and storage globals and carries no kernel handles", () => {
    const h = guestHarness("https://a.example/", "https://a.example/sw.js");
    expect(h).toContain('"fetch","XMLHttpRequest","WebSocket","importScripts","caches","indexedDB"');
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
