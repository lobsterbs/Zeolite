import { describe, expect, it } from "vitest";
import { planCspTranslation, planCspHeaders, applyExperimentalCsp } from "../csp-translation";
import { stripHostile } from "../headers";

describe("CSP deny-only translation safety subset (#452)", () => {
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
      /* worker-src/frame-src/child-src 'none' moved to the audited
         representable set on 2026-10-28; see the audit tests below. */
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

  it("restores only safely denied sources to HTML documents when enabled", () => {
    const raw = new Headers({
      "content-security-policy": "object-src 'none'; base-uri 'none'",
      "content-security-policy-report-only": "report-uri https://secret.example/",
    });
    const out = stripHostile(raw);
    expect(applyExperimentalCsp(out, raw, "text/html; charset=utf-8", true)).toBe(true);
    expect(out.get("content-security-policy")).toBe("object-src 'none'; base-uri 'none'");
    expect(out.has("content-security-policy-report-only")).toBe(false);
  });

  it("never copies arbitrary CSP or enforces on non-document resources", () => {
    for (const value of [
      "default-src 'none'", "script-src 'self'", "object-src 'self'",
      "object-src 'none'; script-src https://cdn.example",
      "object-src 'none', base-uri 'none'",
    ]) {
      const original = new Headers({ "content-security-policy": value });
      const out = stripHostile(original);
      expect(applyExperimentalCsp(out, original, "text/html", true)).toBe(false);
      expect(out.has("content-security-policy")).toBe(false);
    }
    const raw = new Headers({ "content-security-policy": "object-src 'none'" });
    for (const [mime, doc] of [["text/css",true],["text/javascript",true],["text/html",false]] as const)
      expect(applyExperimentalCsp(new Headers(), raw, mime, doc)).toBe(false);
  });

  it("preserves the default stripping behavior when the experimental flag is off", () => {
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
  it("translates the audited worker/frame/child deny directives (#452 audit)", () => {
    const all = "object-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none'";
    expect(planCspTranslation(all)).toEqual({
      kind: "candidate",
      policy: all,
      directives: ["object-src", "worker-src", "frame-src", "child-src"],
    });
    for (const d of ["worker-src", "frame-src", "child-src"]) {
      expect(planCspTranslation(d + " 'none'").kind).toBe("candidate");
      expect(planCspTranslation(d + " 'self'").kind).toBe("unsupported");
      expect(planCspTranslation(d + " https://cdn.example").kind).toBe("unsupported");
    }
  });

  it("keeps the audited-unsupported directives rejected with typed reasons (#452 audit)", () => {
    /* frame-ancestors: the engine embeds proxied pages in its own UI frame;
       connect-src: the page runtime fetches minted engine routes;
       nonce/hash: injected scripts cannot carry the upstream nonce and
       the rewriter mutates inline bodies. */
    for (const d of ["frame-ancestors", "connect-src", "script-src", "img-src", "sandbox", "report-uri"]) {
      expect(planCspTranslation(d + " 'none'")).toEqual({ kind: "unsupported", reason: "unsupported-directive" });
    }
    expect(planCspTranslation("script-src 'nonce-abcd1234'").kind).toBe("unsupported");
    expect(planCspTranslation("script-src 'sha256-4iYvwKpOKvxQNR0lGBTyEK8TqwJcpK46DpKYoLzkX5M'").kind).toBe("unsupported");
  });
});

