import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensions } from "../manager";
import { DEVTOOLS, registerDevtoolsClient, devtoolsBindingOf, devtoolsTabOf } from "../devtools";
import type { DevtoolsOp } from "../devtools";
import { extPageOpenUrl, pageTokenDevtoolsTab } from "../serve";
import { pageCallList } from "../pageapi";
import { SCRIPTING } from "../scripting";
import type { ScriptingMessage } from "../scripting";
import { TABS } from "../tabs";
import type { UiTab } from "../tabs";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

/* The manager refuses a duplicate install, and the singleton lives
   across tests in this file: every install gets a unique name. */
let seq = 0;

function pkg(manifest: Record<string, unknown>): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["devtools.html", enc.encode("<!doctype html><title>dt</title>")],
    ["panel.html", enc.encode("<!doctype html><title>panel</title>")],
  ]);
}

async function installDevtoolsExt(): Promise<ExtensionRecord> {
  await extensions.startup();
  const { id } = await extensions.installFiles(
    pkg({
      manifest_version: 3,
      name: "DtExt " + (++seq),
      version: "1.0",
      devtools_page: "devtools.html",
      permissions: ["scripting"],
      host_permissions: ["*://*.example.com/*"],
    }),
  );
  return extensions.get(id)!;
}

afterEach(() => {
  SCRIPTING.setDispatch(null);
  DEVTOOLS.setDispatch(null);
  vi.restoreAllMocks();
});

