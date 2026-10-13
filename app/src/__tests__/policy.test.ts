import { beforeEach, describe, expect, it } from "vitest";
import { compilePolicy, policyMatch, loadPolicy, policyResetForTests } from "../policy";
import shippedPolicy from "../../public/policy.kdl?raw";

/* KDL nodes terminate at newlines, so every rule child sits on its
   own line (single-line rules would absorb later children as args). */
const K = `rule "r1" {
  match host="example.com"
  types "script"
  route "rewrite"
}`;

describe("compilePolicy", () => {
  it("parses a minimal rule", () => {
    const p = compilePolicy(K);
    expect(p.rules).toHaveLength(1);
    expect(p.rules[0]).toMatchObject({ id: "r1", priority: 0, host: "example.com", path: null, reason: null });
    expect(p.rules[0].types).toEqual(new Set(["script"]));
  });

  it("takes priority, path and reason", () => {
    const p = compilePolicy(`rule "r" priority=7 {
  match host="x.example" path="/a/"
  route "rewrite"
  reason "why"
}`);
    expect(p.rules[0]).toMatchObject({ id: "r", priority: 7, host: "x.example", path: "/a/", reason: "why" });
  });

  it("rejects unknown top-level nodes", () => {
    expect(() => compilePolicy('block "x"')).toThrow(/unexpected node/);
  });

  it("rejects unknown or missing routes", () => {
    expect(() => compilePolicy('rule "r" { route "banana" }')).toThrow(/route must be/);
    expect(() => compilePolicy('rule "r" { }')).toThrow(/route must be/);
  });

  /* #138: route "native" demotes the JS literal pass for proven hosts. */
  it("parses route native", () => {
    const p = compilePolicy('rule "r" priority=2 { route "native" }');
    expect(p.rules[0]).toMatchObject({ id: "r", priority: 2, route: "native" });
  });

  /* #137: route "relay" moves the fetch onto the embedder's stack. */
  it("parses route relay", () => {
    const p = compilePolicy('rule "r" priority=2 { route "relay" }');
    expect(p.rules[0]).toMatchObject({ id: "r", priority: 2, route: "relay" });
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      compilePolicy(`rule "r" { route "rewrite" }
rule "r" { route "rewrite" }`)).toThrow(/duplicate rule id/);
  });

  it("rejects bad ids, props, children and types", () => {
    expect(() => compilePolicy('rule 5 { route "rewrite" }')).toThrow(/string id/);
    expect(() => compilePolicy('rule "r" weight=3 { route "rewrite" }')).toThrow(/unexpected property/);
    expect(() => compilePolicy('rule "r" { nope 1 route "rewrite" }')).toThrow(/unexpected node/);
    expect(() => compilePolicy('rule "r" { types "nonsense" route "rewrite" }')).toThrow(/unknown resource type/);
    expect(() => compilePolicy('rule "r" { match port="80" route "rewrite" }')).toThrow(/match allows only/);
  });

  it("rejects malformed kdl with the parser line number", () => {
    expect(() => compilePolicy('rule "r" { route ')).toThrow(/line 1/);
  });

  it("empty and comment-only files compile to no rules", () => {
    expect(compilePolicy("").rules).toEqual([]);
    expect(compilePolicy("// nothing").rules).toEqual([]);
  });
});

describe("policyMatch", () => {
  const p = compilePolicy(`rule "low" priority=1 {
  match host="example.com"
  route "rewrite"
}
rule "high" priority=10 {
  match host="example.com" path="/app/"
  route "rewrite"
}
rule "tie-a" priority=5 {
  match host="example.com"
  types "script"
  route "rewrite"
}
rule "tie-b" priority=5 {
  match host="cdn.example.com"
  route "rewrite"
}`);

  it("highest priority wins", () => {
    expect(policyMatch(p, "https://example.com/app/x", "document")?.id).toBe("high");
  });

  it("path prefix gates the match", () => {
    expect(policyMatch(p, "https://example.com/other", "document")?.id).toBe("low");
  });

  it("host suffix matches subdomains only", () => {
    expect(policyMatch(p, "https://sub.example.com/a", "document")?.id).toBe("low");
    expect(policyMatch(p, "https://notexample.com/a", "document")).toBeNull();
  });

  it("equal priority: the later rule wins", () => {
    expect(policyMatch(p, "https://cdn.example.com/x", "fetch")?.id).toBe("tie-b");
  });

  it("type filter gates the match", () => {
    const t = compilePolicy(`rule "only-script" {
  match host="example.com"
  types "script"
  route "rewrite"
}`);
    expect(policyMatch(t, "https://example.com/x.js", "script")?.id).toBe("only-script");
    expect(policyMatch(t, "https://example.com/x.png", "image")).toBeNull();
  });

  it("no rules means no match (default behavior)", () => {
    expect(policyMatch({ rules: [] }, "https://example.com/", "document")).toBeNull();
  });

  it("bad urls never match", () => {
    expect(policyMatch(p, "not a url", "document")).toBeNull();
  });
});

describe("loadPolicy", () => {
  beforeEach(() => policyResetForTests());

  it("missing file means empty policy", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nf", { status: 404 })) as typeof fetch;
    expect((await loadPolicy()).rules).toEqual([]);
    globalThis.fetch = orig;
  });

  it("malformed file means empty policy", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('rule "x" { route "banana" }', { status: 200 })) as typeof fetch;
    expect((await loadPolicy()).rules).toEqual([]);
    globalThis.fetch = orig;
  });

  it("loads and memoizes a valid file", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(K, { status: 200 });
    }) as typeof fetch;
    const p = await loadPolicy();
    await loadPolicy();
    expect(p.rules).toHaveLength(1);
    expect(calls).toBe(1);
    globalThis.fetch = orig;
  });
});
/* The shipped app/public/policy.kdl is production data served to the
   SW at engine origin. Gate it in CI: an unparseable edit would fall
   back to defaults and silently drop every relay host. */
describe("shipped policy.kdl", () => {
  const p = compilePolicy(shippedPolicy);

  it("compiles with rules", () => {
    expect(p.rules.length).toBeGreaterThan(0);
  });

  it("relays the #137 ddg host", () => {
    expect(policyMatch(p, "https://duckduckgo.com/", "document")).toMatchObject({ route: "relay" });
    expect(policyMatch(p, "https://html.duckduckgo.com/html/", "document")).toMatchObject({ route: "relay" });
  });

  it("relays the #149 blocked hosts (wasm TLS/h2 shapes rejected upstream)", () => {
    for (const host of [
      "cbc.ca", "www.cbc.ca", "united.com", "www.united.com",
      "opentable.com", "acer.com", "slither.io", "delta.com",
    ]) {
      expect(policyMatch(p, "https://" + host + "/", "document"), host).toMatchObject({ route: "relay" });
    }
  });

  /* Wave 17: the shipped file carries a match-less catch-all
     (first in the file, so later specific rules win ties) because the
     LB deployment keeps wisp auth the wasm client cannot pass -
     every upstream fetch rides the embedder relay there. */
  it("rides the catch-all relay for unrelated hosts and hop domains", () => {
    for (const host of ["example.com", "slither.com", "wikipedia.org"]) {
      expect(policyMatch(p, "https://" + host + "/", "document"), host).toMatchObject({ id: "default-relay", route: "relay" });
    }
    expect(policyMatch(p, "https://example.com/x.js", "script")).toMatchObject({ id: "default-relay", route: "relay" });
  });
});
