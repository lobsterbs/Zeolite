/* #538 regression tests: the guest network bridge. A guest realm's
   fetch() travels the guest port to the kernel and then through the
   engine bridge; every malformed or uncertain path fails closed,
   forbidden header names never cross the boundary, and the outer
   bridge budget is hard. */

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

function deliver(guest: FakePort, data: unknown): void {
  guest.onmessage!({ data });
}

function lastResult(guest: FakePort): { ok: boolean; error?: string } | undefined {
  const frames = guest.sent.filter(
    (m) => typeof m === "object" && m !== null && (m as { zl?: unknown }).zl === "guestNetFetchResult",
  );
  return frames[frames.length - 1] as { ok: boolean; error?: string } | undefined;
}

describe("guest harness fetch facade (#538)", () => {
  it("bridges fetch() through the engine port and resolves a bounded response facade", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.got=null;self.fetchErr=null;" +
      "self.addEventListener('fetch',function(e){" +
      "self.fetch(e.request.url,{method:'POST',headers:{'x-a':'1'},body:'hi'}).then(function(r){return r.text().then(function(t){self.got={s:r.status,ok:r.ok,h:r.headers.get('x-b'),t:t};});},function(err){self.fetchErr=String(err);});});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({
      data: { zl: "harnessPort" },
      ports: [port],
    });
    port.onmessage!({
      data: { zl: "guestEvent", type: "fetch", data: { id: 3, request: { url: ORIGIN + "/api", method: "GET" } } },
    });
    const frame = port.sent.find((m) => (m as { zl?: unknown }).zl === "guestNetFetch") as {
      id: number;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(frame).toBeTruthy();
    expect(frame.url).toBe(ORIGIN + "/api");
    expect(frame.method).toBe("POST");
    expect(frame.headers["x-a"]).toBe("1");
    expect(frame.body).toBe("hi");
    expect((self as { fetchErr: unknown }).fetchErr).toBeNull();
    port.onmessage!({
      data: {
        zl: "guestNetFetchResult",
        id: frame.id,
        ok: true,
        status: 201,
        statusText: "Created",
        headers: { "x-b": "2" },
        body: "pong",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    const got = (self as { got: { s: number; ok: boolean; h: string | null; t: string } | null }).got;
    expect(got).toEqual({ s: 201, ok: true, h: "2", t: "pong" });
  });

  it("rejects the facade promise on an error reply", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.fetchErr=null;" +
      "self.addEventListener('install',function(){" +
      "self.fetch('/x').then(function(){},function(err){self.fetchErr=String(err);});});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({
      data: { zl: "harnessPort" },
      ports: [port],
    });
    port.onmessage!({ data: { zl: "guestEvent", type: "install" } });
    await new Promise((r) => setTimeout(r, 10));
    const frame = port.sent.find((m) => (m as { zl?: unknown }).zl === "guestNetFetch") as { id: number };
    expect(frame).toBeTruthy();
    port.onmessage!({ data: { zl: "guestNetFetchResult", id: frame.id, ok: false, error: "boom" } });
    await new Promise((r) => setTimeout(r, 10));
    expect((self as { fetchErr: unknown }).fetchErr).toContain("boom");
  });

  it("serializes Response-like values handed to respondWith", async () => {
    const self: Record<string, unknown> = {};
    const bridge: Record<string, unknown> = {};
    self.addEventListener = (t: string, f: unknown) => {
      bridge[t] = f;
    };
    const code =
      guestHarness(ORIGIN + "/", ORIGIN + "/sw.js") +
      "self.addEventListener('fetch',function(e){" +
      "e.respondWith({status:200,statusText:'OK',headers:{'x-h':'v'},text:function(){return Promise.resolve('body');}});});";
    new Function("self", code)(self);
    const port = mkPort();
    (bridge.message as (ev: { data: unknown; ports: unknown[] }) => void)({
      data: { zl: "harnessPort" },
      ports: [port],
    });
    port.onmessage!({
      data: { zl: "guestEvent", type: "fetch", data: { id: 9, request: { url: ORIGIN + "/a", method: "GET" } } },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(port.sent).toContainEqual({
      zl: "guestFetchResponse",
      id: 9,
      response: { status: 200, headers: { "x-h": "v" }, body: "body" },
    });
  });
});

