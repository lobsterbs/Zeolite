/* #516: docs/firefox-api-gaps.md is generated from firefoxGapReport()
   over the real mounted surface and held fresh by this test. Run with
   ZL_UPDATE_GAPS_DOC=1 to regenerate the committed document (from
   app/); without the flag the test compares and fails on drift. */
import "fake-indexeddb/auto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { buildInventory } from "../inventory";
import { firefoxGapReport } from "../firefox-inventory";
import { renderGapsDoc } from "../gaps-doc";

const DOC_URL = new URL("../../../../docs/firefox-api-gaps.md", import.meta.url);

const enc = new TextEncoder();

const ALL_NS_PERMISSIONS = [
  "storage", "tabs", "notifications", "contextMenus", "downloads", "cookies",
  "webRequest", "webRequestBlocking", "webNavigation", "alarms", "management",
  "browsingData", "declarativeNetRequest", "bookmarks",
  "history", "topSites",
];

/** The full mountable surface: the action family mounts one namespace
    per manifest kind, so the union of three fixtures is complete. */
async function mountedBrowser(): Promise<Record<string, unknown>> {
  const fixtures: Array<Record<string, unknown>> = [
    { manifest_version: 3, action: {} },
    { manifest_version: 2, browser_action: {} },
    { manifest_version: 2, page_action: {} },
  ];
  const m = new ExtensionManager();
  await m.startup();
  const browser: Record<string, unknown> = {};
  for (const extra of fixtures) {
    const { id } = await m.installFiles(
      new Map([
        ["manifest.json", enc.encode(JSON.stringify({ manifest_version: extra.manifest_version, name: "Gaps" + Math.random().toString(36).slice(2, 7), version: "1.0", permissions: ALL_NS_PERMISSIONS, ...extra }))],
      ]),
    );
    const rec = m.get(id)!;
    const storage = {
      local: new ExtensionStorageArea(id, "local", "local"),
      sync: new ExtensionStorageArea(id, "sync", "sync"),
      session: new ExtensionStorageArea(id, "session", "session"),
    };
    const api = buildApi(
      rec,
      { extensionId: id, context: "background", url: null } as never,
      { messenger: new ExtensionMessenger(), storage, manager: m },
    );
    Object.assign(browser, api.browser as Record<string, unknown>);
  }
  return browser;
}

describe("firefox-api-gaps.md staleness (#516)", () => {
  it("the committed document matches the rendered gap report", async () => {
    const browser = await mountedBrowser();
    const report = firefoxGapReport(browser);
    const rendered = renderGapsDoc(report, buildInventory(browser));
    /* The app tsconfig has no node types; the regen flag arrives
       through the environment the same way vitest itself reads it. */
    const update = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ZL_UPDATE_GAPS_DOC;
    if (update === "1") {
      writeFileSync(DOC_URL, rendered);
      console.log(`wrote ${DOC_URL.pathname} (${rendered.length} bytes)`);
      return;
    }
    expect(existsSync(DOC_URL), "docs/firefox-api-gaps.md exists").toBe(true);
    const committed = readFileSync(DOC_URL, "utf-8");
    expect(committed).toBe(rendered);
  });
});
