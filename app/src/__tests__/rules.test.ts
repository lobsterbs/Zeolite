import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRules, compileRules, loadRules, rulesResetForTests, setRulesEnabled } from "../rules";

const RULES = compileRules({
  block: [
    { host: "doubleclick.net" },
    { host: "ads.example", types: ["script"] },
    { host: "captcha.example" },
  ],
  allow: [{ host: "captcha.example" }],
  rewrite: [{ from: "http://insecure.example/", to: "https://insecure.example/" }],
  modify: [{ host: "news.example", headers: { "x-rule": "1" } }],
});

beforeEach(() => rulesResetForTests());
afterEach(() => rulesResetForTests());

describe("applyRules", () => {
  it("blocks the host and every subdomain", () => {
    expect(applyRules(RULES, "https://ad.doubleclick.net/x.js", "script").action).toBe("block");
    expect(applyRules(RULES, "https://doubleclick.net/", "document").action).toBe("block");
    expect(applyRules(RULES, "https://evildoubleclick.net/", "script").action).toBe("pass");
  });

  it("honors the resource-type filter", () => {
    expect(applyRules(RULES, "https://ads.example/a.js", "script").action).toBe("block");
    expect(applyRules(RULES, "https://ads.example/a.png", "image").action).toBe("pass");
  });

  it("allow beats block (captcha hosts)", () => {
    expect(applyRules(RULES, "https://captcha.example/widget", "script")).toMatchObject({
      action: "allow",
      matched: "captcha.example",
    });
  });

  it("rewrites url prefixes and reports the new url", () => {
    const d = applyRules(RULES, "http://insecure.example/page", "document");
    expect(d.action).toBe("pass");
    expect(d.url).toBe("https://insecure.example/page");
  });

  it("merges modify headers for the host", () => {
    const d = applyRules(RULES, "https://news.example/article", "fetch");
    expect(d.headers).toEqual({ "x-rule": "1" });
  });

  it("is a no-op while disabled", () => {
    setRulesEnabled(false);
    expect(applyRules(RULES, "https://doubleclick.net/x", "script").action).toBe("pass");
  });

  it("passes unparseable urls", () => {
    expect(applyRules(RULES, "not a url", "other").action).toBe("pass");
  });
});

describe("compileRules", () => {
  it("tolerates missing and malformed data", () => {
    expect(compileRules(null).block).toEqual([]);
    expect(compileRules({ block: [{ host: "" }] }).block).toEqual([]);
    expect(compileRules({ modify: [{ host: "x" } as never] }).modify).toEqual([]);
  });
});

describe("loadRules", () => {
  it("missing rules.json means no rules", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nf", { status: 404 })) as typeof fetch;
    expect((await loadRules()).block).toEqual([]);
    globalThis.fetch = orig;
  });

  it("malformed json means no rules", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{oops", { status: 200 })) as typeof fetch;
    expect((await loadRules()).block).toEqual([]);
    globalThis.fetch = orig;
  });

  it("loads and compiles rule data", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ block: [{ host: "BLOCK.example" }] }), {
        status: 200,
      })) as typeof fetch;
    const r = await loadRules();
    expect(applyRules(r, "https://sub.block.example/x", "fetch").action).toBe("block");
    globalThis.fetch = orig;
  });
});
