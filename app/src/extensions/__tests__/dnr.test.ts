import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DNR, validateRule, urlFilterToRegex, MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES, GUARANTEED_MINIMUM_STATIC_RULES } from "../dnr";
import { openDb, idbPut, STORE_DNR } from "../idb";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

/* A plain in-memory extension set wired as the DNR provider, so the
   matcher tests exercise exactly the view control.ts wires in
   production (enabled state, host permissions, declared rulesets). */
interface FakeExt {
  id: string;
  hosts: string[];
  withHostAccess: boolean;
  enabled: boolean;
  rulesets: { id: string; path: string; enabled: boolean }[];
}
let fakeExts: FakeExt[] = [];
function addExt(id: string, opts: Partial<FakeExt> = {}): FakeExt {
  const f: FakeExt = { id, hosts: [], withHostAccess: false, enabled: true, rulesets: [], ...opts };
  fakeExts.push(f);
  return f;
}
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
/** The same view the manager singleton yields in production. */
function wireManager(m: ExtensionManager): void {
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

function facts(
  url: string,
  o: { method?: string; type?: string; initiator?: string } = {},
): { url: string; method: string; type: string; initiator?: string } {
  return { url, method: o.method ?? "GET", type: o.type ?? "main_frame", initiator: o.initiator };
}

const blockRule = (id: number, urlFilter: string, extra: Record<string, unknown> = {}) => ({
  id,
  priority: 1,
  condition: { urlFilter, ...extra },
  action: { type: "block" },
});

function pkg(name: string, extra: Record<string, unknown>, files: Record<string, string> = {}): Map<string, Uint8Array> {
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

describe("rule validation (#521)", () => {
  it("rejects redirect and upgradeScheme with the honest no-seam reason", () => {
    expect(() => validateRule({ id: 1, condition: { urlFilter: "x" }, action: { type: "redirect", redirect: {} } })).toThrow(
      /no internal redirect re-entry seam/,
    );
    expect(() => validateRule({ id: 1, condition: { urlFilter: "x" }, action: { type: "upgradeScheme" } })).toThrow(
      /no internal redirect re-entry seam/,
    );
  });

  it("rejects allowAllRequests (no per-document rule state)", () => {
    expect(() => validateRule({ id: 1, condition: {}, action: { type: "allowAllRequests" } })).toThrow(/per-document rule state/);
  });

  it("rejects bad ids, priorities and conditions", () => {
    expect(() => validateRule({ id: 0, action: { type: "block" } })).toThrow(/id/);
    expect(() => validateRule({ id: 1.5, action: { type: "block" } })).toThrow(/id/);
    expect(() => validateRule({ id: 1, priority: 0, action: { type: "block" } })).toThrow(/priority/);
    expect(() => validateRule({ id: 1, condition: { urlFilter: "a", regexFilter: "b" }, action: { type: "block" } })).toThrow(
      /both urlFilter and regexFilter/,
    );
    expect(() => validateRule({ id: 1, condition: { regexFilter: "(" }, action: { type: "block" } })).toThrow(/compile/);
    expect(() => validateRule({ id: 1, condition: { resourceTypes: [] }, action: { type: "block" } })).toThrow(/resourceTypes/);
    expect(() => validateRule({ id: 1, condition: { resourceTypes: ["alien"] }, action: { type: "block" } })).toThrow(/alien/);
  });

  it("rejects malformed modifyHeaders operations", () => {
    const action = { type: "modifyHeaders", requestHeaders: [{ header: "x", operation: "set" }] };
    expect(() => validateRule({ id: 1, action })).toThrow(/string value/);
    expect(() =>
      validateRule({ id: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "x", operation: "mutate", value: "v" }] } }),
    ).toThrow(/set, remove or append/);
    expect(() =>
      validateRule({ id: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "", operation: "remove" }] } }),
    ).toThrow(/header/);
  });

  it("urlFilter anchors and wildcards compile to the documented semantics", () => {
    expect(urlFilterToRegex("marker").test("https://a.com/xmarkerz")).toBe(true);
    expect(urlFilterToRegex("|https://bad").test("https://good.ca/x?u=https://bad")).toBe(false);
    expect(urlFilterToRegex("|https://bad").test("https://bad.example/")).toBe(true);
    expect(urlFilterToRegex("example.org/|").test("https://example.org/")).toBe(true);
    expect(urlFilterToRegex("example.org/|").test("https://example.org/x")).toBe(false);
    expect(urlFilterToRegex("ex*ple").test("https://exZZZple.com/")).toBe(true);
    /* ^ is a separator: matches the end or any non-alnum/_-.% char */
    expect(urlFilterToRegex("example^com").test("https://example.com/")).toBe(false);
    expect(urlFilterToRegex("example^com").test("https://example;com/")).toBe(true);
    expect(urlFilterToRegex("example.com^").test("https://example.com")).toBe(true);
    expect(urlFilterToRegex("example.com^").test("https://example.comx")).toBe(false);
  });
});

