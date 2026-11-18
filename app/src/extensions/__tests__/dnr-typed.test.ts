import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  DNR,
  DYNAMIC_RULESET_ID,
  SESSION_RULESET_ID,
  MAX_NUMBER_OF_DYNAMIC_RULES,
  MAX_NUMBER_OF_SESSION_RULES,
  MAX_NUMBER_OF_REGEX_RULES,
  MAX_NUMBER_OF_DISABLED_STATIC_RULES,
  GUARANTEED_MINIMUM_STATIC_RULES,
} from "../dnr";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

/* The same fake provider wiring dnr.test.ts uses, so these tests
   exercise exactly the view control.ts wires in production. */
let fakeExts: Array<{ id: string; hosts: string[]; withHostAccess: boolean; enabled: boolean; rulesets: { id: string; path: string; enabled: boolean }[] }> = [];
function wireFake(): void {
  DNR.setPermProvider(() =>
    fakeExts.map((f) => ({
      id: f.id,
      hosts: [...f.hosts],
      withHostAccess: f.withHostAccess,
      enabled: f.enabled,
      staticRulesets: f.rulesets.map((r) => ({ ...r })),
    })),
  );
}
function addExt(id: string): void {
  fakeExts.push({ id, hosts: [], withHostAccess: false, enabled: true, rulesets: [] });
}

/* The same view the manager singleton yields in production. */
function wireManagerOf(m: ExtensionManager): void {
  DNR.setPermProvider(() =>
    m.list().map((rec) => ({
      id: rec.id,
      hosts: [...rec.hostPermissions],
      withHostAccess: rec.permissions.includes("declarativeNetRequestWithHostAccess"),
      enabled: rec.enabled,
      staticRulesets: (rec.declarativeNetRequest?.ruleResources ?? []).map((rs) => ({ ...rs })),
    })),
  );
}

function facts(url: string, type = "main_frame"): { url: string; method: string; type: string } {
  return { url, method: "GET", type };
}

const blockRule = (id: number, urlFilter: string) => ({
  id,
  priority: 1,
  condition: { urlFilter },
  action: { type: "block" },
});
const allowRule = (id: number, urlFilter: string) => ({
  id,
  priority: 1,
  condition: { urlFilter },
  action: { type: "allow" },
});
const redirectRule = (id: number, urlFilter: string, to: string) => ({
  id,
  priority: 1,
  condition: { urlFilter },
  action: { type: "redirect", redirect: { url: to } },
});

function pkg(name: string, extra: Record<string, unknown>, files: Record<string, string>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", ...extra }))],
  ]);
  for (const [p, c] of Object.entries(files)) out.set(p, enc.encode(c));
  return out;
}

beforeEach(() => {
  fakeExts = [];
  DNR.resetForTests();
  wireFake();
});

afterEach(() => {
  DNR.resetForTests();
});

describe("typed surface constants (#521 slice 4)", () => {
  it("carries the reserved ruleset ids and the engine-defined quota approximations", () => {
    expect(DYNAMIC_RULESET_ID).toBe("_dynamic");
    expect(SESSION_RULESET_ID).toBe("_session");
    expect(MAX_NUMBER_OF_DYNAMIC_RULES).toBe(5000);
    expect(MAX_NUMBER_OF_SESSION_RULES).toBe(5000);
    expect(MAX_NUMBER_OF_REGEX_RULES).toBe(1000);
    expect(MAX_NUMBER_OF_DISABLED_STATIC_RULES).toBe(5000);
  });
});

describe("isRegexSupported (#521 slice 4)", () => {
  it("answers for the engine's own JavaScript matcher", () => {
    expect(DNR.isRegexSupported("^https://a\\.example/.*")).toEqual({ isSupported: true });
    const bad = DNR.isRegexSupported("[unclosed");
    expect(bad.isSupported).toBe(false);
    expect(bad.reason).toBeTruthy();
    expect(DNR.isRegexSupported("").isSupported).toBe(false);
    expect(DNR.isRegexSupported(7).isSupported).toBe(false);
    /* Chrome's isCaseSensitive argument is accepted and ignored. */
    expect(DNR.isRegexSupported("a", true)).toEqual({ isSupported: true });
  });
});