describe("#523 devtools", () => {
  it("parses devtools_page and opens it bound to the inspected tab", async () => {
    const rec = await installDevtoolsExt();
    expect(rec.devtoolsPage).toBe("devtools.html");
    const url = extPageOpenUrl(rec, "devtools", 3);
    expect(url).not.toBeNull();
    expect(url!.startsWith("/devtools.html?zlExt=" + rec.id + "&zlPageTok=")).toBe(true);
    const tok = url!.split("zlPageTok=")[1];
    expect(pageTokenDevtoolsTab(rec.id, "/devtools.html", tok)).toBe(3);
    expect(pageTokenDevtoolsTab(rec.id, "/other.html", tok)).toBeNull();
    expect(pageTokenDevtoolsTab("other-ext", "/devtools.html", tok)).toBeNull();
    /* Without a tab id there is no devtools open. */
    expect(extPageOpenUrl(rec, "devtools")).toBeNull();
    /* An extension without devtools_page has no devtools open. */
    const { id: plainId } = await extensions.installFiles(
      pkg({ manifest_version: 3, name: "PlainDtExt " + (++seq), version: "1.0" }),
    );
    expect(extPageOpenUrl(extensions.get(plainId)!, "devtools", 1)).toBeNull();
  });

  it("binds a devtools client and refuses calls from other clients", async () => {
    const rec = await installDevtoolsExt();
    expect(devtoolsTabOf("c1")).toBeNull();
    registerDevtoolsClient("c1", rec.id, 3);
    expect(devtoolsTabOf("c1")).toBe(3);
    expect(devtoolsBindingOf("c1")!.extId).toBe(rec.id);
    registerDevtoolsClient(undefined, rec.id, 4);
    expect(devtoolsTabOf(undefined)).toBeNull();
    const refused = await DEVTOOLS.handleDevtoolsCall(rec, "c2", ["devtools", "inspectedWindow", "eval"], ["1"]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("devtools page");
    /* A client bound to another extension gets nothing. */
    const { id: otherId } = await extensions.installFiles(
      pkg({
        manifest_version: 3,
        name: "OtherDtExt " + (++seq),
        version: "1.0",
        devtools_page: "devtools.html",
        permissions: ["scripting"],
        host_permissions: ["*://*.example.com/*"],
      }),
    );
    registerDevtoolsClient("c9", otherId, 5);
    const foreign = await DEVTOOLS.handleDevtoolsCall(rec, "c9", ["devtools", "inspectedWindow", "eval"], ["1"]);
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain("devtools page");
  });

  it("eval rides the scripting channel with its permission boundary", async () => {
    const rec = await installDevtoolsExt();
    registerDevtoolsClient("c1", rec.id, 3);
    vi.spyOn(TABS, "get").mockReturnValue({ id: 3, url: "https://x.example.com/page" } as unknown as UiTab);
    let sent: ScriptingMessage | null = null;
    SCRIPTING.setDispatch((msg, reply) => {
      sent = msg;
      reply!.postMessage({ results: [{ result: msg.func ? 7 : 2, frameId: 0 }] });
    });
    const r = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "inspectedWindow", "eval"], ["1+1"]);
    expect(r.ok).toBe(true);
    expect(r.response).toBe(2);
    expect((sent as ScriptingMessage | null)!.dest).toBe("https://x.example.com/page");
    expect((sent as ScriptingMessage | null)!.js).toEqual(["1+1"]);
    expect((sent as ScriptingMessage | null)!.wantResult).toBe(true);
    /* evalInFunction evaluates the expression AS a function. */
    const rf = await DEVTOOLS.handleDevtoolsCall(
      rec,
      "c1",
      ["devtools", "inspectedWindow", "eval"],
      ["(function () { return 7; })", { evalInFunction: true }],
    );
    expect(rf.ok).toBe(true);
    expect(rf.response).toBe(7);
    expect((sent as ScriptingMessage | null)!.func).toBe("(function () { return 7; })");
    /* A page exception rejects with Firefox's Exception: text. */
    SCRIPTING.setDispatch((_msg, reply) => {
      reply!.postMessage({ results: [{ error: "boom", frameId: 0 }] });
    });
    const re = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "inspectedWindow", "eval"], ["throw 1"]);
    expect(re.ok).toBe(false);
    expect(re.error).toBe("Exception: boom");
  });

  it("eval requires the scripting permission and a host permission", async () => {
    const rec = await installDevtoolsExt();
    registerDevtoolsClient("c1", rec.id, 3);
    /* No scripting permission. */
    const { id: noScriptId } = await extensions.installFiles(
      pkg({
        manifest_version: 3,
        name: "NoScriptDtExt " + (++seq),
        version: "1.0",
        devtools_page: "devtools.html",
        host_permissions: ["*://*.example.com/*"],
      }),
    );
    const noScript = extensions.get(noScriptId)!;
    registerDevtoolsClient("c2", noScriptId, 3);
    vi.spyOn(TABS, "get").mockReturnValue({ id: 3, url: "https://x.example.com/page" } as unknown as UiTab);
    const r1 = await DEVTOOLS.handleDevtoolsCall(noScript, "c2", ["devtools", "inspectedWindow", "eval"], ["1"]);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("scripting");
    /* Host permission for the inspected tab. */
    vi.spyOn(TABS, "get").mockReturnValue({ id: 3, url: "https://blocked.example/page" } as unknown as UiTab);
    const r2 = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "inspectedWindow", "eval"], ["1"]);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("host permission");
  });

  it("reload re-navigates the inspected tab through the tabs bridge", async () => {
    const rec = await installDevtoolsExt();
    registerDevtoolsClient("c1", rec.id, 3);
    vi.spyOn(TABS, "get").mockReturnValue({ id: 3, url: "https://x.example.com/p" } as unknown as UiTab);
    const upd = vi.spyOn(TABS, "update").mockResolvedValue(undefined);
    const r = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "inspectedWindow", "reload"], [{ ignoreCache: true }]);
    expect(r.ok).toBe(true);
    expect(upd).toHaveBeenCalledWith(3, { url: "https://x.example.com/p" });
    /* An unbound client cannot reload anything. */
    const bad = await DEVTOOLS.handleDevtoolsCall(rec, "cX", ["devtools", "inspectedWindow", "reload"], []);
    expect(bad.ok).toBe(false);
  });

  it("panels.create registers, hands off, and returns the identity", async () => {
    const rec = await installDevtoolsExt();
    registerDevtoolsClient("c1", rec.id, 3);
    const ops: DevtoolsOp[] = [];
    DEVTOOLS.setDispatch((op) => ops.push(op));
    const r = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "panels", "create"], ["My Panel", "icon.png", "panel.html"]);
    expect(r.ok).toBe(true);
    const panel = r.response as { id: string; title: string };
    expect(panel.title).toBe("My Panel");
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("createPanel");
    expect(ops[0].extId).toBe(rec.id);
    expect(ops[0].tabId).toBe(3);
    expect(ops[0].panelId).toBe(panel.id);
    expect(ops[0].title).toBe("My Panel");
    expect(ops[0].iconPath).toBe("icon.png");
    expect(ops[0].pagePath).toBe("panel.html");
    const bad1 = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "panels", "create"], ["", "i", "p.html"]);
    expect(bad1.ok).toBe(false);
    const bad2 = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "panels", "create"], ["t", "i", ""]);
    expect(bad2.ok).toBe(false);
    const bad3 = await DEVTOOLS.handleDevtoolsCall(rec, "cX", ["devtools", "panels", "create"], ["t", "i", "p.html"]);
    expect(bad3.ok).toBe(false);
    /* Unknown devtools paths refuse honestly. */
    const unk = await DEVTOOLS.handleDevtoolsCall(rec, "c1", ["devtools", "network", "onRequestFinished"], []);
    expect(unk.ok).toBe(false);
  });

  it("the devtools call list mounts only for a devtools page client", async () => {
    const rec = await installDevtoolsExt();
    const plain = pageCallList(rec);
    expect(plain).not.toContain("devtools.inspectedWindow.eval");
    expect(plain).not.toContain("devtools.panels.create");
    const dt = pageCallList(rec, true);
    expect(dt).toContain("devtools.inspectedWindow.eval");
    expect(dt).toContain("devtools.inspectedWindow.reload");
    expect(dt).toContain("devtools.panels.create");
  });
});
