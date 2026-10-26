import { describe, expect, it } from "vitest";
import { behaviorMatch, compilePolicy, transportMatch } from "../policy";
import {
  decideTransport,
  planResponseTransit,
  reasonOf,
  type TransitDecision,
} from "../transit";

const site = "https://docs.example/app.js";
const baseline: TransitDecision = { mode: "NativeTransit", reason: "NON_DOCUMENT_RESOURCE" };

describe("adaptive response planner (#487 phase 1)", () => {
  it("keeps required HTML, CSS, XML-document and unknown-document decisions", () => {
    const html = planResponseTransit(decideTransport(site, "document"), "text/html", "document", site);
    expect(html.decision).toEqual({ mode: "RewriteFallback", reason: "DOCUMENT_REWRITE_REQUIRED" });
    expect(html.strategy).toBe("required");
    expect(html.evidence).toBe("request-destination");
    const css = planResponseTransit(baseline, "text/css; charset=utf-8", "style", site);
    expect(css.decision).toEqual({ mode: "RewriteFallback", reason: "CSS_URL_REWRITE_REQUIRED" });
    expect(css.strategy).toBe("required");
    const xml = planResponseTransit(baseline, "image/svg+xml", "iframe", site);
    expect(xml.decision).toEqual({ mode: "RewriteFallback", reason: "XML_DOCUMENT_REWRITE_REQUIRED" });
    expect(xml.strategy).toBe("required");
    const typeless = planResponseTransit(decideTransport(site, "document"), "", "document", site);
    expect(typeless.decision.reason).toBe("DOCUMENT_REWRITE_REQUIRED");
  });

  it("keeps API HTML native and does not guess a rewrite from MIME alone", () => {
    for (const dest of ["", "fetch", "image", "font"]) {
      const plan = planResponseTransit(baseline, "text/html", dest, site);
      expect(plan.decision).toEqual(baseline);
      expect(plan.strategy).toBe("native");
    }
  });

  it("does not demote JS workers or mandatory rewrites from a native KDL rule", () => {
    const nativeRule = { id: "verified", route: "native" };
    for (const dest of ["worker", "sharedworker"]) {
      const plan = planResponseTransit(baseline, "text/javascript", dest, site, nativeRule);
      expect(plan.decision).toEqual({ mode: "RewriteFallback", reason: "JS_LITERAL_REWRITE_REQUIRED" });
      expect(plan.strategy).toBe("full");
    }
    const html = planResponseTransit(decideTransport(site, "document"), "text/html", "document", site, nativeRule);
    expect(html.decision.reason).toBe("DOCUMENT_REWRITE_REQUIRED");
    const css = planResponseTransit(baseline, "text/css", "style", site, nativeRule);
    expect(css.decision.reason).toBe("CSS_URL_REWRITE_REQUIRED");
  });

  it("allows only the already proven script-destination policy-native opt-out", () => {
    const override = { id: "known-native", route: "native" };
    for (const dest of ["script", ""]) {
      const plan = planResponseTransit(baseline, "application/javascript", dest, site, override);
      expect(plan.decision).toEqual({ mode: "NativeTransit", reason: "POLICY_NATIVE", ruleId: "known-native" });
      expect(plan.strategy).toBe("native");
      expect(plan.evidence).toBe("manual-policy");
      expect(reasonOf(plan.decision)).toBe("POLICY_NATIVE");
    }
    const noOverride = planResponseTransit(baseline, "text/javascript", "script", site);
    expect(noOverride.strategy).toBe("full");
    expect(noOverride.decision.reason).toBe("JS_LITERAL_REWRITE_REQUIRED");
    expect(noOverride.evidence).toBe("response-content-type");
  });

  it("keeps CDN-CGI byte-sensitive responses native on cached and fresh paths", () => {
    for (const dest of ["document", "script", "style"]) {
      const initial = decideTransport("https://host.example/cdn-cgi/challenge-platform/start", dest);
      const url = "https://host.example/cdn-cgi/challenge-platform/start";
      const ctype = dest === "document" ? "text/html" : dest === "style" ? "text/css" : "text/javascript";
      const plan = planResponseTransit(initial, ctype, dest, url, { id: "force-rewrite", route: "rewrite" });
      expect(plan.decision).toEqual({ mode: "NativeTransit", reason: "CDN_CGI_NATIVE" });
      expect(plan.evidence).toBe("challenge-namespace");
    }
    const sibling = planResponseTransit(baseline, "text/javascript", "script", "https://host.example/cdn-cgi-other/app.js");
    expect(sibling.decision.reason).toBe("JS_LITERAL_REWRITE_REQUIRED");
  });

  it("never bypasses a deny decision, even for a challenge asset or KDL rule", () => {
    const blocked: TransitDecision = { mode: "Blocked", reason: "BLOCKED_WEBREQUEST" };
    const plan = planResponseTransit(blocked, "text/html", "document", "https://host.example/cdn-cgi/challenge", { id: "allow", route: "native" });
    expect(plan.decision).toEqual(blocked);
    expect(plan.strategy).toBe("blocked");
  });

  it("keeps explicit policy-rewrite decisions and records policy provenance", () => {
    const forced: TransitDecision = { mode: "RewriteFallback", reason: "POLICY_REWRITE", ruleId: "compat-fix" };
    const plan = planResponseTransit(forced, "application/javascript", "script", site);
    expect(plan.decision).toEqual(forced);
    expect(plan.strategy).toBe("full");
    expect(plan.evidence).toBe("manual-policy");
  });

  it("uses the same immutable selector for first load and cache hit", () => {
    const override = { id: "script-native", route: "native" };
    const a = planResponseTransit(decideTransport(site, "script"), "text/javascript", "script", site, override);
    const b = planResponseTransit(decideTransport(site, "script"), "text/javascript", "script", site, override);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("separates transport routing and rewrite behavior regardless of rule priority", () => {
    const rules = compilePolicy(`rule "default-relay" priority=999 {
  route "relay"
}
rule "script-native" priority=1 {
  match host="docs.example" path="/"
  types "script"
  route "native"
}
rule "other-wisp" priority=2000 {
  match host="other.example"
  route "wisp"
}`);
    const behavior = behaviorMatch(rules, site, "script");
    const wire = transportMatch(rules, site, "script");
    expect(behavior?.id).toBe("script-native");
    expect(wire?.id).toBe("default-relay");
    const result = planResponseTransit(baseline, "text/javascript", "script", site, behavior);
    expect(result.decision.reason).toBe("POLICY_NATIVE");
    expect(result.decision.mode).toBe("NativeTransit");
    expect(behaviorMatch(rules, "https://other.example/", "fetch")).toBeNull();
    expect(transportMatch(rules, "https://other.example/", "fetch")?.id).toBe("other-wisp");
  });

  it("does not select light rewriting on mere MIME or filename heuristics", () => {
    for (const u of ["https://a.example/static/hello.js", "https://a.example/dynamic.js"]) {
      const plan = planResponseTransit(baseline, "text/javascript", "script", u);
      expect(plan.strategy).toBe("full");
    }
  });
});
