import { describe, expect, it } from "vitest";
import { planCspTranslation, planCspHeaders } from "../csp-translation";
import { stripHostile } from "../headers";

describe("CSP translation safety prototype (#452) — not enabled in request serving", () => {
  it("constructs only explicit deny-only candidates with no URL widening", () => {
    expect(planCspTranslation("object-src 'none'; base-uri 'none'; form-action 'none'")).toEqual({
      kind: "candidate",
      policy: "object-src 'none'; base-uri 'none'; form-action 'none'",
      directives: ["object-src", "base-uri", "form-action"],
    });
    expect(planCspTranslation("OBJECT-SRC 'NONE'")).toEqual({
      kind: "candidate", policy: "object-src 'none'", directives: ["object-src"],
    });
    expect(planCspTranslation("object-src 'none';")).toMatchObject({ kind: "candidate" });
  });

  it("rejects virtual-host unsafe 'self', external source URLs, wildcards and mixed 'none'", () => {
    const policies = [
      "script-src 'self'",
      "script-src https://cdn.example",
      "img-src *",
      "default-src 'none'",
      "object-src 'self'",
      "object-src https://trusted.example",
      "object-src 'none' https://other.example",
      "object-src 'none' 'self'",
      "base-uri 'unsafe-inline'",
      "form-action data:",
      "object-src",
    ];
    for (const value of policies) {
      const result = planCspTranslation(value);
      expect(result.kind, value).toBe("unsupported");
    }
  });

  it("does not drop nonce, hash, strict-dynamic, sandbox, or bootstrap-sensitive directives", () => {
    for (const policy of [
      "script-src 'nonce-Abc123'",
      "script-src 'sha256-AAAAAAAAAAAA'",
      "script-src 'strict-dynamic' 'nonce-X'",
      "sandbox allow-scripts",
      "upgrade-insecure-requests",
      "connect-src 'none'",
      "frame-ancestors 'none'",
      "worker-src 'none'",
      "report-uri https://report.example/csp",
      "report-to security",
    ]) {
      expect(planCspTranslation(policy).kind, policy).toBe("unsupported");
    }
  });

  it("rejects duplicates, comma-combined headers, control chars and malformed source names", () => {
    expect(planCspTranslation("object-src 'none'; OBJECT-SRC 'none'")).toEqual({
      kind: "unsupported", reason: "duplicate-directive",
    });
    expect(planCspTranslation("object-src 'none', base-uri 'none'")).toEqual({
      kind: "unsupported", reason: "invalid-syntax",
    });
    expect(planCspTranslation("object-src 'none'\r\nreport-uri https://evil.example")).toEqual({
      kind: "unsupported", reason: "invalid-syntax",
    });
    expect(planCspTranslation("obj@ct-src 'none'")).toEqual({
      kind: "unsupported", reason: "invalid-syntax",
    });
    expect(planCspTranslation(";")).toEqual({
      kind: "unsupported", reason: "invalid-syntax",
    });
  });

  it("rejects oversized input and excessive directive counts, without copying secrets into outcomes", () => {
    expect(planCspTranslation("x".repeat(9000))).toEqual({ kind: "unsupported", reason: "oversize" });
    const repetitive = Array.from({ length: 66 }, (_, i) => `x${i} 'none'`).join(";");
    expect(planCspTranslation(repetitive)).toEqual({ kind: "unsupported", reason: "oversize" });
    const report = planCspTranslation("report-uri https://secret.example/submit?token=hidden");
    expect(JSON.stringify(report)).not.toContain("hidden");
  });

  it("never emits a report-only policy with a direct report delivery path", () => {
    expect(planCspTranslation("object-src 'none'", { reportOnly: true })).toEqual({
      kind: "unsupported", reason: "report-only",
    });
    const h = new Headers({
      "content-security-policy": "object-src 'none'",
      "content-security-policy-report-only": "script-src https://tracker.example; report-uri /log",
    });
    expect(planCspHeaders(h)).toMatchObject({
      enforcing: { kind: "candidate", policy: "object-src 'none'" },
      reportOnly: { kind: "unsupported", reason: "report-only" },
    });
  });

  it("keeps the deployed response stripping behavior unchanged until browser acceptance", () => {
    const headers = new Headers({
      "Content-Security-Policy": "object-src 'none'",
      "Content-Security-Policy-Report-Only": "object-src 'none'",
      "content-type": "text/html",
    });
    const out = stripHostile(headers);
    expect(out.has("content-security-policy")).toBe(false);
    expect(out.has("content-security-policy-report-only")).toBe(false);
    expect(out.get("content-type")).toBe("text/html");
  });
});
