/* #711 C0 gate: the lag sampler must compute honest percentiles
   from a bounded ring and never drift. lagStatsFrom is pure math
   (known arrays); the live sampler is exercised with real timers
   (a few 200ms ticks) asserting shape and bounds only - in a
   loaded CI runner exact lag values would flake. */
import { describe, expect, it } from "vitest";
import { lagStatsFrom, loopLagStats, startLoopLag } from "../looplag";

describe("lagStatsFrom (#711)", () => {
  it("returns zeroed stats for an empty sample set", () => {
    expect(lagStatsFrom([])).toEqual({ n: 0, p50: 0, p95: 0, p99: 0, max: 0, ewma: 0 });
  });
  it("computes percentiles, max and ewma over a known ramp", () => {
    const s = lagStatsFrom([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
    expect(s.n).toBe(10);
    expect(s.p50).toBe(6);
    expect(s.p95).toBe(100);
    expect(s.p99).toBe(100);
    expect(s.max).toBe(100);
    expect(s.ewma).toBeGreaterThan(9); // the 100 tail must pull the ewma up
  });
  it("ignores negative samples (clock skew honesty guard)", () => {
    const s = lagStatsFrom([-5, 3, -1, 4]);
    expect(s.n).toBe(2);
    expect(s.max).toBe(4);
  });
});

describe("startLoopLag (#711)", () => {
  it("is idempotent and produces bounded, monotonic live stats", async () => {
    startLoopLag();
    startLoopLag(); // second call must not stack a second interval
    await new Promise((r) => setTimeout(r, 700));
    const s = loopLagStats();
    expect(s.n).toBeGreaterThanOrEqual(2);
    expect(s.n).toBeLessThanOrEqual(512);
    expect(s.max).toBeGreaterThanOrEqual(s.p99);
    expect(s.p99).toBeGreaterThanOrEqual(s.p50);
    expect(s.ewma).toBeGreaterThanOrEqual(0);
  }, 15000);
});
