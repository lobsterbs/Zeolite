import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { WEBREQ, wrType, headersToPairs, pairsToHeaders } from "../webrequest";
import type { WrDetails, WrHeaderPair } from "../webrequest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";

const enc = new TextEncoder();

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

describe("WebRequestRegistry", () => {
  it("honors cancel only for blocking extensions", () => {
    WEBREQ.resetForTests();
    const offNb = WEBREQ.register("ext-nb", "beforeRequest", () => ({ cancel: true }), {
      hostPatterns: ["<all_urls>"],
      canBlock: false,
      urls: [],
    });
    expect(WEBREQ.beforeRequest(details())).toBe(false);
    const offB = WEBREQ.register("ext-b", "beforeRequest", () => ({ cancel: true }), {
      hostPatterns: ["<all_urls>"],
      canBlock: true,
      urls: [],
    });
    expect(WEBREQ.beforeRequest(details())).toBe(true);
    offB();
    expect(WEBREQ.beforeRequest(details())).toBe(false);
    offNb();
  });

  it("gates delivery on host permissions and listener url filters", () => {
    WEBREQ.resetForTests();
    const seen: string[] = [];
    const off = WEBREQ.register("ext-host", "beforeRequest", (d) => { seen.push(d.url); }, {
      hostPatterns: ["https://allowed.example/*"],
      canBlock: true,
      urls: ["*://allowed.example/*"],
    });
    WEBREQ.beforeRequest(details("https://allowed.example/a"));
    WEBREQ.beforeRequest(details("https://other.example/a"));
    expect(seen).toEqual(["https://allowed.example/a"]);
    off();
    WEBREQ.resetForTests();
  });

  it("beforeSendHeaders replaces headers with validated pairs", () => {
    WEBREQ.resetForTests();
    const off = WEBREQ.register("ext-h", "beforeSendHeaders", (d) => {
      expect(d.requestHeaders.length).toBeGreaterThan(0);
      return { requestHeaders: [{ name: "x-zl-test", value: "1" } as WrHeaderPair] };
    }, { hostPatterns: ["<all_urls>"], canBlock: true, urls: [] });
    const h = new Headers();
    h.set("accept", "text/html");
    const out = WEBREQ.beforeSendHeaders(details(), h);
    expect(out).not.toBeNull();
    expect(out!.get("x-zl-test")).toBe("1");
    expect(out!.get("accept")).toBeNull();
    off();
    WEBREQ.resetForTests();
  });

  it("headersReceived can modify response headers", () => {
    WEBREQ.resetForTests();
    const off = WEBREQ.register("ext-r", "headersReceived", (d) => {
      expect(d.statusCode).toBe(200);
      const pairs = d.responseHeaders.filter((p) => p.name !== "x-drop-me");
      return { responseHeaders: pairs };
    }, { hostPatterns: ["<all_urls>"], canBlock: true, urls: [] });
    const h = new Headers();
    h.set("content-type", "text/html");
    h.set("x-drop-me", "1");
    const out = WEBREQ.headersReceived(details(), 200, h);
    expect(out).not.toBeNull();
    expect(out!.get("x-drop-me")).toBeNull();
    expect(out!.get("content-type")).toBe("text/html");
    off();
    WEBREQ.resetForTests();
  });

  it("rejects invalid header pairs instead of coercing", () => {
    expect(pairsToHeaders([{ name: "", value: "x" }])).toBeNull();
    expect(pairsToHeaders([{ name: "a", value: 1 }])).toBeNull();
    expect(pairsToHeaders("nope")).toBeNull();
    const ok = pairsToHeaders([{ name: "a", value: "b" }]);
    expect(ok!.get("a")).toBe("b");
  });

  it("maps sec-fetch-dest honestly", () => {
    expect(wrType("document")).toBe("main_frame");
    expect(wrType("iframe")).toBe("sub_frame");
    expect(wrType("style")).toBe("stylesheet");
    expect(wrType("script")).toBe("script");
    expect(wrType("nonsense")).toBe("other");
  });

  it("round-trips Headers through pairs", () => {
    const h = new Headers();
    h.set("a", "1");
    h.set("b", "2");
    const pairs = headersToPairs(h);
    expect(pairs).toHaveLength(2);
    const back = pairsToHeaders(pairs);
    expect(back!.get("a")).toBe("1");
  });

  it("delivers completed and errorOccurred for observation", () => {
    WEBREQ.resetForTests();
    const done: number[] = [];
    const errs: string[] = [];
    const offC = WEBREQ.register("ext-c", "completed", (d) => { done.push(d.statusCode); }, {
      hostPatterns: ["<all_urls>"], canBlock: false, urls: [],
    });
    const offE = WEBREQ.register("ext-c", "errorOccurred", (d) => { errs.push(d.error); }, {
      hostPatterns: ["<all_urls>"], canBlock: false, urls: [],
    });
    WEBREQ.completed({ ...details(), statusCode: 200 });
    WEBREQ.errorOccurred({ ...details(), error: "boom" });
    expect(done).toEqual([200]);
    expect(errs).toEqual(["boom"]);
    offC();
    offE();
    WEBREQ.resetForTests();
  });
});

describe("browser.webRequest (buildApi)", () => {
  it("is absent without the permission and mounted with it", async () => {
    WEBREQ.resetForTests();
    const bare = await apiFor("WrBare", [], []);
    expect(bare.api.browser.webRequest).toBeUndefined();
    const withPerm = await apiFor("WrPerm", ["webRequest"], ["<all_urls>"]);
    const wr = withPerm.api.browser.webRequest as Record<string, unknown>;
    expect(wr.onBeforeRequest).toBeDefined();
    expect(wr.onCompleted).toBeDefined();
    WEBREQ.resetForTests();
  });

  it("blocking kinds require webRequestBlocking", async () => {
    WEBREQ.resetForTests();
    const p = await apiFor("WrNoBlock", ["webRequest"], ["<all_urls>"]);
    const wr = p.api.browser.webRequest as Record<
      string,
      { addListener: (l: (d: never) => unknown, f?: { urls?: string[] }) => void }
    >;
    expect(() => wr.onBeforeSendHeaders.addListener(() => undefined)).toThrow(/webRequestBlocking/);
    expect(() => wr.onHeadersReceived.addListener(() => undefined)).toThrow(/webRequestBlocking/);
    WEBREQ.resetForTests();
  });

  it("delivers engine hooks to registered listeners with url filters", async () => {
    WEBREQ.resetForTests();
    const p = await apiFor("WrLive", ["webRequest", "webRequestBlocking"], ["<all_urls>"]);
    const wr = p.api.browser.webRequest as Record<
      string,
      { addListener: (l: (d: Record<string, unknown>) => unknown, f?: { urls?: string[] }) => void; removeListener: (l: unknown) => void }
    >;
    const seen: string[] = [];
    const listener = (d: Record<string, unknown>) => { seen.push(String(d.url)); return undefined; };
    wr.onBeforeRequest.addListener(listener as never, { urls: ["https://filtered.example/*"] });
    WEBREQ.beforeRequest(details("https://filtered.example/a"));
    WEBREQ.beforeRequest(details("https://elsewhere.example/a"));
    expect(seen).toEqual(["https://filtered.example/a"]);
    wr.onBeforeRequest.removeListener(listener);
    WEBREQ.beforeRequest(details("https://filtered.example/a"));
    expect(seen).toHaveLength(1);
    WEBREQ.resetForTests();
  });
});
