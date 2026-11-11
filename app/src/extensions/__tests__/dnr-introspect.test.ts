import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { DNR, type DnrMatchedRule } from "../dnr";

function facts(url: string, o: { method?: string; type?: string } = {}) {
  return { url, method: o.method ?? "GET", type: o.type ?? "main_frame" };
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

const blockRule = (id: number, urlFilter: string) => ({
  id,
  priority: 1,
  condition: { urlFilter },
  action: { type: "block" },
});
const redirectRule = (id: number, urlFilter: string, to: string) => ({
  id,
  priority: 1,
  condition: { urlFilter },
  action: { type: "redirect", redirect: { url: to } },
});

beforeEach(() => {
  fakeExts = [];
  DNR.resetForTests();
});

describe("declarativeNetRequest introspection (#521)", () => {
  it("onRuleMatchedDebug fires with the full record on a block", async () => {
    addExt("e1");
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [blockRule(7, "ads")] });
    const seen: DnrMatchedRule[] = [];
    DNR.onRuleMatchedDebug.addListener((m) => seen.push(m));
    await DNR.decideRequestVerdict(facts("https://ads.example/x", { method: "POST", type: "sub_frame" }));
    expect(seen.length).toBe(1);
    expect(seen[0]!.ruleId).toBe(7);
    expect(seen[0]!.extensionId).toBe("e1");
    expect(seen[0]!.rulesetId).toBe("_session");
    expect(seen[0]!.source).toBe("session");
    expect(seen[0]!.kind).toBe("block");
    expect(seen[0]!.url).toBe("https://ads.example/x");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.type).toBe("sub_frame");
    expect(typeof seen[0]!.timestamp).toBe("number");
  });

  it("a redirect record carries the redirect target and _dynamic source", async () => {
    addExt("e1");
    wireFake();
    await DNR.updateDynamicRules("e1", { addRules: [redirectRule(3, "ads", "https://clean.example/x")] });
    const seen: DnrMatchedRule[] = [];
    DNR.onRuleMatchedDebug.addListener((m) => seen.push(m));
    await DNR.decideRequestVerdict(facts("https://ads.example/x"));
    expect(seen.length).toBe(1);
    expect(seen[0]!.kind).toBe("redirect");
    expect(seen[0]!.redirectUrl).toBe("https://clean.example/x");
    expect(seen[0]!.rulesetId).toBe("_dynamic");
    expect(seen[0]!.source).toBe("dynamic");
  });

  it("getMatchedRules returns the log oldest-first, bounded to 500", async () => {
    addExt("e1");
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [blockRule(1, "ads")] });
    for (let i = 0; i < 505; i++) {
      await DNR.decideRequestVerdict(facts("https://ads.example/" + i));
    }
    const log = await DNR.getMatchedRules();
    expect(log.length).toBe(500);
    expect(log[0]!.url).toBe("https://ads.example/5");
    expect(log[499]!.url).toBe("https://ads.example/504");
  });

  it("a broken listener never affects the verdict; removeListener stops delivery", async () => {
    addExt("e1");
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [blockRule(1, "ads")] });
    const boom = (): void => {
      throw new Error("boom");
    };
    DNR.onRuleMatchedDebug.addListener(boom);
    expect(await DNR.decideRequestVerdict(facts("https://ads.example/x"))).toEqual({ kind: "block" });
    DNR.onRuleMatchedDebug.removeListener(boom);
    expect(DNR.onRuleMatchedDebug.hasListener(boom)).toBe(false);
    const seen: DnrMatchedRule[] = [];
    DNR.onRuleMatchedDebug.addListener((m) => seen.push(m));
    await DNR.decideRequestVerdict(facts("https://ads.example/y"));
    expect(seen.length).toBe(1);
  });

  it("a disabled extension records nothing; resetForTests clears the log", async () => {
    addExt("e1", { enabled: false });
    wireFake();
    DNR.updateSessionRules("e1", { addRules: [blockRule(1, "ads")] });
    await DNR.decideRequestVerdict(facts("https://ads.example/x"));
    expect((await DNR.getMatchedRules()).length).toBe(0);
    fakeExts[0]!.enabled = true;
    await DNR.decideRequestVerdict(facts("https://ads.example/x"));
    expect((await DNR.getMatchedRules()).length).toBe(1);
    DNR.resetForTests();
    expect((await DNR.getMatchedRules()).length).toBe(0);
  });
});