describe("GuestKernel guest fetch bridge (#538)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed when no engine bridge is wired", () => {
    const { kernel, guest } = kernelUp();
    expect(kernel.pendingNetFetches()).toBe(0);
    deliver(guest, { zl: "guestNetFetch", id: 1, url: ORIGIN + "/x", method: "GET", headers: {}, body: null });
    const fr = lastResult(guest);
    expect(fr?.ok).toBe(false);
    expect(fr?.error).toContain("bridge unavailable");
    expect(kernel.pendingNetFetches()).toBe(0);
  });

  it("validates url, method, headers and body fail-closed before the bridge", async () => {
    const { kernel, guest } = kernelUp();
    const calls: unknown[] = [];
    kernel.wireFetch(async (r) => {
      calls.push(r);
      return { status: 200, headers: {}, body: "" };
    });
    deliver(guest, { zl: "guestNetFetch", id: 1, url: "ftp://x/", method: "GET", headers: {}, body: null });
    deliver(guest, { zl: "guestNetFetch", id: 2, url: ORIGIN + "/x", method: "TRACE", headers: {}, body: null });
    deliver(guest, { zl: "guestNetFetch", id: 3, url: ORIGIN + "/x", method: "GET", headers: {}, body: "b" });
    deliver(guest, { zl: "guestNetFetch", id: 4, url: ORIGIN + "/x", method: "POST", headers: { "x-a": 1 }, body: null });
    deliver(guest, { zl: "guestNetFetch", id: 5, url: ORIGIN + "/x", method: "POST", headers: {}, body: "y".repeat(3 * 1024 * 1024) });
    deliver(guest, { zl: "guestNetFetch", id: 6, url: "", method: "GET", headers: {}, body: null });
    expect(kernel.pendingNetFetches()).toBe(0);
    expect(calls.length).toBe(0);
    const errs = guest.sent
      .filter((m) => (m as { zl?: unknown }).zl === "guestNetFetchResult")
      .map((m) => (m as { ok: boolean; error?: string }).error ?? "");
    expect(errs.length).toBe(6);
    for (const e of errs) expect(e.length).toBeGreaterThan(0);
  });

  it("sends a validated fetch through the engine bridge and posts the bounded result", async () => {
    const { kernel, guest } = kernelUp();
    const calls: unknown[] = [];
    kernel.wireFetch(async (r) => {
      calls.push(r);
      return { status: 200, statusText: "OK", headers: { "content-type": "text/plain" }, body: "data" };
    });
    deliver(guest, {
      zl: "guestNetFetch",
      id: 5,
      url: "/rel?a=1",
      method: "POST",
      headers: { "x-a": "1", cookie: "sid=1", host: "evil.example" },
      body: "b",
    });
    expect(calls.length).toBe(1);
    const call = calls[0] as { url: string; method: string; headers: Record<string, string>; body: string | null };
    expect(call.url).toBe(ORIGIN + "/rel?a=1");
    expect(call.method).toBe("POST");
    expect(call.headers["x-a"]).toBe("1");
    /* Forbidden header names never cross the guest boundary. */
    expect(call.headers["cookie"]).toBeUndefined();
    expect(call.headers["host"]).toBeUndefined();
    expect(call.body).toBe("b");
    await vi.advanceTimersByTimeAsync(0);
    const fr = guest.sent.find(
      (m) => (m as { zl?: unknown; ok?: unknown }).zl === "guestNetFetchResult" && (m as { ok?: unknown }).ok === true,
    ) as { status: number; body: string; headers: Record<string, string> };
    expect(fr.status).toBe(200);
    expect(fr.body).toBe("data");
    expect(fr.headers["content-type"]).toBe("text/plain");
    expect(kernel.pendingNetFetches()).toBe(0);
  });

  it("fails closed when the bridge rejects or returns an invalid response", async () => {
    const { kernel, guest } = kernelUp();
    kernel.wireFetch(async () => {
      throw new Error("upstream gone");
    });
    deliver(guest, { zl: "guestNetFetch", id: 1, url: ORIGIN + "/x", method: "GET", headers: {}, body: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastResult(guest)?.error).toContain("upstream gone");
    kernel.wireFetch(async () => ({ status: 999 as unknown as number, headers: {}, body: null }));
    deliver(guest, { zl: "guestNetFetch", id: 2, url: ORIGIN + "/x", method: "GET", headers: {}, body: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastResult(guest)?.error).toContain("invalid response");
    kernel.wireFetch(async () => ({ status: 200, headers: {}, body: "x".repeat(3 * 1024 * 1024) }));
    deliver(guest, { zl: "guestNetFetch", id: 3, url: ORIGIN + "/x", method: "GET", headers: {}, body: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastResult(guest)?.error).toContain("size cap");
    expect(kernel.pendingNetFetches()).toBe(0);
  });

  it("enforces the outer budget and ignores a late bridge answer", async () => {
    const { kernel, guest } = kernelUp();
    let late: (v: { status: number; headers: Record<string, string>; body: string | null }) => void = () => {};
    kernel.wireFetch(
      () =>
        new Promise((res) => {
          late = res;
        }),
    );
    deliver(guest, { zl: "guestNetFetch", id: 1, url: ORIGIN + "/x", method: "GET", headers: {}, body: null });
    expect(kernel.pendingNetFetches()).toBe(1);
    vi.advanceTimersByTime(GUEST_NETFETCH_BUDGET_MS + 1);
    expect(kernel.pendingNetFetches()).toBe(0);
    expect(lastResult(guest)?.error).toContain("budget exceeded");
    late({ status: 200, headers: {}, body: "late" });
    await vi.advanceTimersByTimeAsync(0);
    const oks = guest.sent.filter(
      (m) => (m as { zl?: unknown; ok?: unknown }).zl === "guestNetFetchResult" && (m as { ok?: unknown }).ok === true,
    );
    expect(oks.length).toBe(0);
  });

  it("clears bridge timers for the origin on terminate", async () => {
    const { kernel, guest } = kernelUp();
    kernel.wireFetch(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    deliver(guest, { zl: "guestNetFetch", id: 1, url: ORIGIN + "/x", method: "GET", headers: {}, body: null });
    expect(kernel.pendingNetFetches()).toBe(1);
    kernel.terminate(ORIGIN);
    expect(kernel.pendingNetFetches()).toBe(0);
    vi.advanceTimersByTime(GUEST_NETFETCH_BUDGET_MS + 1);
    /* The terminated realm got no result frame past its own port. */
    expect(lastResult(guest)).toBeUndefined();
  });
});