describe("matching (#521)", () => {
  it("blocks on a substring urlFilter and a regexFilter", async () => {
    addExt("e1");
    DNR.updateSessionRules("e1", { addRules: [blockRule(1, "tracker")] });
    expect(await DNR.decideRequest(facts("https://cdn.example/xtracker.js", { type: "script" }))).toBe(true);
    expect(await DNR.decideRequest(facts("https://cdn.example/x.js", { type: "script" }))).toBe(false);
    DNR.updateSessionRules("e1", { removeRuleIds: [1] });
    DNR.updateSessionRules("e1", {
      addRules: [{ id: 2, priority: 1, condition: { regexFilter: "^https://a\\.com/[0-9]+$" }, action: { type: "block" } }],
    });
    expect(await DNR.decideRequest(facts("https://a.com/12"))).toBe(true);
    expect(await DNR.decideRequest(facts("https://a.com/ab"))).toBe(false);
  });

  it("domains match equal or subdomain, excludedDomains carve out", async () => {
    addExt("e1");
    DNR.updateSessionRules("e1", {
      addRules: [
        blockRule(1, "example", { domains: ["example.org"], excludedDomains: ["ads.example.org"] }),
      ],
    });
    expect(await DNR.decideRequest(facts("https://example.org/x"))).toBe(true);
    expect(await DNR.decideRequest(facts("https://cdn.example.org/x"))).toBe(true);
    expect(await DNR.decideRequest(facts("https://example.org.evil.net/x"))).toBe(false);
    expect(await DNR.decideRequest(facts("https://ads.example.org/x"))).toBe(false);
  });

  it("initiatorDomains need a matching initiator; excludedInitiatorDomains carve out", async () => {
    addExt("e1");
    DNR.updateSessionRules("e1", {
      addRules: [blockRule(1, "cdn", { initiatorDomains: ["frame.example"], excludedInitiatorDomains: ["bad.frame.example"] })],
    });
    expect(await DNR.decideRequest(facts("https://cdn.net/lib.js", { type: "script", initiator: "https://frame.example/x" }))).toBe(true);
    expect(await DNR.decideRequest(facts("https://cdn.net/lib.js", { type: "script" }))).toBe(false);
    expect(
      await DNR.decideRequest(facts("https://cdn.net/lib.js", { type: "script", initiator: "https://other.example/" })),
    ).toBe(false);
    expect(
      await DNR.decideRequest(facts("https://cdn.net/lib.js", { type: "script", initiator: "https://bad.frame.example/" })),
    ).toBe(false);
  });

  it("requestMethods match case-insensitively and resourceTypes gate", async () => {
    addExt("e1");
    DNR.updateSessionRules("e1", {
      addRules: [blockRule(1, "api", { requestMethods: ["post"], resourceTypes: ["xmlhttprequest"] })],
    });
    /* The engine surfaces fetch/XHR as "other", so a rule typed
       "xmlhttprequest" honestly never matches a tunnel fetch: the
       documented divergence, asserted here as the contract. */
    expect(await DNR.decideRequest(facts("https://api.net/v1", { method: "POST", type: "other" }))).toBe(false);
    DNR.updateSessionRules("e1", { removeRuleIds: [1] });
    DNR.updateSessionRules("e1", { addRules: [blockRule(2, "api", { requestMethods: ["get"], resourceTypes: ["other"] })] });
    expect(await DNR.decideRequest(facts("https://api.net/v1", { method: "get", type: "other" }))).toBe(true);
    expect(await DNR.decideRequest(facts("https://api.net/v1", { method: "POST", type: "other" }))).toBe(false);
  });
});

