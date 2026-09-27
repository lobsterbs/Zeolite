import { describe, expect, it } from "vitest";
import { beginRecording, finishRecording } from "../recording";

const state = beginRecording({
  id: "nightly",
  now: 1000,
  netCursor: 5,
  traceCursor: 9,
  tracingWasEnabled: false,
});

const net = [
  { seq: 7, method: "GET", dest: "https://a.test/x", status: 200, rtype: "DOCUMENT", bytes: 100, rewritten: "html" },
  { seq: 6, method: "POST", dest: "https://a.test/api?password=hunter2", status: 404, rtype: "FETCH", bytes: -1, err: "upstream" },
  { seq: 8, method: "GET", dest: "https://a.test/app.js", status: 200, rtype: "SCRIPT", bytes: 10, transport: "RewriteFallback" },
];

const trace = [
  { seq: 11, subsystem: "websocket", original: "wss://a.test/ws", result: "open" },
  { seq: 10, subsystem: "rewriter", rule: "html", original: "https://a.test/x", result: "streaming" },
  { seq: 12, subsystem: "websocket", original: "tx", result: "wss://a.test/ws?token=hunter2" },
];

const jar: Array<[string, Array<{ name: string; domain: string; path: string }>]> = [
  ["o1", [{ name: "sid", domain: "a.test", path: "/" }]],
];

describe("session recording", () => {
  it("records the window and sorts by sequence", () => {
    const r = finishRecording(state, { now: 2000, engine: "test", netEntries: net, traceEntries: trace, cookieJar: jar });
    expect(r.format).toBe("zlRecord");
    expect(r.version).toBe(1);
    expect(r.id).toBe("nightly");
    expect(r.requests.map((x) => x.seq)).toEqual([6, 7, 8]);
    expect(r.decisions.map((x) => x.seq)).toEqual([10]);
    expect(r.websockets.map((x) => x.kind)).toEqual(["open", "tx"]);
    expect(r.websockets[0].url).toBe("wss://a.test/ws");
    expect(r.websockets[1].url).not.toContain("hunter2");
    expect(r.startedAt).toBe(1000);
    expect(r.stoppedAt).toBe(2000);
  });

  it("redacts secrets in URLs and never records cookie values", () => {
    const r = finishRecording(state, { now: 2000, engine: "test", netEntries: net, traceEntries: trace, cookieJar: jar });
    expect(r.requests[0].dest).not.toContain("hunter2");
    expect(r.cookies).toEqual([{ origin: "o1", name: "sid", domain: "a.test", path: "/" }]);
    expect(JSON.stringify(r.cookies)).not.toContain("value");
  });

  it("keeps optional fields out unless present", () => {
    const r = finishRecording(state, { now: 2000, engine: "test", netEntries: net, traceEntries: trace, cookieJar: jar });
    expect("rewritten" in r.requests[0]).toBe(false);
    expect(r.requests[1].rewritten).toBeUndefined();
    expect(r.requests[2].transport).toBe("RewriteFallback");
  });

  it("is deterministic for identical inputs", () => {
    const a = finishRecording(state, { now: 2000, engine: "test", netEntries: net, traceEntries: trace, cookieJar: jar });
    const b = finishRecording(state, { now: 2000, engine: "test", netEntries: net, traceEntries: trace, cookieJar: jar });
    expect(a).toEqual(b);
  });

  it("accepts a Map jar and derives an id when none is given", () => {
    const s = beginRecording({ now: 5000, netCursor: 0, traceCursor: 0, tracingWasEnabled: true });
    expect(s.id).toBe("rec-" + (5000).toString(36));
    const jarMap = new Map(jar);
    const r = finishRecording(s, { now: 6000, engine: "test", netEntries: [], traceEntries: [], cookieJar: jarMap });
    expect(r.cookies).toEqual([{ origin: "o1", name: "sid", domain: "a.test", path: "/" }]);
  });

  it("caps a caller-supplied id", () => {
    const s = beginRecording({ id: "x".repeat(200), now: 1, netCursor: 0, traceCursor: 0, tracingWasEnabled: false });
    expect(s.id.length).toBe(64);
  });
});
