import { describe, expect, it } from "vitest";
import { DIAG, classifyStageFailure } from "../diag";

/* #95: failure events name the stage the request broke at, and the
   stage maps to an honest category/cause - a rewrite failure was
   mislabeled TRANSPORT/upstream before this table existed. */
describe("classifyStageFailure (#95)", () => {
  it("rewrite stages are rewrite failures, not upstream ones", () => {
    expect(classifyStageFailure("REWRITE_STARTED")).toEqual({ category: "REWRITE", cause: "rewrite" });
    expect(classifyStageFailure("REWRITE_COMPLETED")).toEqual({ category: "REWRITE", cause: "rewrite" });
    expect(classifyStageFailure("REWRITE_FAILED")).toEqual({ category: "REWRITE", cause: "rewrite" });
  });
  it("engine-internal stages are proxy failures", () => {
    expect(classifyStageFailure("REQUEST_CREATED")).toEqual({ category: "TRANSPORT", cause: "proxy" });
    expect(classifyStageFailure("REQUEST_INTERCEPTED")).toEqual({ category: "TRANSPORT", cause: "proxy" });
  });
  it("upstream stages stay upstream failures", () => {
    for (const stage of ["UPSTREAM_REQUEST", "UPSTREAM_RESPONSE", "REDIRECT_HOP", "REDIRECTED"] as const) {
      expect(classifyStageFailure(stage)).toEqual({ category: "TRANSPORT", cause: "upstream" });
    }
  });
});

describe("diag ring bounds (#95)", () => {
  it("the event ring stays bounded at 512 and keeps the newest events", () => {
    for (let i = 0; i < 600; i++) {
      DIAG.emit({ category: "TRANSPORT", severity: "info", message: "bound probe " + i });
    }
    const snap = DIAG.snapshot(0);
    expect(snap.events.length).toBeLessThanOrEqual(512);
    expect(snap.events.length).toBe(512);
    /* The newest events survive: the ring drops the oldest. */
    expect(snap.events[snap.events.length - 1].message).toBe("bound probe 599");
    /* The delta cursor protocol still works against a full ring. */
    const since = snap.lastSeq - 10;
    expect(DIAG.snapshot(since).events.length).toBe(10);
  });
  it("a TRANSPORT_FALLBACK decision event carries the fallback reason", () => {
    DIAG.emit({
      category: "TRANSPORT",
      severity: "info",
      stage: "TRANSPORT_FALLBACK",
      traceId: "zl-t-bound-1",
      message: "DOCUMENT_REWRITE_REQUIRED",
    });
    const snap = DIAG.snapshot(0);
    const ev = snap.events.find((x) => x.stage === "TRANSPORT_FALLBACK" && x.traceId === "zl-t-bound-1");
    expect(ev).toBeDefined();
    expect(ev!.message).toBe("DOCUMENT_REWRITE_REQUIRED");
  });
});
