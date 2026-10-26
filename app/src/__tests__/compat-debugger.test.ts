import { describe, expect, it } from "vitest";
import { buildCompatibilityReport, compatibilityKdl } from "../compat-debugger";
import { parseKdl } from "../kdl";
import type { DiagEvent } from "../diag";
import type { NetEntry } from "../netlog";
import type { TraceEntry } from "../tracing";

const traceId = "zl-tabc123-1";
const clientId = "verified-frame-1";
const event = (x: Partial<DiagEvent>): DiagEvent => ({
  seq: 1, ts: 10, category: "TRANSPORT", severity: "info",
  message: "SECRET-RAW-MESSAGE", traceId, clientId, ...x,
});
const net = (x: Partial<NetEntry>): NetEntry => ({
  seq: 1, ts: 11, method: "POST", path: "/j/SECRET-ROUTE",
  dest: "https://alice:SUPERSECRET@private.example/?token=PRIVATE",
  rtype: "FETCH", status: 502, ms: 900, bytes: 0,
  traceId, clientId, err: "Cookie: AUTHCOOKIE-PRIVATE", ...x,
});
const tracing = (x: Partial<TraceEntry>): TraceEntry => ({
  seq: 1, ts: 12, subsystem: "transport",
  rule: 'password="PRIVATE"', original: "https://private.example/?code=PRIVATE",
  result: "Authorization: PRIVATE", traceId, ...x,
});
const create = (args: {
  diagnostics?: DiagEvent[];
  network?: NetEntry[];
  tracing?: TraceEntry[];
  clientId?: string;
  traceId?: string;
} = {}) => buildCompatibilityReport({
  engineVersion: "3.0 Diamond", generation: 12345, now: 12346,
  clientId: args.clientId ?? clientId, traceId: args.traceId ?? traceId,
  diagnostics: args.diagnostics ?? [], network: args.network ?? [],
  tracing: args.tracing ?? [],
});

describe("#494 request debugger with strict evidence only", () => {
  it("never promotes a missing ring entry into a success or a guessed failure", () => {
    const report = create();
    expect(report.collection).toBe("no-evidence");
    expect(report.steps).toEqual([]);
    const parsed = parseKdl(compatibilityKdl(report));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].props.collection).toBe("no-evidence");
  });

  it("correlates exactly one request across engine-observed stages and network/decision events", () => {
    const report = create({
      diagnostics: [
        event({ stage: "UPSTREAM_REQUEST", ts: 20 }),
        event({ stage: "REQUEST_INTERCEPTED", ts: 1 }),
        event({ stage: "REWRITE_FAILED", severity: "error", cause: "rewrite", ts: 30 }),
      ],
      network: [net({ transport: "RewriteFallback", fallbackReason: "POLICY_REWRITE", ts: 23 })],
      tracing: [tracing({ subsystem: "rewriter", ts: 25 })],
    });
    expect(report.collection).toBe("observed");
    expect(report.steps).toHaveLength(5);
    expect(report.steps.map(s => s.ts)).toEqual([1,20,23,25,30]);
    expect(report.steps.find(s => s.source === "network")).toMatchObject({
      decision: "RewriteFallback", reason: "POLICY_REWRITE", status: 502,
    });
    const doc = parseKdl(compatibilityKdl(report));
    expect(doc[0].children).toHaveLength(5);
    expect(doc[0].children[0].props.code).toBe("REQUEST_INTERCEPTED");
  });

  it("never exports another client's diagnostic or network evidence", () => {
    const report = create({
      diagnostics: [
        event({ clientId: "other-frame", stage: "REWRITE_FAILED" }),
        event({ traceId: "zl-tabc123-2", stage: "SCRIPT_EXECUTION" }),
        event({ stage: "REQUEST_CREATED" }),
      ],
      network: [
        net({ clientId: "other-frame", status: 401 }),
        net({ traceId: "zl-tabc123-2", status: 403 }),
      ],
      tracing: [
        tracing({ traceId: "zl-tabc123-2" }),
      ],
    });
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0].code).toBe("REQUEST_CREATED");
    expect(compatibilityKdl(report)).not.toContain("401");
    expect(compatibilityKdl(report)).not.toContain("403");
  });

  it("does not leak canary secrets from pre-populated, deliberately unsanitized rings", () => {
    const report = create({
      diagnostics: [event({ message: "raw SECRET-MSG", stage: "CAPTCHA_KEY_DO_NOT_LEAK" as any,
        category: "PRIVATE_CATEGORY_DO_NOT_LEAK" as any, cause: "COOKIE_VALUE_DO_NOT_LEAK" as any })],
      network: [net({ transport: "PRIVATE_TRANSPORT_DO_NOT_LEAK" as any,
        fallbackReason: "PRIVATE_FALLBACK_DO_NOT_LEAK", rewritten: "PRIVATE_REWRITE_DO_NOT_LEAK" })],
      tracing: [tracing({ subsystem: "PRIVATE_SUBSYSTEM_DO_NOT_LEAK", original: "PRIVATE_ORIGIN_DO_NOT_LEAK" })],
    });
    const kdl = compatibilityKdl(report);
    const blob = JSON.stringify(report) + kdl;
    for (const canary of ["SECRET-MSG","PRIVATE_CATEGORY","COOKIE_VALUE","SUPERSECRET","AUTHCOOKIE",
      "PRIVATE_TRANSPORT","PRIVATE_FALLBACK","PRIVATE_REWRITE","PRIVATE_SUBSYSTEM",
      "PRIVATE_ORIGIN","PRIVATE"]) {
      expect(blob).not.toContain(canary);
    }
    expect(parseKdl(kdl)[0].children).toHaveLength(3);
  });

  it("bounded sampling never spills whole rings into report", () => {
    const events = Array.from({ length: 600 }, (_, i) => event({ seq: i+1, ts: i }));
    const choices = Array.from({ length: 600 }, (_, i) => tracing({ seq: i+1, ts: i }));
    const report = create({ diagnostics: events, network: [net({})], tracing: choices });
    expect(report.steps.length).toBeLessThanOrEqual(160);
    expect(compatibilityKdl(report).length).toBeLessThan(30000);
  });

  it("KDL serializer round trips the known vocabulary with no raw strings", () => {
    const report = create({
      diagnostics: [event({ stage: "TRANSPORT_FALLBACK", cause: "unknown", severity: "warning" })],
      network: [net({ rewritten: "html", transport: "NativeTransit", fallbackReason: undefined })],
    });
    const doc = parseKdl(compatibilityKdl(report));
    expect(doc[0].name).toBe("zeolite-debug");
    expect(doc[0].props.scope).toBe("request");
    expect(doc[0].props.redaction).toBe("strict");
    expect(doc[0].children[0].props.severity).toBe("warning");
    expect(doc[0].children[1].props.reason).toBe("html");
    expect(JSON.stringify(doc)).not.toContain("private.example");
  });
});
