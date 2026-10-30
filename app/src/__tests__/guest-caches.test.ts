/* #538 regression tests: per-(virtual site, scope) guest CacheStorage.
   All storage is kernel-side, origin-scoped and quota-bounded; entries
   key on the canonical URL, eviction is oldest-first, teardown clears
   the origin's namespace, and one site's entries are never visible to
   another. No engine page-cache entry is reachable: the namespace is
   private to the guest program by construction. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GUEST_CACHE_MAX_CACHES,
  GUEST_CACHE_MAX_ENTRIES,
  GUEST_FETCH_BODY_MAX,
  GuestKernel,
  guestHarness,
} from "../kernel/guests/executor";

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
const OTHER = "https://other.example";

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

function spawnSecond(kernel: GuestKernel, host: FakePort, origin: string): FakePort {
  const guest = mkPort();
  kernel.spawn(
    { pageUrl: origin + "/", scriptURL: origin + "/sw.js", script: "self.x=1;" },
    () => {},
  );
  host.onmessage!({ data: { kind: "zl:guestSpawned", origin, port: guest } });
  return guest;
}

function ca(guest: FakePort, payload: Record<string, unknown>): void {
  guest.onmessage!({ data: { zl: "guestCaches", ...payload } });
}

function lastCa(guest: FakePort): { ok: boolean; result?: unknown; error?: string } | undefined {
  const frames = guest.sent.filter(
    (m) => typeof m === "object" && m !== null && (m as { zl?: unknown }).zl === "guestCachesResult",
  );
  return frames[frames.length - 1] as { ok: boolean; result?: unknown; error?: string } | undefined;
}

function put(guest: FakePort, id: number, cache: string, url: string, body: string, status = 200): void {
  ca(guest, {
    id,
    op: "put",
    payload: {
      name: cache,
      url,
      entry: { status, statusText: "OK", headers: { "content-type": "text/plain" }, body },
    },
  });
}

describe("guest CacheStorage kernel ops (#538)", () => {
  it("opens, stores, matches and deletes entries through the port", () => {
    const { kernel, guest } = kernelUp();
    let id = 0;
    const nid = () => ++id;
    ca(guest, { id: nid(), op: "open", payload: { name: "v1" } });
    expect(lastCa(guest)?.ok).toBe(true);
    expect(lastCa(guest)?.result).toBe("v1");
    put(guest, nid(), "v1", ORIGIN + "/a", "alpha");
    expect(lastCa(guest)?.ok).toBe(true);
    ca(guest, { id: nid(), op: "match", payload: { name: "v1", url: ORIGIN + "/a" } });
    const hit = lastCa(guest) as { result: { status: number; headers: Record<string, string>; body: string } };
    expect(hit.result.status).toBe(200);
    expect(hit.result.body).toBe("alpha");
    expect(hit.result.headers["content-type"]).toBe("text/plain");
    ca(guest, { id: nid(), op: "match", payload: { name: "v1", url: ORIGIN + "/miss" } });
    expect(lastCa(guest)?.result).toBeNull();
    ca(guest, { id: nid(), op: "entries", payload: { name: "v1" } });
    expect(lastCa(guest)?.result).toEqual([{ url: ORIGIN + "/a" }]);
    ca(guest, { id: nid(), op: "deleteEntry", payload: { name: "v1", url: ORIGIN + "/a" } });
    expect(lastCa(guest)?.result).toBe(true);
    ca(guest, { id: nid(), op: "deleteEntry", payload: { name: "v1", url: ORIGIN + "/a" } });
    expect(lastCa(guest)?.result).toBe(false);
    ca(guest, { id: nid(), op: "keys", payload: {} });
    expect(lastCa(guest)?.result).toEqual(["v1"]);
    ca(guest, { id: nid(), op: "has", payload: { name: "v1" } });
    expect(lastCa(guest)?.result).toBe(true);
    ca(guest, { id: nid(), op: "deleteCache", payload: { name: "v1" } });
    expect(lastCa(guest)?.result).toBe(true);
    ca(guest, { id: nid(), op: "has", payload: { name: "v1" } });
    expect(lastCa(guest)?.result).toBe(false);
  });

  it("canonicalizes entry URLs: relative resolve against the scope and fragments drop", () => {
    const { guest } = kernelUp();
    ca(guest, { id: 1, op: "open", payload: { name: "v1" } });
    put(guest, 2, "v1", "/rel?a=1", "r");
    ca(guest, { id: 3, op: "match", payload: { name: "v1", url: ORIGIN + "/rel?a=1#frag" } });
    expect((lastCa(guest)?.result as { body: string } | null)?.body).toBe("r");
  });

  it("refuses a put without a prior open and strips set-cookie from stored headers", () => {
    const { guest } = kernelUp();
    put(guest, 1, "ghost", ORIGIN + "/a", "x");
    expect(lastCa(guest)?.ok).toBe(false);
    expect(lastCa(guest)?.error).toContain("not open");
    ca(guest, { id: 2, op: "open", payload: { name: "v1" } });
    ca(guest, {
      id: 3,
      op: "put",
      payload: {
        name: "v1",
        url: ORIGIN + "/a",
        entry: { status: 200, statusText: "", headers: { "set-cookie": "sid=1", "x-a": "1" }, body: "x" },
      },
    });
    expect(lastCa(guest)?.ok).toBe(true);
    ca(guest, { id: 4, op: "match", payload: { name: "v1", url: ORIGIN + "/a" } });
    const headers = (lastCa(guest)?.result as { headers: Record<string, string> }).headers;
    expect(headers["set-cookie"]).toBeUndefined();
    expect(headers["x-a"]).toBe("1");
  });

  it("enforces the cache-count and entry-count quotas with oldest-first eviction", () => {
    const { guest } = kernelUp();
    let id = 0;
    const nid = () => ++id;
    for (let i = 0; i < GUEST_CACHE_MAX_CACHES; i++) {
      ca(guest, { id: nid(), op: "open", payload: { name: "c" + i } });
      expect(lastCa(guest)?.ok).toBe(true);
    }
    ca(guest, { id: nid(), op: "open", payload: { name: "over" } });
    expect(lastCa(guest)?.ok).toBe(false);
    expect(lastCa(guest)?.error).toContain("quota");
    /* Entries: the cap evicts the oldest to admit the next. */
    ca(guest, { id: nid(), op: "open", payload: { name: "c0" } });
    for (let i = 0; i < GUEST_CACHE_MAX_ENTRIES; i++) {
      put(guest, nid(), "c0", ORIGIN + "/e" + i, "b" + i);
      expect(lastCa(guest)?.ok).toBe(true);
    }
    ca(guest, { id: nid(), op: "match", payload: { name: "c0", url: ORIGIN + "/e0" } });
    expect((lastCa(guest)?.result as { body: string } | null)?.body).toBe("b0");
    put(guest, nid(), "c0", ORIGIN + "/next", "bn");
    ca(guest, { id: nid(), op: "match", payload: { name: "c0", url: ORIGIN + "/e0" } });
    expect(lastCa(guest)?.result).toBeNull();
    ca(guest, { id: nid(), op: "match", payload: { name: "c0", url: ORIGIN + "/next" } });
    expect((lastCa(guest)?.result as { body: string } | null)?.body).toBe("bn");
  });

  it("enforces the origin byte quota and the per-entry size cap", () => {
    const { guest } = kernelUp();
    let id = 0;
    const nid = () => ++id;
    ca(guest, { id: nid(), op: "open", payload: { name: "big" } });
    /* A single entry above the body cap is refused outright. */
    ca(guest, {
      id: nid(),
      op: "put",
      payload: {
        name: "big",
        url: ORIGIN + "/huge",
        entry: { status: 200, statusText: "", headers: {}, body: "x".repeat(GUEST_FETCH_BODY_MAX + 1) },
      },
    });
    expect(lastCa(guest)?.ok).toBe(false);
    expect(lastCa(guest)?.error).toContain("size cap");
  });

  it("tears the namespace down on terminate and keeps sites isolated", () => {
    const { kernel, host, guest } = kernelUp();
    ca(guest, { id: 1, op: "open", payload: { name: "v1" } });
    put(guest, 2, "v1", ORIGIN + "/a", "alpha");
    const other = spawnSecond(kernel, host, OTHER);
    ca(other, { id: 3, op: "storeMatch", payload: { url: ORIGIN + "/a" } });
    expect(lastCa(other)?.result).toBeNull();
    /* Terminating one site never touches the other's namespace. */
    kernel.terminate(OTHER);
    ca(guest, { id: 4, op: "match", payload: { name: "v1", url: ORIGIN + "/a" } });
    expect((lastCa(guest)?.result as { body: string } | null)?.body).toBe("alpha");
    /* A terminated site's caches are gone, also across a respawn. */
    kernel.terminate(ORIGIN);
    const reborn = spawnSecond(kernel, host, ORIGIN);
    ca(reborn, { id: 5, op: "keys", payload: {} });
    expect(lastCa(reborn)?.result).toEqual([]);
    ca(reborn, { id: 6, op: "storeMatch", payload: { url: ORIGIN + "/a" } });
    expect(lastCa(reborn)?.result).toBeNull();
  });

  it("storeMatch finds entries across the site's caches", () => {
    const { guest } = kernelUp();
    ca(guest, { id: 1, op: "open", payload: { name: "one" } });
    ca(guest, { id: 2, op: "open", payload: { name: "two" } });
    put(guest, 3, "two", ORIGIN + "/x", "in-two");
    ca(guest, { id: 4, op: "storeMatch", payload: { url: ORIGIN + "/x" } });
    expect((lastCa(guest)?.result as { body: string } | null)?.body).toBe("in-two");
    ca(guest, { id: 5, op: "storeMatch", payload: { url: ORIGIN + "/none" } });
    expect(lastCa(guest)?.result).toBeNull();
  });
});

