import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { DNR, validateRule } from "../dnr";
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

const rule = (id: number, type: string, urlFilter: string, extra: Record<string, unknown> = {}) => ({
  id,
  priority: 1,
  condition: { urlFilter, ...extra },
  action: { type },
});

function pkg(name: string, extra: Record<string, unknown>): Map<string, Uint8Array> {
  return new Map([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", ...extra }))],
  ]);
}

beforeEach(() => {
  fakeExts = [];
  DNR.resetForTests();
  wireFake();
});

afterEach(() => {
  vi.useRealTimers();
  DNR.resetForTests();
});

describe("declarativeNetRequest upgradeScheme (#521 slice 3)", () => {
  it("an http request gets a redirect verdict to the https form, path and query preserved", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "upgradeScheme", "http://")] });
    const v = await DNR.decideRequestVerdict(facts("http://site.net/p?q=1"));
    expect(v).toEqual({ kind: "redirect", url: "https://site.net/p?q=1" });
  });

  it("ws upgrades to wss", async () => {
    addExt("a");
    await DNR.updateSessionRules("a", { addRules: [rule(1, "upgradeScheme", "")] });
    const v = await DNR.decideRequestVerdict(facts("ws://site.net/sock", { type: "websocket" }));
    expect(v).toEqual({ kind: "redirect", url: "wss://site.net/sock" });
  });

  it("an already-https request gets no effect", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "upgradeScheme", "")] });
    expect(await DNR.decideRequestVerdict(facts("https://site.net/"))).toEqual({ kind: "none" });
  });

  it("withHostAccess gates the upgrade on a host permission", async () => {
    addExt("a", { withHostAccess: true });
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "upgradeScheme", "")] });
    expect(await DNR.decideRequestVerdict(facts("http://site.net/"))).toEqual({ kind: "none" });
    addExt("b", { withHostAccess: true, hosts: ["*://site.net/*"] });
    await DNR.updateDynamicRules("b", { addRules: [rule(1, "upgradeScheme", "")] });
    expect(await DNR.decideRequestVerdict(facts("http://site.net/"))).toEqual({
      kind: "redirect",
      url: "https://site.net/",
    });
  });

  it("at equal priority upgradeScheme beats redirect inside one extension", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", {
      addRules: [
        rule(1, "upgradeScheme", ""),
        { id: 2, priority: 1, condition: {}, action: { type: "redirect", redirect: { url: "http://other.net/" } } },
      ],
    });
    const v = await DNR.decideRequestVerdict(facts("http://site.net/"));
    expect(v).toEqual({ kind: "redirect", url: "https://site.net/" });
  });

  it("a block from another extension beats the upgrade", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "upgradeScheme", "")] });
    addExt("b");
    await DNR.updateDynamicRules("b", { addRules: [rule(1, "block", "site.net")] });
    expect(await DNR.decideRequestVerdict(facts("http://site.net/"))).toEqual({ kind: "block" });
  });
});

