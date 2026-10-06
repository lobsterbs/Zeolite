import { describe, expect, it, vi } from "vitest";
import {
  NET_LIMIT,
  flatRed,
  netLogCursor,
  netLogGeneration,
  netLogSince,
  netLogPush,
  stampNetGeneration,
} from "../netlog";

/* #89: the network inspector ring moved out of sw.ts; these tests pin
   the ring contract (bounded storage, monotonic cursor, delta slices,
   generation stamp) that zl:getNetLog, zl:getTracing and the recording
   window all depend on. */

function entry(n: number) {
  return {
    method: "GET",
    path: "/p" + n,
    dest: "https://example.com/p" + n,
    status: 200,
    ms: 1,
    bytes: 2,
    rtype: "FETCH",
  };
}

describe("netlog ring", () => {
  it("assigns a monotonic seq and a timestamp to every entry", () => {
    netLogPush(entry(1));
    netLogPush(entry(2));
    const all = netLogSince(0);
    const a = all[all.length - 2];
    const b = all[all.length - 1];
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.ts).toBeGreaterThan(0);
    expect(b.ts).toBeGreaterThan(0);
  });

  it("stays bounded at NET_LIMIT", () => {
    for (let i = 0; i < NET_LIMIT + 40; i++) netLogPush(entry(i));
    expect(netLogSince(0).length).toBe(NET_LIMIT);
    const all = netLogSince(0);
    expect(all[all.length - 1].dest).toBe("https://example.com/p" + (NET_LIMIT + 39));
  });

  it("netLogSince returns only entries past the cursor", () => {
    netLogPush(entry(101));
    const cursor = netLogCursor();
    netLogPush(entry(102));
    netLogPush(entry(103));
    const fresh = netLogSince(cursor);
    expect(fresh.length).toBe(2);
    expect(fresh[0].dest).toBe("https://example.com/p102");
    expect(fresh[1].dest).toBe("https://example.com/p103");
  });

  it("netLogCursor matches the last pushed seq", () => {
    netLogPush(entry(200));
    const all = netLogSince(0);
    expect(netLogCursor()).toBe(all[all.length - 1].seq);
  });
});

describe("flatRed", () => {
  it("redacts secret-bearing header values wholesale (#95)", () => {
    const h = new Headers({
      cookie: "sid=super-secret-session-id",
      authorization: "Bearer eyJ.abc.def",
      "x-plain": "harmless",
    });
    const out = flatRed(h);
    expect(out["cookie"]).toBe("[redacted]");
    expect(out["authorization"]).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("super-secret-session-id");
    expect(JSON.stringify(out)).not.toContain("eyJ.abc.def");
    expect(out["x-plain"]).toBe("harmless");
  });

  it("redacts secrets that appear inside otherwise plain values", () => {
    const out = flatRed(new Headers({ "x-note": "token=abc123 and bearer xyz" }));
    expect(out["x-note"]).not.toContain("abc123");
    expect(out["x-note"]).not.toContain("xyz");
  });
});

describe("generation stamp", () => {
  it("tracks the worker evaluation epoch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    stampNetGeneration();
    expect(netLogGeneration()).toBe(1000);
    vi.setSystemTime(2000);
    stampNetGeneration();
    expect(netLogGeneration()).toBe(2000);
    vi.useRealTimers();
  });
});