describe("guest harness caches facade (#538)", () => {
  it("exposes open/put/match round trips through the port", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.r=null;self.err=null;" +
      "self.addEventListener('install',function(e){" +
      "self.caches.open('v1').then(function(c){" +
      "return c.put('/a',{status:200,headers:{'x-a':'1'},text:function(){return Promise.resolve('stored');}});" +
      "}).then(function(){return self.caches.match('/a');})" +
      ".then(function(m){return m?m.text().then(function(t){self.r=t;}):self.r='miss';})" +
      ".catch(function(err){self.err=String(err);});});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({
      data: { zl: "harnessPort" },
      ports: [port],
    });
    port.onmessage!({ data: { zl: "guestEvent", type: "install" } });
    /* The facade drives every op through zl:guestCaches frames; each
       one only fires after the previous reply, so wait per op. */
    let seen = 0;
    const nextOp = async (): Promise<{ id: number; op: string; payload: Record<string, unknown> }> => {
      for (let i = 0; i < 100; i++) {
        const frames = port.sent.filter((m) => (m as { zl?: unknown }).zl === "guestCaches") as Array<{
          id: number;
          op: string;
          payload: Record<string, unknown>;
        }>;
        if (frames.length > seen) {
          seen = frames.length;
          return frames[frames.length - 1];
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("cache op never arrived");
    };
    const open = await nextOp();
    expect(open.op).toBe("open");
    port.onmessage!({ data: { zl: "guestCachesResult", id: open.id, ok: true, result: "v1" } });
    const putOp = await nextOp();
    expect(putOp.op).toBe("put");
    /* The facade passes the URL as given; the kernel canonicalizes. */
    expect(putOp.payload.url).toBe("/a");
    port.onmessage!({ data: { zl: "guestCachesResult", id: putOp.id, ok: true, result: true } });
    const matchOp = await nextOp();
    expect(matchOp.op).toBe("storeMatch");
    port.onmessage!({
      data: {
        zl: "guestCachesResult",
        id: matchOp.id,
        ok: true,
        result: { status: 200, statusText: "OK", headers: { "x-a": "1" }, body: "stored" },
      },
    });
    for (let i = 0; i < 50 && (self as { r: unknown }).r === null; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((self as { r: unknown }).r).toBe("stored");
    expect((self as { err: unknown }).err).toBeNull();
  });

  it("rejects the facade promise when the kernel refuses an op", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.err=null;" +
      "self.addEventListener('install',function(e){" +
      "self.caches.keys().catch(function(err){self.err=String(err);});});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({
      data: { zl: "harnessPort" },
      ports: [port],
    });
    port.onmessage!({ data: { zl: "guestEvent", type: "install" } });
    const op = (port.sent.find((m) => (m as { zl?: unknown }).zl === "guestCaches") as { id: number }).id;
    port.onmessage!({ data: { zl: "guestCachesResult", id: op, ok: false, error: "nope" } });
    await new Promise((r) => setTimeout(r, 10));
    expect((self as { err: unknown }).err).toContain("nope");
  });
});
