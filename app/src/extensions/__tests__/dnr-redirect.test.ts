import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { DNR, validateRule } from "../dnr";

function facts(url: string, o: { method?: string; type?: string; initiator?: string } = {}) {
  return { url, method: o.method ?? "GET", type: o.type ?? "main_frame", initiator: o.initiator };
}

interface FakeExt {
  id: string;
  hosts: string[];
  withHostAccess: boolean;
  enabled: boolean;
}
let fakeExts: FakeExt[] = [];
function addExt(id: string, opts: Partial<FakeExt> = {}): FakeExt {
  const f: FakeExt = { id, hosts: [], withHostAccess: false, enabled: true, ...opts };
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
      staticRulesets: [],
    })),
  );
}

const redirectRule = (id: number, urlFilter: string, to: string, extra: Record<string, unknown> = {}) => ({
  id,
  priority: 1,
  condition: { urlFilter },
  action: { type: "redirect", redirect: { url: to } },
  ...extra,
});
const blockRule = (id: number, urlFilter: string, extra: Record<string, unknown> = {}) => ({
  id,
  priority: 1,
  condition: { urlFilter },
  action: { type: "block" },
  ...extra,
});

beforeEach(() => {
  fakeExts = [];
  DNR.resetForTests();
});

describe("declarativeNetRequest redirect validation (#521 slice 2)", () => {
  it("accepts an absolute http(s) redirect.url and keeps the raw rule", () => {
    const v = validateRule({ id: 1, condition: { urlFilter: "ads" }, action: { type: "redirect", redirect: { url: "https://clean.example/x" } } });
    expect(v.actionType).toBe("redirect");
    expect(v.redirectUrl).toBe("https://clean.example/x");
    expect((v.raw as { action: { redirect: { url: string } } }).action.redirect.url).toBe("https://clean.example/x");
  });

  it("rejects hostile redirect shapes", () => {
    expect(() => validateRule({ id: 1, action: { type: "redirect" } })).toThrow(/redirect object/);
    expect(() => validateRule({ id: 1, action: { type: "redirect", redirect: {} } })).toThrow(/\.url/);
    expect(() => validateRule({ id: 1, action: { type: "redirect", redirect: { url: "/relative" } } })).toThrow(/absolute/);
    expect(() => validateRule({ id: 1, action: { type: "redirect", redirect: { url: "javascript:alert(1)" } } })).toThrow(/http\(s\)/);
    expect(() => validateRule({ id: 1, action: { type: "redirect", redirect: { url: "https://x.test/", transform: { host: "y.test" } } } })).toThrow(/transform/);
    expect(() => validateRule({ id: 1, action: { type: "redirect", redirect: { url: "https://x.test/", regexSubstitution: "z" } } })).toThrow(/regexSubstitution/);
    expect(() => validateRule({ id: 1, action: { type: "upgradeScheme", redirect: { url: "https://x.test/" } } })).toThrow(
      /does not take a redirect/,
    );
  });
});

describe("declarativeNetRequest redirect verdicts (#521 slice 2)", () => {
  it("returns a redirect verdict and keeps the boolean hook block-only", async () => {
    addExt("e1");
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [redirectRule(1, "ads", "https://clean.example/x")] });
    const v = await DNR.decideRequestVerdict(facts("https://ads.example/x"));
    expect(v.kind).toBe("redirect");
    if (v.kind === "redirect") expect(v.url).toBe("https://clean.example/x");
    expect(await DNR.decideRequest(facts("https://ads.example/x"))).toBe(false);
    expect((await DNR.decideRequestVerdict(facts("https://clean.example/x"))).kind).toBe("none");
  });

  it("at equal priority block beats redirect inside one extension; a higher-priority redirect wins", async () => {
    addExt("e1");
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [redirectRule(1, "ads", "https://clean.example/x"), blockRule(2, "ads")] });
    expect((await DNR.decideRequestVerdict(facts("https://ads.example/x"))).kind).toBe("block");
    DNR.updateSessionRules("e1", { addRules: [redirectRule(3, "ads", "https://clean.example/x", { priority: 9 })] });
    expect((await DNR.decideRequestVerdict(facts("https://ads.example/x"))).kind).toBe("redirect");
  });

  it("a block from any extension beats a redirect from another", async () => {
    addExt("a");
    addExt("b");
    wireFake();
    DNR.updateSessionRules("a", { addRules: [redirectRule(1, "ads", "https://clean.example/x")] });
    DNR.updateSessionRules("b", { addRules: [blockRule(1, "ads")] });
    expect((await DNR.decideRequestVerdict(facts("https://ads.example/x"))).kind).toBe("block");
  });

  it("the first provider-order extension wins when two redirect", async () => {
    addExt("a");
    addExt("b");
    wireFake();
    DNR.updateSessionRules("a", { addRules: [redirectRule(1, "ads", "https://a-clean.example/x")] });
    DNR.updateSessionRules("b", { addRules: [redirectRule(1, "ads", "https://b-clean.example/x")] });
    const v = await DNR.decideRequestVerdict(facts("https://ads.example/x"));
    expect(v.kind).toBe("redirect");
    if (v.kind === "redirect") expect(v.url).toBe("https://a-clean.example/x");
  });

  it("withHostAccess gates a redirect on a host permission", async () => {
    addExt("e1", { withHostAccess: true });
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [redirectRule(1, "ads", "https://clean.example/x")] });
    expect((await DNR.decideRequestVerdict(facts("https://ads.example/x"))).kind).toBe("none");
    fakeExts[0]!.hosts = ["https://*.ads.example/*"];
    expect((await DNR.decideRequestVerdict(facts("https://ads.example/x"))).kind).toBe("redirect");
  });

  it("session beats dynamic at equal priority for equal-class redirects", async () => {
    addExt("e1");
    wireFake();
    await DNR.updateDynamicRules("e1", { addRules: [redirectRule(1, "ads", "https://dynamic.example/x")] });
    DNR.updateSessionRules("e1", { addRules: [redirectRule(1, "ads", "https://session.example/x")] });
    const v = await DNR.decideRequestVerdict(facts("https://ads.example/x"));
    expect(v.kind).toBe("redirect");
    if (v.kind === "redirect") expect(v.url).toBe("https://session.example/x");
  });

  it("a disabled extension enforces nothing", async () => {
    addExt("e1", { enabled: false });
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [redirectRule(1, "ads", "https://clean.example/x")] });
    expect((await DNR.decideRequestVerdict(facts("https://ads.example/x"))).kind).toBe("none");
  });
});
