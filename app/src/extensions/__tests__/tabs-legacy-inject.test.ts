import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { SCRIPTING, type ScriptingMessage } from "../scripting";
import { TABS } from "../tabs";

const enc = new TextEncoder();

/* #519: tabs.executeScript/insertCSS - Firefox's MV2 legacy leg of
   the scripting engine. The semantics pinned here come from Firefox's
   own schema and ext-tabs-base.js: no "scripting" permission (the
   tab's host grant is the boundary), code|file in Firefox's order,
   the results value is the per-frame results array with injected-unit
   errors REJECTING the promise (MDN), the members exist only for MV2
   records (the schema's max_manifest_version is 2), and an omitted
   tabId defaults to the active tab of the single window. */

interface Captured {
  msg: ScriptingMessage;
  port: MessagePort | null;
}

const capturedDispatch: Captured[] = [];

function pkg(name: string, manifestVersion: number, permissions: string[]): Map<string, Uint8Array> {
  return new Map([
    [
      "manifest.json",
      enc.encode(
        JSON.stringify(
          manifestVersion === 2
            ? { manifest_version: 2, name, version: "1.0", permissions }
            : { manifest_version: 3, name, version: "1.0", permissions: permissions.filter((p) => !p.includes(":")), host_permissions: permissions.filter((p) => p.includes(":")) },
        ),
      ),
    ],
    ["inject.js", enc.encode("1 + 1;")],
  ]);
}

async function apiFor(name: string, permissions = ["*://target.example/*"], manifestVersion = 2) {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, manifestVersion, permissions));
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(
    rec,
    { extensionId: id, id, context: "background", url: null },
    { messenger: new ExtensionMessenger(), storage },
  );
  return { id, api };
}

function captureDispatch(): void {
  SCRIPTING.setDispatch((msg, port) => {
    capturedDispatch.push({ msg, port });
  });
}

afterEach(() => {
  SCRIPTING.setDispatch(null);
  capturedDispatch.length = 0;
  TABS.syncFromUi([]);
  vi.useRealTimers();
});

function seedTabs(): void {
  TABS.syncFromUi([
    { id: 9, index: 0, url: "https://target.example/inactive", title: "t9", active: false },
    { id: 10, index: 1, url: "https://target.example/active", title: "t10", active: true },
  ]);
}

type TabsApi = {
  tabs: {
    executeScript: (a: unknown, b?: unknown) => Promise<unknown[]>;
    insertCSS: (a: unknown, b?: unknown) => Promise<void>;
  };
};

