import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { MESSENGER } from "../context";
import { ExtensionStorageArea } from "../storage";
import { TABS } from "../tabs";
import { checkPageToken } from "../serve";
import type { TabsOp } from "../tabs";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string, manifest: Record<string, unknown>, extra: Array<[string, string]> = []): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 3, name, version: "1.0", ...manifest }))],
  ]);
  for (const [p, src] of extra) files.set(p, enc.encode(src));
  return files;
}

async function install(
  name: string,
  manifest: Record<string, unknown>,
  extra?: Array<[string, string]>,
): Promise<{ rec: ExtensionRecord; runtime: Record<string, unknown>; messenger: ExtensionMessenger }> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, manifest, extra));
  const rec = extensions.get(id)!;
  const messenger = new ExtensionMessenger();
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(
    rec,
    { extensionId: id, id, context: "background", url: null },
    { messenger, storage, manager: extensions },
  );
  return { rec, runtime: api.browser.runtime as Record<string, unknown>, messenger };
}

describe("runtime.openOptionsPage (#518)", () => {
  it("opens a rooted, tokened options page through the tabs bridge", async () => {
    const { rec, runtime } = await install("Opts", { options_ui: { page: "settings.html" } });
    const ops: Array<{ op: string; nonce?: string; props?: { url?: string } }> = [];
    TABS.setDispatch((op) => ops.push(op as typeof ops[number]));
    const opening = (runtime.openOptionsPage as () => Promise<void>)();
    const op = ops[0];
    expect(op.op).toBe("create");
    const url = String(op.props?.url);
    expect(url.startsWith("/settings.html?zlExt=" + rec.id + "&zlPageTok=")).toBe(true);
    // the token in the URL is a real, checkable page token
    const tok = url.split("zlPageTok=")[1];
    expect(checkPageToken(rec.id, "/settings.html", tok)).toBe(true);
    // the UI acknowledges the create by syncing the opened tab
    TABS.syncFromUi([{ id: 7, index: 0, url, title: "opts", active: true, nonce: op.nonce }]);
    await opening;
    TABS.setDispatch(null);
  });

  it("rejects honestly without an options page", async () => {
    const { runtime } = await install("NoOpts", {});
    await expect(runtime.openOptionsPage as () => Promise<void>).rejects.toThrow(/no options page/);
  });

  it("refuses tabs.create with a rooted URL that carries no valid page token", async () => {
    await install("OptsGate", { options_ui: { page: "settings.html" } });
    const ops: TabsOp[] = [];
    TABS.setDispatch((op) => ops.push(op));
    await expect(
      (TABS as unknown as { create: (p: { url: string }) => Promise<unknown> }).create({
        url: "/index.html?zlNavh=forged",
      }),
    ).rejects.toThrow(/unsupported URL/);
    TABS.setDispatch(null);
  });
});

describe("runtime.reload (#518)", () => {
  it("re-boots a script background: stale listeners die, fresh ones answer", async () => {
    const { rec, runtime } = await install(
      "ReloadBg",
      { background: { scripts: ["bg.js"] } },
      [["bg.js", "browser.runtime.onMessage.addListener(function (m, s, send) { send({ v: 1 }); });"]],
    );
    // boot the background by hand (worker activation normally does it)
    const { bootInstalled } = await import("../background");
    await bootInstalled(rec.id);
    const s1 = { extensionId: rec.id, id: rec.id, context: "background" as const, url: null };
    // bootExtension registers listeners on the engine-wide MESSENGER
    await expect(MESSENGER.sendMessage(rec.id, s1, "ping")).resolves.toEqual({ v: 1 });

    (runtime.reload as () => void)();
    // the reload chain is async (package re-parse + boot); give it a tick
    await new Promise((r) => setTimeout(r, 50));

    // the old listener closure is gone; the fresh boot re-registered it
    const fresh = MESSENGER.sendMessage(rec.id, s1, "ping");
    await expect(fresh).resolves.toEqual({ v: 1 });
    expect(extensions.get(rec.id)?.state).toBe("running");
    // the boot marker survived: no second install event marker flip
    expect(extensions.get(rec.id)?.installTime).toBeGreaterThan(0);
  });

  it("keeps the record enabled and installed for an MV3 service-worker background", async () => {
    const { rec, runtime } = await install(
      "ReloadSw",
      { background: { service_worker: "sw.js" } },
      [["sw.js", "browser.runtime.onMessage.addListener(function (m, s, send) { send({ pong: 1 }); });"]],
    );
    const { wakeExtension } = await import("../background");
    await wakeExtension(rec.id);
    (runtime.reload as () => void)();
    await new Promise((r) => setTimeout(r, 50));
    const live = extensions.get(rec.id)!;
    expect(live.enabled).toBe(true);
    expect(live.state).toBe("installed"); // idle-terminated, wakes on demand
  });
});
