import { describe, expect, it } from "vitest";
import { DIAG } from "../diag";
import { netLogCursor, netLogPush, netLogSince } from "../netlog";

describe("browser-client diagnostic attribution", () => {
  it("isolates simultaneous documents and keeps worker events global", () => {
    const a = DIAG.trace("page-a"), b = DIAG.trace("page-b");
    const start = DIAG.snapshot(0).lastSeq;
    for (const traceId of [a, b]) DIAG.failure({ traceId, category: "TRANSPORT", cause: "upstream", message: "failed token=secret" });
    DIAG.failure({ category: "TRANSPORT", cause: "proxy", message: "worker lifecycle" });
    expect(DIAG.snapshot(start, "page-a").events.map(e => e.traceId)).toEqual([a]);
    expect(DIAG.snapshot(start, "page-b").events.map(e => e.traceId)).toEqual([b]);
    expect(DIAG.snapshot(start, "unknown-client").events).toEqual([]);
    expect(DIAG.snapshot(start).events).toHaveLength(3);
    expect(DIAG.snapshot(start, "page-a").events[0].message).not.toContain("secret");
  });
  it("derives network ownership from engine traces, preserving delta cursors", () => {
    const start = netLogCursor();
    const a = DIAG.trace("network-a"), b = DIAG.trace("network-b");
    for (const traceId of [a, b]) netLogPush({ traceId, method: "GET", path: "/", dest: "https://same.example/", status: 200, ms: 1, bytes: 1, rtype: "DOCUMENT" });
    expect(netLogSince(start, "network-a").map(e => e.traceId)).toEqual([a]);
    expect(netLogSince(start, "network-b").map(e => e.traceId)).toEqual([b]);
    expect(netLogSince(start, "new-document")).toEqual([]);
    expect(netLogCursor()).toBe(start + 2);
  });
  it("ignores a clientId injected by an instrumentation callsite", () => {
    const traceId = DIAG.trace("engine-client");
    DIAG.emit({ traceId, clientId: "forged", category: "TRANSPORT", severity: "error", message: "failure" });
    expect(DIAG.snapshot(0, "forged").events).toEqual([]);
    expect(DIAG.snapshot(0, "engine-client").events).toHaveLength(1);
  });
});