describe("precedence (#521)", () => {
  it("priority beats action class: a lower-priority allow loses to a higher-priority block", async () => {
    addExt("e1");
    DNR.updateDynamicRules("e1", {
      addRules: [{ id: 1, priority: 1, condition: { urlFilter: "site" }, action: { type: "allow" } }],
    });
    DNR.updateSessionRules("e1", {
      addRules: [{ id: 2, priority: 2, condition: { urlFilter: "site" }, action: { type: "block" } }],
    });
    expect(await DNR.decideRequest(facts("https://site.net/"))).toBe(true);
  });

  it("at equal priority allow beats block inside one extension", async () => {
    addExt("e1");
    DNR.updateSessionRules("e1", {
      addRules: [
        blockRule(1, "site"),
        { id: 2, priority: 1, condition: { urlFilter: "allowed" }, action: { type: "allow" } },
      ],
    });
    expect(await DNR.decideRequest(facts("https://site.net/allowed"))).toBe(false);
    expect(await DNR.decideRequest(facts("https://site.net/blocked"))).toBe(true);
  });

  it("at equal priority and action session beats dynamic (Firefox tie-break)", () => {
    addExt("e1", { hosts: ["*://site.net/*"] });
    DNR.updateDynamicRules("e1", {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: "site" },
          action: { type: "modifyHeaders", requestHeaders: [{ header: "x-zl", operation: "set", value: "dynamic" }] },
        },
      ],
    });
    DNR.updateSessionRules("e1", {
      addRules: [
        {
          id: 2,
          priority: 1,
          condition: { urlFilter: "site" },
          action: { type: "modifyHeaders", requestHeaders: [{ header: "x-zl", operation: "set", value: "session" }] },
        },
      ],
    });
    const h = new Headers();
    DNR.applyRequestHeaders(facts("https://site.net/"), h);
    expect(h.get("x-zl")).toBe("session");
  });

  it("across extensions a block beats another extension's allow", async () => {
    addExt("allowExt");
    addExt("blockExt");
    DNR.updateSessionRules("allowExt", {
      addRules: [{ id: 1, priority: 100, condition: { urlFilter: "site" }, action: { type: "allow" } }],
    });
    DNR.updateSessionRules("blockExt", { addRules: [blockRule(1, "site")] });
    expect(await DNR.decideRequest(facts("https://site.net/"))).toBe(true);
  });

  it("a disabled extension's rules never apply", async () => {
    const f = addExt("e1");
    DNR.updateSessionRules("e1", { addRules: [blockRule(1, "site")] });
    f.enabled = false;
    expect(await DNR.decideRequest(facts("https://site.net/"))).toBe(false);
  });

  it("duplicate rule ids inside one update are rejected atomically", () => {
    addExt("e1");
    expect(() => DNR.updateSessionRules("e1", { addRules: [blockRule(1, "a"), blockRule(1, "b")] })).toThrow(/duplicate rule id/);
    expect(DNR.getSessionRules("e1")).toEqual([]);
  });
});

