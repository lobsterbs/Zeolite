import { describe, expect, it } from "vitest";
import {
  GUEST_HANDSHAKE_MS,
  GuestKernel,
  type GuestPortLike,
  type GuestReply,
  type GuestSpawnMessage,
} from "../kernel/guests/executor";

/* #576: a confirmed spawn settles its caller on real kernel truth:
   the reply rides zl:guestSpawned / zl:guestSpawnFailed / the reap
   deadline, never a spawn-request acknowledgment. */

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

function collect(): { push(r: GuestReply): void; replies: GuestReply[] } {
  const replies: GuestReply[] = [];
  return { push: (r) => replies.push(r), replies };
}

function spawnMsg(over: Partial<GuestSpawnMessage> = {}): GuestSpawnMessage {
  return { pageUrl: "https://a.example/", scriptURL: "https://a.example/sw.js", script: "self.x=1;", confirm: true, ...over };
}

describe("guest kernel confirmed spawn (#576)", () => {
  it("defers the reply until zl:guestSpawned, then settles once", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    const c = collect();
    k.spawn(spawnMsg(), c.push);
    expect(c.replies.length).toBe(0);
    const origin = (host.sent[0] as { origin: string }).origin;
    host.deliver({ kind: "zl:guestSpawned", origin, port: new FakePort() });
    expect(c.replies.length).toBe(1);
    expect(c.replies[0].ok).toBe(true);
    expect(c.replies[0].origin).toBe(origin);
    /* A stray duplicate confirmation settles nobody. */
    host.deliver({ kind: "zl:guestSpawned", origin, port: new FakePort() });
    expect(c.replies.length).toBe(1);
  });

  it("passes the host failure through on zl:guestSpawnFailed", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    const c = collect();
    k.spawn(spawnMsg(), c.push);
    const origin = (host.sent[0] as { origin: string }).origin;
    host.deliver({ kind: "zl:guestSpawnFailed", origin, error: "SyntaxError: boom" });
    expect(c.replies.length).toBe(1);
    expect(c.replies[0].ok).toBe(false);
    expect(c.replies[0].error).toContain("guest spawn failed");
    expect(c.replies[0].error).toContain("SyntaxError: boom");
    expect(k.active()).toEqual([]);
  });

  it("reaps a dead confirmed handshake with a timeout error", () => {
    let t = 0;
    const k = new GuestKernel(() => t);
    const host = new FakePort();
    k.registerHost(host);
    const c = collect();
    k.spawn(spawnMsg(), c.push);
    expect(c.replies.length).toBe(0);
    t = GUEST_HANDSHAKE_MS + 1;
    k.tick();
    expect(c.replies.length).toBe(1);
    expect(c.replies[0].ok).toBe(false);
    expect(c.replies[0].error).toBe("guest spawn handshake timed out");
  });

  it("piggybacks a same-identity caller that arrives mid-spawn", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    const first = collect();
    k.spawn(spawnMsg(), first.push);
    const origin = (host.sent[0] as { origin: string }).origin;
    const second = collect();
    k.spawn(spawnMsg(), second.push);
    /* Neither caller settles before the realm is running. */
    expect(first.replies.length).toBe(0);
    expect(second.replies.length).toBe(0);
    host.deliver({ kind: "zl:guestSpawned", origin, port: new FakePort() });
    expect(first.replies.length).toBe(1);
    expect(second.replies.length).toBe(1);
    expect(first.replies[0].ok).toBe(true);
    expect(second.replies[0].ok).toBe(true);
    /* Exactly one spawn reached the host. */
    expect(host.sent.filter((m) => (m as { op?: string }).op === "spawn").length).toBe(1);
  });

  it("keeps the legacy immediate reply without confirm", () => {
    const k = new GuestKernel(() => 0);
    const host = new FakePort();
    k.registerHost(host);
    const c = collect();
    k.spawn(spawnMsg({ confirm: undefined }), c.push);
    expect(c.replies.length).toBe(1);
    expect(c.replies[0].ok).toBe(true);
    const origin = (host.sent[0] as { origin: string }).origin;
    host.deliver({ kind: "zl:guestSpawned", origin, port: new FakePort() });
    expect(c.replies.length).toBe(1);
  });
});