describe("static rule enable/disable (#521 slice 4)", () => {
  /* The subsystem IDB persists installs across managers, so every
     setup lands in one shared store: the urlFilters must be unique
     per setup or an earlier test's extension keeps matching. */
  async function setup(): Promise<{ m: ExtensionManager; id: string; tag: string }> {
    const tag = "t" + Math.random().toString(36).slice(2, 8);
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(
      pkg(
        "typed static " + tag,
        {
          permissions: ["declarativeNetRequest"],
          declarative_net_request: { rule_resources: [{ id: "rs1", path: "rules.json", enabled: true }] },
        },
        {
          "rules.json": JSON.stringify([
            blockRule(1, tag + ".one.static"),
            blockRule(2, tag + ".two.static"),
            blockRule(3, tag + ".three.static"),
          ]),
        },
      ),
    );
    wireManagerOf(m);
    await DNR.hydrate();
    return { m, id, tag };
  }

  it("a disabled rule never loads and frees its quota share", async () => {
    const { id, tag } = await setup();
    await DNR.updateStaticRules(id, { rulesetId: "rs1", disableRuleIds: [2] });
    expect(DNR.getDisabledRuleIds(id, { rulesetId: "rs1" })).toEqual({ rulesetIds: [2] });
    expect(await DNR.decideRequest(facts("https://" + tag + ".two.static/x"))).toBe(false);
    expect(await DNR.decideRequest(facts("https://" + tag + ".one.static/x"))).toBe(true);
    expect(await DNR.getAvailableStaticRuleCount(id)).toBe(GUARANTEED_MINIMUM_STATIC_RULES - 2);
    await DNR.updateStaticRules(id, { rulesetId: "rs1", enableRuleIds: [2] });
    expect(DNR.getDisabledRuleIds(id, { rulesetId: "rs1" })).toEqual({ rulesetIds: [] });
    expect(await DNR.decideRequest(facts("https://" + tag + ".two.static/x"))).toBe(true);
  });

  it("the disabled set survives a worker restart", async () => {
    /* Same pattern as the persistence tests: the manager view stays,
       the registry memory dies with resetForTests, the store survives. */
    const { m, id, tag } = await setup();
    await DNR.updateStaticRules(id, { rulesetId: "rs1", disableRuleIds: [1, 3] });
    await DNR.flushForTests();
    DNR.resetForTests();
    wireManagerOf(m);
    await DNR.hydrate();
    expect(DNR.getDisabledRuleIds(id, { rulesetId: "rs1" })).toEqual({ rulesetIds: [1, 3] });
    expect(await DNR.decideRequest(facts("https://" + tag + ".one.static/x"))).toBe(false);
    expect(await DNR.decideRequest(facts("https://" + tag + ".two.static/x"))).toBe(true);
  });

  it("refuses unknown rulesets, both-direction ids and non-integers", async () => {
    const { id } = await setup();
    await expect(DNR.updateStaticRules(id, { rulesetId: "alien", disableRuleIds: [1] })).rejects.toThrow(/unknown static ruleset id/);
    await expect(DNR.updateStaticRules(id, { rulesetId: "rs1", disableRuleIds: [1], enableRuleIds: [1] })).rejects.toThrow(/cannot be disabled and enabled/);
    await expect(DNR.updateStaticRules(id, { rulesetId: "rs1", disableRuleIds: [1.5] })).rejects.toThrow(/integers/);
    await expect(DNR.updateStaticRules(id, { rulesetId: "rs1", disableRuleIds: "x" })).rejects.toThrow(/array/);
    /* getDisabledRuleIds is synchronous: throws, never rejects. */
    expect(() => DNR.getDisabledRuleIds(id, { rulesetId: "alien" })).toThrow(/unknown static ruleset id/);
    expect(() => DNR.getDisabledRuleIds(id, {})).toThrow(/rulesetId/);
  });
});

