import { describe, expect, it } from "vitest";
import { planRange } from "../range";

const TOTAL = 2097152; // the compat fixture's /large body

describe("planRange (issue #18)", () => {
  it("slices the plain a-b form", () => {
    expect(planRange("bytes=0-1023", TOTAL)).toEqual({ kind: "slice", start: 0, end: 1023 });
    expect(planRange("bytes=100-199", TOTAL)).toEqual({ kind: "slice", start: 100, end: 199 });
  });

  it("clamps the end to the stored length", () => {
    expect(planRange("bytes=0-99999999", 100)).toEqual({ kind: "slice", start: 0, end: 99 });
  });

  it("open-ended a- runs to the end", () => {
    expect(planRange("bytes=1048576-", TOTAL)).toEqual({
      kind: "slice",
      start: 1048576,
      end: TOTAL - 1,
    });
  });

  it("suffix form takes the last N bytes", () => {
    expect(planRange("bytes=-500", 1000)).toEqual({ kind: "slice", start: 500, end: 999 });
    expect(planRange("bytes=-2000", 1000)).toEqual({ kind: "slice", start: 0, end: 999 });
  });

  it("416 when the range starts past the end", () => {
    expect(planRange("bytes=2097152-", TOTAL)).toEqual({ kind: "unsatisfiable" });
    expect(planRange("bytes=999999-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(planRange("bytes=-0", TOTAL)).toEqual({ kind: "unsatisfiable" });
  });

  it("multi-range and malformed headers bypass to the origin", () => {
    expect(planRange("bytes=0-1,5-9", TOTAL).kind).toBe("bypass");
    expect(planRange("bytes=", TOTAL).kind).toBe("bypass");
    expect(planRange("bytes=-", TOTAL).kind).toBe("bypass");
    expect(planRange("chunks=1-2", TOTAL).kind).toBe("bypass");
    expect(planRange("bytes=5-2", 100).kind).toBe("bypass");
  });
});