describe("permission gating (#521)", () => {
  it("the plain declarativeNetRequest permission blocks without host permissions", async () => {
    addExt("e1", { hosts: [] });
    DNR.updateSessionRules("e1", { addRules: [blockRule(1, "site")] });
    expect(await DNR.decideRequest(facts("https://site.net/"))).toBe(true);
  });

  it("declarativeNetRequestWithHostAccess blocks only with a host permission", async () => {
    addExt("e1", { withHostAccess: true, hosts: ["*://allowed.net/*"] });
    DNR.updateSessionRules("e1", { addRules: [blockRule(1, "site")] });
    expect(await DNR.decideRequest(facts("https://site.net/"))).toBe(false);
    expect(await DNR.decideRequest(facts("https://allowed.net/site"))).toBe(true);
  });

  it("modifyHeaders is ignored without a host permission on the request URL", () => {
    addExt("e1", { hosts: [] });
    DNR.updateSessionRules("e1", {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: "site" },
          action: { type: "modifyHeaders", requestHeaders: [{ header: "x-zl", operation: "set", value: "v" }] },
        },
      ],
    });
    const h = new Headers();
    DNR.applyRequestHeaders(facts("https://site.net/"), h);
    expect(h.get("x-zl")).toBe(null);
  });

  it("modifyHeaders on sub_frame requests additionally needs the initiator origin", () => {
    addExt("e1", { hosts: ["*://site.net/*", "*://frame.net/*"] });
    DNR.updateSessionRules("e1", {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: "site" },
          action: { type: "modifyHeaders", requestHeaders: [{ header: "x-zl", operation: "set", value: "v" }] },
        },
      ],
    });
    const denied = new Headers();
    DNR.applyRequestHeaders(facts("https://site.net/", { type: "sub_frame", initiator: "https://other.net/" }), denied);
    expect(denied.get("x-zl")).toBe(null);
    const granted = new Headers();
    DNR.applyRequestHeaders(facts("https://site.net/", { type: "sub_frame", initiator: "https://frame.net/x" }), granted);
    expect(granted.get("x-zl")).toBe("v");
  });
});

describe("modifyHeaders operations (#521)", () => {
  it("set, remove and append (append joins with a comma and space)", () => {
    addExt("e1", { hosts: ["*://site.net/*"] });
    DNR.updateSessionRules("e1", {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { urlFilter: "site" },
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "x-zl", operation: "set", value: "one" }],
            responseHeaders: [
              { header: "x-zl-resp", operation: "append", value: "a" },
              { header: "x-zl-resp", operation: "append", value: "b" },
              { header: "x-zl-drop", operation: "remove" },
            ],
          },
        },
      ],
    });
    const req = new Headers();
    DNR.applyRequestHeaders(facts("https://site.net/"), req);
    expect(req.get("x-zl")).toBe("one");
    const resp = new Headers({ "x-zl-drop": "gone", "x-zl-resp": "base" });
    DNR.applyResponseHeaders(facts("https://site.net/"), resp);
    expect(resp.get("x-zl-resp")).toBe("base, a, b");
    expect(resp.get("x-zl-drop")).toBe(null);
  });

  it("response ops do not fire when the best rule is a block", () => {
    addExt("e1", { hosts: ["*://site.net/*"] });
    DNR.updateSessionRules("e1", {
      addRules: [
        blockRule(1, "site", { resourceTypes: ["main_frame"] }),
        {
          id: 2,
          priority: 1,
          condition: { urlFilter: "site", resourceTypes: ["script"] },
          action: { type: "modifyHeaders", responseHeaders: [{ header: "x-zl", operation: "set", value: "v" }] },
        },
      ],
    });
    const h = new Headers();
    DNR.applyResponseHeaders(facts("https://site.net/"), h);
    expect(h.get("x-zl")).toBe(null);
    DNR.applyResponseHeaders(facts("https://site.net/lib.js", { type: "script" }), h);
    expect(h.get("x-zl")).toBe("v");
  });
});