describe("tabs.executeScript (#519 MV2 legacy leg)", () => {
  it("runs code over the page channel and resolves Firefox's per-frame results array", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyCode");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    const p = tabs.executeScript(10, { code: "40 + 2;" });
    expect(capturedDispatch).toHaveLength(1);
    const { msg, port } = capturedDispatch[0];
    expect(msg.wantResult).toBe(true);
    expect(msg.js).toEqual(["40 + 2;"]);
    expect(msg.css).toEqual([]);
    expect(msg.dest).toBe("https://target.example/active");
    port!.postMessage({ results: [{ result: 42 }] });
    await expect(p).resolves.toEqual([42]);
  });

  it("defaults to the active tab when tabId is omitted", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyDefault");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    const p = tabs.executeScript({ code: "1;" });
    expect(capturedDispatch).toHaveLength(1);
    expect(capturedDispatch[0].msg.dest).toBe("https://target.example/active");
    capturedDispatch[0].port!.postMessage({ results: [{ result: 1 }] });
    await expect(p).resolves.toEqual([1]);
  });

  it("honors the (details, callback) form while the promise still resolves", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyCallback");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    let delivered: unknown = "not-called";
    const p = tabs.executeScript({ code: "7 * 6;" }, (v: unknown) => {
      delivered = v;
    });
    capturedDispatch[0].port!.postMessage({ results: [{ result: 42 }] });
    await p;
    await vi.waitFor(() => {
      if (delivered === "not-called") throw new Error("callback not delivered");
    });
    expect(delivered).toEqual([42]);
  });

  it("needs no scripting permission (Firefox's host-grant-only rule) and reads package files", async () => {
    seedTabs();
    captureDispatch();
    /* The fixture manifest carries ONLY the host grant - a scripting
       record would reject, the legacy member must not (#519). */
    const { api } = await apiFor("LegacyFile");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    const p = tabs.executeScript(9, { file: "/inject.js" });
    await vi.waitFor(() => {
      if (capturedDispatch.length !== 1) throw new Error("dispatch not captured yet");
    });
    expect(capturedDispatch[0].msg.js).toEqual(["1 + 1;"]);
    capturedDispatch[0].port!.postMessage({ results: [{ result: 2 }] });
    await expect(p).resolves.toEqual([2]);
  });

  it("keeps Firefox's code-then-file order across both sources", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyBoth");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    const p = tabs.executeScript(10, { code: "1;", file: "/inject.js" });
    await vi.waitFor(() => {
      if (capturedDispatch.length !== 1) throw new Error("dispatch not captured yet");
    });
    expect(capturedDispatch[0].msg.js).toEqual(["1;", "1 + 1;"]);
    capturedDispatch[0].port!.postMessage({ results: [{ result: 1 }, { result: 2 }] });
    await expect(p).resolves.toEqual([1, 2]);
  });

  it("rejects injected-unit errors as a rejected promise (MDN), frame targeting, allFrames, bad runAt, and neither-code-nor-file", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyRejects");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    const p = tabs.executeScript(10, { code: "boom();" });
    capturedDispatch[0].port!.postMessage({ results: [{ error: "ReferenceError: boom is not defined" }] });
    await expect(p).rejects.toThrow(/boom is not defined/);
    await expect(tabs.executeScript(10, { code: "1;", frameId: 7 })).rejects.toThrow(/main frame only/);
    await expect(tabs.executeScript(10, { code: "1;", allFrames: true })).rejects.toThrow(/main frame only/);
    await expect(tabs.executeScript(10, { code: "1;", runAt: "whenever" })).rejects.toThrow(/runAt/);
    await expect(tabs.executeScript(10, {})).rejects.toThrow(/requires code or file/);
    /* Nothing but the first (already-answered) call reached the page. */
    expect(capturedDispatch).toHaveLength(1);
  });

  it("rejects without a host grant for the target tab", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyNoGrant", []);
    const tabs = (api.browser as unknown as TabsApi).tabs;
    await expect(tabs.executeScript(10, { code: "1;" })).rejects.toThrow(/host permission/);
    expect(capturedDispatch).toHaveLength(0);
  });

  it("rejects honestly when no active tab exists", async () => {
    captureDispatch();
    const { api } = await apiFor("LegacyNoTab");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    await expect(tabs.executeScript({ code: "1;" })).rejects.toThrow(/tabId/);
  });

  it("MV3 records do not mount the MV2 members (Firefox's max_manifest_version gate)", async () => {
    const { api } = await apiFor("LegacyMV3", ["*://target.example/*"], 3);
    const tabs = api.browser.tabs as Record<string, unknown>;
    expect(tabs.executeScript).toBeUndefined();
    expect(tabs.insertCSS).toBeUndefined();
  });
});

describe("tabs.insertCSS (#519 MV2 legacy leg)", () => {
  it("sends code over the channel and resolves undefined", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyCss");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    await expect(tabs.insertCSS(10, { code: "body { color: red; }" })).resolves.toBeUndefined();
    expect(capturedDispatch).toHaveLength(1);
    expect(capturedDispatch[0].msg.css).toEqual(["body { color: red; }"]);
    expect(capturedDispatch[0].msg.js).toEqual([]);
    expect(capturedDispatch[0].msg.wantResult).toBe(false);
  });

  it("reads package files like scripting.insertCSS", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyCssFile");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    await expect(tabs.insertCSS(10, { file: "/inject.js" })).resolves.toBeUndefined();
    await vi.waitFor(() => {
      if (capturedDispatch.length !== 1) throw new Error("dispatch not captured yet");
    });
    expect(capturedDispatch[0].msg.css).toEqual(["1 + 1;"]);
  });

  it("accepts the author origin (the default) and rejects the user origin honestly", async () => {
    seedTabs();
    captureDispatch();
    const { api } = await apiFor("LegacyCssOrigin");
    const tabs = (api.browser as unknown as TabsApi).tabs;
    await expect(tabs.insertCSS(10, { code: "a{}", cssOrigin: "author" })).resolves.toBeUndefined();
    await expect(tabs.insertCSS(10, { code: "a{}", cssOrigin: "user" })).rejects.toThrow(/author styles only/);
    await expect(tabs.insertCSS(10, { cssOrigin: "author" })).rejects.toThrow(/requires code or file/);
  });
});
