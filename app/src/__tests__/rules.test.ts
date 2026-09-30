import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRules,
  compileRules,
  loadRules,
  rulesResetForTests,
  setRulesEnabled,
  setSiteOverrides,
  siteUaFor,
} from "../rules";

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

describe("site overrides (zl:rules)", () => {
  it("adblock false spares the host and its subdomains only", () => {
    setSiteOverrides([{ host: "doubleclick.net", adblock: false }]);
    expect(applyRules(RULES, "https://ad.doubleclick.net/x.js", "script").action).toBe("pass");
    expect(applyRules(RULES, "https://doubleclick.net/", "document").action).toBe("pass");
    expect(applyRules(RULES, "https://ads.example/a.js", "script").action).toBe("block");
  });

  it("the allow list still wins over an adblock override", () => {
    setSiteOverrides([{ host: "captcha.example", adblock: false }]);
    expect(applyRules(RULES, "https://captcha.example/widget", "script").action).toBe("allow");
  });

  it("rewrite and modify still run for an overridden host", () => {
    setSiteOverrides([{ host: "insecure.example", adblock: false }]);
    const d = applyRules(RULES, "http://insecure.example/page", "document");
    expect(d.action).toBe("pass");
    expect(d.url).toBe("https://insecure.example/page");
  });

  it("the global disable still wins over per-site overrides", () => {
    setSiteOverrides([{ host: "doubleclick.net", adblock: true }]);
    setRulesEnabled(false);
    expect(applyRules(RULES, "https://doubleclick.net/x", "script").action).toBe("pass");
  });

  it("longest host suffix wins", () => {
    setSiteOverrides([{ host: "example", ua: "UA-A" }, { host: "sub.example", ua: "UA-B" }]);
    expect(siteUaFor("https://x.sub.example/")).toBe("UA-B");
    expect(siteUaFor("https://other.example/")).toBe("UA-A");
  });

  it("siteUaFor falls back to the default ua, then null", () => {
    setSiteOverrides([{ host: "example", ua: "UA-A" }], "UA-DEF");
    expect(siteUaFor("https://example/")).toBe("UA-A");
    expect(siteUaFor("https://other.org/")).toBe("UA-DEF");
    setSiteOverrides(null, "");
    expect(siteUaFor("https://example/")).toBeNull();
  });

  it("tolerates garbage input", () => {
    expect(setSiteOverrides("junk" as never, 42 as never)).toBe(0);
    expect(
      setSiteOverrides([{ host: "" }, { host: "ok.example", adblock: "yes" as never, ua: "" }]),
    ).toBe(1);
    expect(applyRules(RULES, "https://ok.example/", "document").action).toBe("pass");
    expect(siteUaFor("https://sub.ok.example/")).toBeNull();
  });
});