describe("quotas (#521)", () => {
  it("rejects dynamic+session updates past the combined cap", async () => {
    addExt("e1");
    expect(MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES).toBe(5000);
    const bulk = (n: number, base: number) =>
      Array.from({ length: n }, (_, i) => blockRule(base + i, "site" + (base + i)));
    /* 4999 dynamic rules, then two session rules cross the cap.
       updateDynamicRules is async, so its quota rejection must be
       asserted on the promise; updateSessionRules throws synchronously. */
    await DNR.updateDynamicRules("e1", { addRules: bulk(4999, 1) });
    DNR.updateSessionRules("e1", { addRules: bulk(1, 9001) });
    expect(() => DNR.updateSessionRules("e1", { addRules: bulk(1, 9002) })).toThrow(/quota/);
    expect(DNR.getSessionRules("e1")).toHaveLength(1);
    await expect(DNR.updateDynamicRules("e1", { addRules: bulk(2, 9100) })).rejects.toThrow(/quota/);
  });
});

describe("static rulesets (#521)", () => {
  it("load lazily from the stored package; invalid rules are silently ignored", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(
      pkg(
        "static blocker",
        {
          permissions: ["declarativeNetRequest"],
          declarative_net_request: { rule_resources: [{ id: "rs1", path: "rules.json", enabled: true }] },
        },
        {
          "rules.json": JSON.stringify([
            blockRule(1, "staticblocked"),
            { id: 2, action: { type: "redirect", redirect: {} } },
            "junk",
          ]),
        },
      ),
    );
    wireManager(m);
    const rec = m.get(id)!;
    expect(rec.declarativeNetRequest?.ruleResources).toEqual([{ id: "rs1", path: "rules.json", enabled: true }]);
    expect(await DNR.decideRequest(facts("https://staticblocked.net/x"))).toBe(true);
    expect(await DNR.decideRequest(facts("https://clean.net/x"))).toBe(false);
    /* The invalid redirect rule was ignored, not applied: no throw,
       and the count reflects only the valid rule. */
    expect(await DNR.getAvailableStaticRuleCount(id)).toBe(GUARANTEED_MINIMUM_STATIC_RULES - 1);
    await m.uninstall(id);
    expect(await DNR.decideRequest(facts("https://staticblocked.net/x"))).toBe(false);
  });

  it("a disabled ruleset stays silent until updateEnabledRulesets enables it", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(
      pkg(
        "static off",
        {
          permissions: ["declarativeNetRequest"],
          declarative_net_request: { rule_resources: [{ id: "rs1", path: "rules.json", enabled: false }] },
        },
        { "rules.json": JSON.stringify([blockRule(1, "staticblocked")]) },
      ),
    );
    wireManager(m);
    expect(await DNR.decideRequest(facts("https://staticblocked.net/x"))).toBe(false);
    expect(DNR.getEnabledRulesets(id)).toEqual({ rs1: { disabled: true } });
    await DNR.updateEnabledRulesets(id, { enableRulesetIds: ["rs1"] });
    expect(DNR.getEnabledRulesets(id)).toEqual({ rs1: { disabled: false } });
    expect(await DNR.decideRequest(facts("https://staticblocked.net/x"))).toBe(true);
    await expect(DNR.updateEnabledRulesets(id, { enableRulesetIds: ["alien"] })).rejects.toThrow(/unknown static ruleset id/);
  });
});

