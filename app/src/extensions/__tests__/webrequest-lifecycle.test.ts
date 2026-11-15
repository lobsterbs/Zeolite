import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { WEBREQ } from "../webrequest";
import type { WrDetails, WrRedirectDetails, WrResponseStartedDetails, WrSendDetails } from "../webrequest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

/* Register options helper: live permission view (#282). */
function opts(hostPatterns: string[], canBlock = false, urls: string[] = []) {
  return { perm: () => ({ hostPatterns, canBlock }), urls };
}

function pkg(
  name: string,
  permissions: string[],
  hostPermissions: string[],
): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions,
    host_permissions: hostPermissions,
    background: { scripts: ["bg.js"] },
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
    ["bg.js", enc.encode("// bg")],
  ]);
}

async function apiFor(name: string, permissions: string[], hostPermissions: string[]) {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(pkg(name, permissions, hostPermissions));
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(rec, { extensionId: id, context: "background", url: null }, { messenger: new ExtensionMessenger(), storage });
  return { id, api };
}

function details(url = "https://example.com/x"): WrDetails {
  return { requestId: "r1", url, method: "GET", type: "main_frame", timeStamp: Date.now() };
}

describe("WebRequestRegistry observe lifecycle (#521)", () => {
  it("sendHeaders delivers the final pair list, one fresh copy per listener", () => {
    WEBREQ.resetForTests();
    const seen: WrSendDetails[] = [];
    const off1 = WEBREQ.register("e1", "sendHeaders", (d: WrSendDetails) => {
      /* Snapshot BEFORE the mutation: the registry must hand each
         listener its own fresh pair list (#272 contract). */
      seen.push({ ...d, requestHeaders: [...d.requestHeaders] });
      d.requestHeaders.length = 0;
    }, opts(["<all_urls>"]));
    const off2 = WEBREQ.register("e2", "sendHeaders", (d: WrSendDetails) => seen.push(d), opts(["<all_urls>"]));
    const h = new Headers({ accept: "text/html", "x-a": "1" });
    WEBREQ.sendHeaders(details(), h);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.requestHeaders.map((p) => p.name).sort()).toEqual(["accept", "x-a"]);
    }
    off1();
    off2();
    WEBREQ.resetForTests();
  });

  it("beforeRedirect reports the 3xx hop, the redirect target and the status", () => {
    WEBREQ.resetForTests();
    const seen: WrRedirectDetails[] = [];
    const off = WEBREQ.register("e1", "beforeRedirect", (d: WrRedirectDetails) => seen.push(d), opts(["<all_urls>"]));
    WEBREQ.beforeRedirect(details("https://a.example/x"), "https://b.example/y", 301);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://a.example/x");
    expect(seen[0]!.redirectUrl).toBe("https://b.example/y");
    expect(seen[0]!.statusCode).toBe(301);
    /* Unregister stops delivery. */
    off();
    WEBREQ.beforeRedirect(details(), "https://b.example/y", 301);
    expect(seen).toHaveLength(1);
    WEBREQ.resetForTests();
  });

  it("responseStarted reports the upstream status once", () => {
    WEBREQ.resetForTests();
    const seen: number[] = [];
    const off = WEBREQ.register("e1", "responseStarted", (d: WrResponseStartedDetails) => seen.push(d.statusCode), opts(["<all_urls>"]));
    WEBREQ.responseStarted(details(), 200);
    expect(seen).toEqual([200]);
    off();
    WEBREQ.responseStarted(details(), 200);
    expect(seen).toEqual([200]);
    WEBREQ.resetForTests();
  });

  it("gates the observe kinds on host permissions and url filters", () => {
    WEBREQ.resetForTests();
    const seen: string[] = [];
    const off = WEBREQ.register("e1", "beforeRedirect", (d: WrRedirectDetails) => seen.push(d.url),
      opts(["https://allowed.example/*"], false, ["*://allowed.example/*"]));
    WEBREQ.beforeRedirect(details("https://allowed.example/a"), "https://allowed.example/b", 302);
    WEBREQ.beforeRedirect(details("https://other.example/a"), "https://other.example/b", 302);
    expect(seen).toEqual(["https://allowed.example/a"]);
    off();
    WEBREQ.resetForTests();
  });

  it("a broken observe listener does not break delivery to the others", () => {
    WEBREQ.resetForTests();
    const seen: string[] = [];
    WEBREQ.register("e-bad", "sendHeaders", () => {
      throw new Error("listener bug");
    }, opts(["<all_urls>"]));
    const off = WEBREQ.register("e-ok", "sendHeaders", (d: WrSendDetails) => seen.push(d.url), opts(["<all_urls>"]));
    WEBREQ.sendHeaders(details(), new Headers());
    expect(seen).toEqual(["https://example.com/x"]);
    off();
    WEBREQ.resetForTests();
  });
});

type WrEvent = {
  addListener: (l: unknown, filter?: { urls?: unknown }, extraInfoSpec?: unknown) => void;
  removeListener: (l: unknown) => void;
  hasListener: (l: unknown) => boolean;
};
type WrSurface = {
  onBeforeRequest: WrEvent;
  onSendHeaders: WrEvent;
  onBeforeRedirect: WrEvent;
  onResponseStarted: WrEvent;
  MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: number;
  handlerBehaviorChanged: () => Promise<void>;
};

describe("webRequest surface: observe events, extraInfoSpec, handlerBehaviorChanged (#521)", () => {
  it("mounts the new observe events and registers listeners", async () => {
    const { api } = await apiFor("obs", ["webRequest"], ["<all_urls>"]);
    const wr = api.browser.webRequest as unknown as WrSurface;
    expect(typeof wr.onSendHeaders.addListener).toBe("function");
    expect(typeof wr.onBeforeRedirect.addListener).toBe("function");
    expect(typeof wr.onResponseStarted.addListener).toBe("function");
    const l = () => {};
    wr.onBeforeRedirect.addListener(l);
    expect(wr.onBeforeRedirect.hasListener(l)).toBe(true);
    wr.onBeforeRedirect.removeListener(l);
    expect(wr.onBeforeRedirect.hasListener(l)).toBe(false);
  });

  it("validates extraInfoSpec at addListener, Firefox-style", async () => {
    const { api } = await apiFor("spec", ["webRequest"], ["<all_urls>"]);
    const wr = api.browser.webRequest as unknown as WrSurface;
    const l = () => {};
    /* Not an array: refuses, never coerces. */
    expect(() => wr.onBeforeRequest.addListener(l, undefined, "blocking")).toThrow(/array of strings/);
    /* Unknown spec string: refuses. */
    expect(() => wr.onBeforeRequest.addListener(l, undefined, ["nonsense"])).toThrow(/unknown extraInfoSpec 'nonsense'/);
    /* The known set registers silently and is recorded per listener. */
    wr.onBeforeRequest.addListener(l, undefined, ["blocking", "requestHeaders"]);
    expect(wr.onBeforeRequest.hasListener(l)).toBe(true);
    wr.onBeforeRequest.removeListener(l);
  });

  it("handlerBehaviorChanged resolves and enforces the Firefox 10-minute cap", async () => {
    const { api } = await apiFor("hbc", ["webRequest"], ["<all_urls>"]);
    const wr = api.browser.webRequest as unknown as WrSurface;
    expect(wr.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES).toBe(20);
    await expect(wr.handlerBehaviorChanged()).resolves.toBeUndefined();
    for (let i = 0; i < 19; i++) await wr.handlerBehaviorChanged();
    await expect(wr.handlerBehaviorChanged()).rejects.toThrow(
      /MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES/,
    );
  });
});