describe("testMatchOutcome (#521 slice 4)", () => {
  it("dry-runs the real matcher and reports effect plus ruleset ids", async () => {
    const id = "ext-a";
    addExt(id);
    await DNR.updateDynamicRules(id, { addRules: [blockRule(9, "blocked.example")] });
    expect(await DNR.testMatchOutcome(id, facts("https://blocked.example/a"))).toEqual({
      effect: "block",
      matchedRules: [{ ruleId: 9, rulesetId: DYNAMIC_RULESET_ID }],
    });
    expect(await DNR.testMatchOutcome(id, facts("https://clean.example/a"))).toEqual({
      effect: "none",
      matchedRules: [],
    });
    DNR.updateSessionRules(id, { addRules: [redirectRule(4, "redir.example", "https://elsewhere.example/")] });
    expect(await DNR.testMatchOutcome(id, facts("https://redir.example/"))).toEqual({
      effect: "redirect",
      matchedRules: [{ ruleId: 4, rulesetId: SESSION_RULESET_ID }],
    });
  });

  it("maps allow to the allow effect and crosses extensions only when asked", async () => {
    const a = "ext-a";
    const b = "ext-b";
    addExt(a);
    addExt(b);
    await DNR.updateDynamicRules(a, { addRules: [allowRule(1, "shared.example")] });
    await DNR.updateDynamicRules(b, { addRules: [blockRule(2, "shared.example")] });
    const mineOnly = await DNR.testMatchOutcome(a, facts("https://shared.example/"));
    expect(mineOnly.effect).toBe("allow");
    expect(mineOnly.matchedRules).toEqual([{ ruleId: 1, rulesetId: DYNAMIC_RULESET_ID }]);
    const everyone = await DNR.testMatchOutcome(a, facts("https://shared.example/"), { includeOtherExtensions: true });
    expect(everyone.effect).toBe("block");
    expect(everyone.matchedRules).toHaveLength(2);
  });

  it("validates the request shape honestly", async () => {
    const id = "ext-a";
    addExt(id);
    await expect(DNR.testMatchOutcome(id, { type: "main_frame" })).rejects.toThrow(/request\.url/);
    await expect(DNR.testMatchOutcome(id, facts("https://x.example/", "notatype"))).rejects.toThrow(/known resource type/);
    await expect(DNR.testMatchOutcome(id, "nope")).rejects.toThrow(/request must be an object/);
    await expect(DNR.testMatchOutcome(id, facts("https://x.example/"), 7)).rejects.toThrow(/options must be an object/);
  });
});

describe("browser.declarativeNetRequest typed surface (#521 slice 4)", () => {
  it("mounts the constants and the four methods; a dry run works over the API", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(
      pkg(
        "TypedApi" + Math.random().toString(36).slice(2, 6),
        { permissions: ["declarativeNetRequest", "declarativeNetRequestFeedback"] },
        {},
      ),
    );
    const rec = m.get(id)!;
    const { browser } = buildApi(
      rec,
      { extensionId: id, context: "background", url: null } as never,
      {
        messenger: new ExtensionMessenger(),
        storage: {
          local: new ExtensionStorageArea(id, "local", "local"),
          sync: new ExtensionStorageArea(id, "sync", "sync"),
          session: new ExtensionStorageArea(id, "session", "session"),
        },
        manager: m,
      },
    );
    wireManagerOf(m);
    const ns = (browser as Record<string, unknown>).declarativeNetRequest as Record<string, unknown>;
    expect(ns.DYNAMIC_RULESET_ID).toBe("_dynamic");
    expect(ns.SESSION_RULESET_ID).toBe("_session");
    expect(ns.MAX_NUMBER_OF_DYNAMIC_RULES).toBe(5000);
    expect(typeof ns.isRegexSupported).toBe("function");
    expect(typeof ns.updateStaticRules).toBe("function");
    expect(typeof ns.getDisabledRuleIds).toBe("function");
    expect(typeof ns.testMatchOutcome).toBe("function");
    await DNR.updateDynamicRules(id, { addRules: [blockRule(3, "api.example")] });
    await expect(
      (ns.testMatchOutcome as (r: unknown) => Promise<{ effect: string }>)({ url: "https://api.example/", type: "main_frame", method: "GET" }),
    ).resolves.toHaveProperty("effect", "block");
  });
});