describe("declarativeNetRequest allowAllRequests (#521 slice 3)", () => {
  it("a main_frame match arms the bypass: the owning extension's block stops applying to its subresources", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", {
      addRules: [rule(1, "allowAllRequests", "site.net"), rule(2, "block", "cdn.evil")],
    });
    expect(await DNR.decideRequestVerdict(facts("https://site.net/"))).toEqual({ kind: "none" });
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/x.js", { type: "script", initiator: "https://site.net/" })),
    ).toEqual({ kind: "none" });
  });

  it("another extension's block still applies inside the bypassed frame", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "allowAllRequests", "site.net")] });
    addExt("b");
    await DNR.updateDynamicRules("b", { addRules: [rule(1, "block", "cdn.evil")] });
    expect(await DNR.decideRequestVerdict(facts("https://site.net/"))).toEqual({ kind: "none" });
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/x.js", { type: "script", initiator: "https://site.net/" })),
    ).toEqual({ kind: "block" });
  });

  it("a higher-priority rule of the owning extension still applies", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", {
      addRules: [
        rule(1, "allowAllRequests", "site.net"),
        { id: 2, priority: 2, condition: { urlFilter: "cdn.evil" }, action: { type: "block" } },
      ],
    });
    expect(await DNR.decideRequestVerdict(facts("https://site.net/"))).toEqual({ kind: "none" });
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/x.js", { type: "script", initiator: "https://site.net/" })),
    ).toEqual({ kind: "block" });
  });

  it("a sub_frame generated from the bypassed document joins the subtree", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", {
      addRules: [rule(1, "allowAllRequests", "site.net"), rule(2, "block", "cdn.evil")],
    });
    expect(await DNR.decideRequestVerdict(facts("https://site.net/"))).toEqual({ kind: "none" });
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/frame.html", { type: "sub_frame", initiator: "https://site.net/" })),
    ).toEqual({ kind: "none" });
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/x.js", { type: "script", initiator: "https://cdn.evil/" })),
    ).toEqual({ kind: "none" });
  });

  it("the bypass expires after the TTL", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "allowAllRequests", "site.net"), rule(2, "block", "cdn.evil")] });
    expect(await DNR.decideRequestVerdict(facts("https://site.net/"))).toEqual({ kind: "none" });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/x.js", { type: "script", initiator: "https://site.net/" })),
    ).toEqual({ kind: "block" });
  });

  it("the bypass registry is bounded (drop-oldest)", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "allowAllRequests", "arm"), rule(2, "block", "first")] });
    for (let i = 0; i < 257; i++) {
      await DNR.decideRequestVerdict(facts("https://arm" + i + ".net/"));
    }
    /* the first origin was dropped: its subresource is blocked again */
    expect(
      await DNR.decideRequestVerdict(facts("https://first.net/x.js", { type: "script", initiator: "https://arm0.net/" })),
    ).toEqual({ kind: "block" });
  });

  it("on other resource types it arms nothing", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", {
      addRules: [rule(1, "allowAllRequests", "site.net"), rule(2, "block", "cdn.evil")],
    });
    expect(
      await DNR.decideRequestVerdict(facts("https://site.net/pic.png", { type: "image", initiator: "https://site.net/" })),
    ).toEqual({ kind: "none" });
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/x.js", { type: "script", initiator: "https://site.net/" })),
    ).toEqual({ kind: "block" });
  });

  it("drop clears the bypass (a re-installed extension starts clean)", async () => {
    addExt("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "allowAllRequests", "site.net"), rule(2, "block", "cdn.evil")] });
    expect(await DNR.decideRequestVerdict(facts("https://site.net/"))).toEqual({ kind: "none" });
    await DNR.drop("a");
    await DNR.updateDynamicRules("a", { addRules: [rule(1, "allowAllRequests", "site.net"), rule(2, "block", "cdn.evil")] });
    expect(
      await DNR.decideRequestVerdict(facts("https://cdn.evil/x.js", { type: "script", initiator: "https://site.net/" })),
    ).toEqual({ kind: "block" });
  });
});

describe("declarativeNetRequestFeedback debug surface (#521 slice 3)", () => {
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

  it("mounts getMatchedRules and onRuleMatchedDebug with the feedback permission", async () => {
    const { api, m } = await apiFor("DnrFb" + Math.random().toString(36).slice(2, 6), [
      "declarativeNetRequest",
      "declarativeNetRequestFeedback",
    ]);
    const ns = (api.browser as Record<string, unknown>).declarativeNetRequest as Record<string, unknown>;
    expect(typeof ns.getMatchedRules).toBe("function");
    const seen: unknown[] = [];
    (ns.onRuleMatchedDebug as { addListener: (l: (m: unknown) => void) => void }).addListener((m2) => seen.push(m2));
    wireManager(m);
    await (ns.updateDynamicRules as (u: unknown) => Promise<void>)({
      addRules: [{ id: 1, condition: { urlFilter: "blocked.net" }, action: { type: "block" } }],
    });
    await DNR.decideRequestVerdict(facts("https://blocked.net/"));
    expect(seen.length).toBe(1);
    expect(Array.isArray(await (ns.getMatchedRules as () => Promise<unknown[]>)())).toBe(true);
    expect(await (ns.getMatchedRules as () => Promise<unknown[]>)()).toHaveLength(1);
  });

  it("stays absent without the feedback permission", async () => {
    const { api } = await apiFor("DnrNoFb" + Math.random().toString(36).slice(2, 6), ["declarativeNetRequest"]);
    const ns = (api.browser as Record<string, unknown>).declarativeNetRequest as Record<string, unknown>;
    expect(ns.getMatchedRules).toBeUndefined();
    expect(ns.onRuleMatchedDebug).toBeUndefined();
    expect(ns.updateDynamicRules).toBeTruthy();
  });
});
