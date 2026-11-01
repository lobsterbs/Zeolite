import { describe, expect, it } from "vitest";
import { GuestKernel, type GuestPortLike } from "../kernel/guests/executor";

class FakePort implements GuestPortLike {
  sent: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  postMessage(data: unknown): void { this.sent.push(data); }
  close(): void {}
  deliver(data: unknown): void { this.onmessage?.({ data }); }
}

describe("multiple virtual Service Worker scopes", () => {
  it("keeps registrations independent and dispatches to the longest matching scope", async () => {
    const kernel = new GuestKernel(() => 1000);
    const host = new FakePort();
    kernel.registerHost(host);
    const origin = "https://site.example";
    const spawn = (scope: string, scriptURL: string, script: string) =>
      kernel.spawn({ pageUrl: origin + "/", scriptURL, scope, script, confirm: true }, () => {});
    spawn(origin + "/", origin + "/sw.js", "self.root = true;");
    spawn(origin + "/app/", origin + "/app/sw.js", "self.nested = true;");

    const spawns = host.sent.filter((m) => (m as { op?: string }).op === "spawn") as Array<{ origin: string; scope: string; id: number }>;
    expect(spawns).toHaveLength(2);
    const root = new FakePort();
    const nested = new FakePort();
    host.deliver({ kind: "zl:guestSpawned", ...spawns[0], port: root });
    host.deliver({ kind: "zl:guestSpawned", ...spawns[1], port: nested });
    expect(kernel.active()).toHaveLength(2);

    const request = { url: origin + "/app/page", method: "GET" };
    const response = kernel.dispatchFetchForUrl(request.url, request);
    const event = nested.sent.find((m) => (m as { type?: string }).type === "fetch") as { data: { id: number } };
    expect(event).toBeTruthy();
    expect(root.sent.filter((m) => (m as { type?: string }).type === "fetch")).toHaveLength(0);
    nested.deliver({ zl: "guestFetchResponse", id: event.data.id, response: { status: 200, headers: {}, body: "nested" } });
    await expect(response).resolves.toMatchObject({ handled: true, body: "nested" });

    const nestedSpawn = spawns[1];
    const result: Array<{ ok: boolean }> = [];
    kernel.unregisterScope(origin, nestedSpawn.scope, origin + "/app/sw.js", (r) => result.push(r));
    expect(result).toEqual([{ ok: true }]);
    host.deliver({ kind: "zl:guestTerminated", ...nestedSpawn });
    expect(kernel.active()).toHaveLength(1);

    const fallback = kernel.dispatchFetchForUrl(request.url, request);
    const rootEvent = root.sent.find((m) => (m as { type?: string }).type === "fetch") as { data: { id: number } };
    expect(rootEvent).toBeTruthy();
    root.deliver({ zl: "guestFetchResponse", id: rootEvent.data.id, response: { status: 200, headers: {}, body: "root" } });
    await expect(fallback).resolves.toMatchObject({ handled: true, body: "root" });
  });

  it("does not let a stale registration facade unregister a replacement", () => {
    const kernel = new GuestKernel(() => 1000);
    const host = new FakePort();
    kernel.registerHost(host);
    const origin = "https://site.example";
    const scope = origin + "/app/";
    kernel.spawn({ pageUrl: origin + "/", scriptURL: origin + "/app/old.js", scope, script: "old", confirm: true }, () => {});
    kernel.spawn({ pageUrl: origin + "/", scriptURL: origin + "/app/new.js", scope, script: "new", confirm: true }, () => {});
    const spawns = host.sent.filter((m) => (m as { op?: string }).op === "spawn") as Array<{ origin: string; scope: string; id: number }>;
    const current = spawns[spawns.length - 1];
    const result: Array<{ ok: boolean }> = [];
    kernel.unregisterScope(origin, scope, origin + "/app/old.js", (r) => result.push(r));
    expect(result).toEqual([{ ok: true }]);
    expect(kernel.active()).toEqual([{ origin, state: "spawning" }]);
    host.deliver({ kind: "zl:guestSpawned", ...current, port: new FakePort() });
    expect(kernel.active()).toEqual([{ origin, state: "running" }]);
  });
});
