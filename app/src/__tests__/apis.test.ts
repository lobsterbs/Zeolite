import { describe, expect, it, beforeEach } from "vitest";
import type { ExtensionRecord } from "../extensions/types";
import { buildApi } from "../extensions/runtime";
import {
  detachApiModule,
  isApiDetached,
  reattachApiModule,
  resetApiModules,
} from "../extensions/apis";
import { cookiesRemove, cookiesSet, onCookieChanged } from "../extensions/cookies";
import { ExtensionStorageArea } from "../extensions/storage";
import { MESSENGER } from "../extensions/context";

/* LB #76 modularity: the optional API modules detach (and reattach)
   and the built browser surface answers honestly; cookies.onChanged
   fires for extension-driven set and remove. */

const mkExt = (permissions: string[]): ExtensionRecord =>
  ({
    id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    name: "test-ext",
    version: "1.0",
    manifestVersion: 3,
    manifest: { name: "test-ext", version: "1.0" },
    geckoId: null,
    permissions,
    hostPermissions: ["<all_urls>"],
    optionalPermissions: [],
    contentScripts: [],
    background: null,
    action: null,
    options: null,
    icons: {},
    webAccessibleResources: [],
    webAccessibleScoped: [],
    externallyConnectable: null,
    commands: {},
    contentSecurityPolicy: null,
    sidebarAction: null,
    state: "running",
    enabled: true,
    installTime: Date.now(),
    lastError: null,
    unsupportedFields: [],
    warnings: [],
  }) as ExtensionRecord;

const EXT_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const mkDeps = () => ({
  messenger: MESSENGER,
  storage: {
    local: new ExtensionStorageArea(EXT_ID, "local", "local"),
    sync: new ExtensionStorageArea(EXT_ID, "sync", "sync"),
    session: new ExtensionStorageArea(EXT_ID, "session", "session"),
  },
});

beforeEach(() => resetApiModules());

describe("optional API module detachment (LB #76)", () => {
  it("mounts permission-gated namespaces while attached", () => {
    const { browser } = buildApi(mkExt(["cookies", "storage"]), { extensionId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", context: "background", url: "https://w.example.org/" }, mkDeps());
    expect(browser.cookies).toBeTruthy();
    expect(browser.storage).toBeTruthy();
    expect(browser.runtime).toBeTruthy();
  });

  it("detached modules disappear from the surface", () => {
    detachApiModule("cookies");
    const { browser } = buildApi(mkExt(["cookies"]), { extensionId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", context: "background", url: "https://w.example.org/" }, mkDeps());
    expect(browser.cookies).toBeUndefined();
    expect(isApiDetached("cookies")).toBe(true);
    reattachApiModule("cookies");
    const again = buildApi(mkExt(["cookies"]), { extensionId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", context: "background", url: "https://w.example.org/" }, mkDeps());
    expect(again.browser.cookies).toBeTruthy();
  });
});

describe("cookies.onChanged (LB #76)", () => {
  it("fires for extension-driven set and remove", async () => {
    const changes: unknown[] = [];
    const ext = mkExt(["cookies"]);
    const off = onCookieChanged(ext, (c) => changes.push(c));
    const set = await cookiesSet(ext, { url: "http://changed.example/a", name: "k", value: "v" });
    expect(set && (set as Record<string, unknown>).value).toBe("v");
    const removed = await cookiesRemove(ext, { url: "http://changed.example/a", name: "k" });
    expect(removed).toBeTruthy();
    off();
    expect(changes.length).toBeGreaterThanOrEqual(2);
    const first = changes[0] as { removed: boolean; cookie: { name: string } };
    expect(first.cookie.name).toBe("k");
    expect(first.removed).toBe(false);
    const last = changes[changes.length - 1] as { removed: boolean };
    expect(last.removed).toBe(true);
  });
});