describe("persistence (#521)", () => {
  it("dynamic rules and the enabled ruleset snapshot survive a worker restart", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(
      pkg(
        "persisted",
        {
          permissions: ["declarativeNetRequest"],
          declarative_net_request: { rule_resources: [{ id: "rs1", path: "rules.json", enabled: false }] },
        },
        { "rules.json": JSON.stringify([blockRule(1, "staticblocked")]) },
      ),
    );
    wireManager(m);
    await DNR.hydrate();
    await DNR.updateDynamicRules(id, { addRules: [blockRule(7, "dynsite")] });
    await DNR.updateEnabledRulesets(id, { enableRulesetIds: ["rs1"] });
    await DNR.flushForTests();
    /* The SW dies: memory is gone, the store survives. */
    DNR.resetForTests();
    wireManager(m);
    await DNR.hydrate();
    expect(DNR.getDynamicRules(id)).toEqual([blockRule(7, "dynsite")]);
    expect(await DNR.decideRequest(facts("https://dynsite.net/"))).toBe(true);
    expect(DNR.getEnabledRulesets(id)).toEqual({ rs1: { disabled: false } });
    expect(await DNR.decideRequest(facts("https://staticblocked.net/x"))).toBe(true);
    await DNR.updateDynamicRules(id, { removeRuleIds: [7] });
    await DNR.flushForTests();
  });

  it("corrupted store records are skipped, never trusted", async () => {
    await DNR.hydrate();
    const db = await openDb();
    await idbPut(db, STORE_DNR, "evil", [{ id: "nope", action: { type: "block" } }]);
    DNR.resetForTests();
    wireFake();
    await DNR.hydrate();
    expect(DNR.getDynamicRules("evil")).toEqual([]);
  });
});

describe("browser.declarativeNetRequest surface (#521)", () => {
  async function apiFor(name: string, permissions: string[]) {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(pkg(name, { permissions }));
    const rec = m.get(id)!;
    const storage = {
      local: new ExtensionStorageArea(id, "local", "local"),
      sync: new ExtensionStorageArea(id, "sync", "sync"),
      session: new ExtensionStorageArea(id, "session", "session"),
    };
    const api = buildApi(
      rec,
      { extensionId: id, context: "background", url: null },
      { messenger: new ExtensionMessenger(), storage, manager: m },
    );
    return { id, api, m };
  }

  it("mounts with the permission and honors the API shape", async () => {
    const { id, api, m } = await apiFor("DnrExt" + Math.random().toString(36).slice(2, 6), ["declarativeNetRequest"]);
    const ns = (api.browser as Record<string, unknown>).declarativeNetRequest as Record<string, unknown>;
    expect(ns).toBeTruthy();
    expect(ns.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES).toBe(5000);
    await (ns.updateDynamicRules as (u: unknown) => Promise<void>)({ addRules: [blockRule(1, "site")] });
    expect(await (ns.getDynamicRules as () => Promise<unknown[]>)()).toHaveLength(1);
    await (ns.updateSessionRules as (u: unknown) => Promise<void>)({ addRules: [blockRule(2, "site")] });
    expect(await (ns.getSessionRules as () => Promise<unknown[]>)()).toHaveLength(1);
    wireManager(m);
    expect(await DNR.decideRequest(facts("https://site.net/"))).toBe(true);
    /* chrome.* carries the same surface with callback support. */
    const chromeNs = (api.chrome as Record<string, unknown>).declarativeNetRequest as Record<string, unknown>;
    expect(chromeNs.updateSessionRules).toBeTruthy();
    expect(chromeNs.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES).toBe(5000);
  });

  it("stays absent without the permission (feature detection answers honestly)", async () => {
    const { api } = await apiFor("DnrNone" + Math.random().toString(36).slice(2, 6), ["storage"]);
    expect((api.browser as Record<string, unknown>).declarativeNetRequest).toBeUndefined();
    expect((api.chrome as Record<string, unknown>).declarativeNetRequest).toBeUndefined();
  });

  it("rejects through the API with the honest error", async () => {
    const { api } = await apiFor("DnrBad" + Math.random().toString(36).slice(2, 6), ["declarativeNetRequest"]);
    const ns = (api.browser as Record<string, unknown>).declarativeNetRequest as Record<string, unknown>;
    await expect(
      (ns.updateDynamicRules as (u: unknown) => Promise<void>)({
        addRules: [{ id: 1, condition: { urlFilter: "x" }, action: { type: "redirect", redirect: {} } }],
      }),
    ).rejects.toThrow(/no internal redirect re-entry seam/);
  });
});
