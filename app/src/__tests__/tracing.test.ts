import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTracing, traceDecision, tracingResetForTests, tracingSnapshot } from "../tracing";

beforeEach(() => tracingResetForTests());
afterEach(() => tracingResetForTests());

describe("rewrite tracing", () => {
  it("is off by default and records nothing", () => {
    traceDecision({ subsystem: "rules", original: "https://a.example/", result: "blocked" });
    const s = tracingSnapshot(0);
    expect(s.enabled).toBe(false);
    expect(s.entries).toEqual([]);
  });

  it("records decisions with seq and ts while enabled", () => {
    setTracing(true);
    traceDecision({ subsystem: "transport", rule: "NativeTransit", original: "https://a.example/x.js", result: "NativeTransit", resource: "script", traceId: "t1" });
    const s = tracingSnapshot(0);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ subsystem: "transport", resource: "script", traceId: "t1" });
    expect(s.entries[0].seq).toBe(1);
    expect(s.entries[0].ts).toBeGreaterThan(0);
  });

  it("honors the delta cursor", () => {
    setTracing(true);
    traceDecision({ subsystem: "rules", original: "a", result: "b" });
    traceDecision({ subsystem: "rules", original: "c", result: "d" });
    const first = tracingSnapshot(0);
    expect(tracingSnapshot(first.lastSeq).entries).toEqual([]);
    expect(tracingSnapshot(first.entries[0].seq).entries).toHaveLength(1);
  });

  it("redacts secrets before storing", () => {
    setTracing(true);
    traceDecision({ subsystem: "intercept", original: "https://a.example/?token=sekrit", result: "cookie=x" });
    const s = tracingSnapshot(0);
    expect(s.entries[0].original).not.toContain("sekrit");
    expect(s.entries[0].result).not.toContain("x");
  });

  it("bounds the ring", () => {
    setTracing(true);
    for (let i = 0; i < 520; i++) traceDecision({ subsystem: "rules", original: String(i), result: "blocked" });
    const s = tracingSnapshot(0);
    expect(s.entries).toHaveLength(512);
    expect(s.entries[0].original).toBe("8");
  });
});
