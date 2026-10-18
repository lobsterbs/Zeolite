import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { WEBREQ, wrType, headersToPairs, pairsToHeaders } from "../webrequest";
import type {
  WrCompletedDetails,
  WrDetails,
  WrErrorDetails,
  WrHeaderPair,
  WrReceiveDetails,
  WrSendDetails,
} from "../webrequest";
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

describe("WebRequestRegistry", () => {
  it("honors cancel only for blocking extensions", () => {
    WEBREQ.resetForTests();
    const offNb = WEBREQ.register("ext-nb", "beforeRequest", () => ({ cancel: true }), opts(["<all_urls>"], false));
    expect(WEBREQ.beforeRequest(details())).toBe(false);
    const offB = WEBREQ.register("ext-b", "beforeRequest", () => ({ cancel: true }), opts(["<all_urls>"], true));
    expect(WEBREQ.beforeRequest(details())).toBe(true);
    offB();
    expect(WEBREQ.beforeRequest(details())).toBe(false);
    offNb();
  });

  it("gates delivery on host permissions and listener url filters", () => {
    WEBREQ.resetForTests();
    const seen: string[] = [];
    const off = WEBREQ.register("ext-host", "beforeRequest", (d: WrDetails) => { seen.push(d.url); },
      opts(["https://allowed.example/*"], true, ["*://allowed.example/*"]));
    WEBREQ.beforeRequest(details("https://allowed.example/a"));
    WEBREQ.beforeRequest(details("https://other.example/a"));
    expect(seen).toEqual(["https://allowed.example/a"]);
    off();
    WEBREQ.resetForTests();
  });

  it("beforeSendHeaders replaces headers with validated pairs", () => {
    WEBREQ.resetForTests();
    const off = WEBREQ.register("ext-h", "beforeSendHeaders", (d: WrSendDetails) => {
      expect(d.requestHeaders.length).toBeGreaterThan(0);
      return { requestHeaders: [{ name: "x-zl-test", value: "1" } as WrHeaderPair] };
    }, opts(["<all_urls>"], true));
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
    const off = WEBREQ.register("ext-r", "headersReceived", (d: WrReceiveDetails) => {
      expect(d.statusCode).toBe(200);
      const pairs = d.responseHeaders.filter((p) => p.name !== "x-drop-me");
      return { responseHeaders: pairs };
    }, opts(["<all_urls>"], true));
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
    const offC = WEBREQ.register("ext-c", "completed", (d: WrCompletedDetails) => { done.push(d.statusCode); }, opts(["<all_urls>"]));
    const offE = WEBREQ.register("ext-c", "errorOccurred", (d: WrErrorDetails) => { errs.push(d.error); }, opts(["<all_urls>"]));
    WEBREQ.completed({ ...details(), statusCode: 200 });
    WEBREQ.errorOccurred({ ...details(), error: "boom" });
    expect(done).toEqual([200]);
    expect(errs).toEqual(["boom"]);
    offC();
    offE();
    WEBREQ.resetForTests();
  });
});

/* #272: one listener mutating shared details must not affect others. */
describe("webRequest listener isolation (#272)", () => {
  it("beforeRequest gives each listener its own details copy", () => {
    WEBREQ.resetForTests();
    const seen: (WrDetails | null)[] = [];
    const off1 = WEBREQ.register("ext-1", "beforeRequest", (d: WrDetails) => {
      (d as Record<string, unknown>).url = "https://mutated.example/";
      seen.push(d);
      return undefined;
    }, opts(["<all_urls>"], true));
    const off2 = WEBREQ.register("ext-2", "beforeRequest", (d: WrDetails) => {
      seen.push(d);
      return undefined;
    }, opts(["<all_urls>"], true));
    const r = WEBREQ.beforeRequest(details("https://original.example/a"));
    expect(r).toBe(false); /* neither cancelled */
    expect(seen[0]!.url).toBe("https://mutated.example/");
    expect(seen[1]!.url).toBe("https://original.example/a");
    off1(); off2();
    WEBREQ.resetForTests();
  });

  it("completed and errorOccurred deliver copies", () => {
    WEBREQ.resetForTests();
    const got: WrCompletedDetails[] = [];
    const errs: WrErrorDetails[] = [];
    let first = true;
    const off1 = WEBREQ.register("ext-1", "completed", (d: WrCompletedDetails) => {
      if (first) { (d as Record<string, unknown>).url = "https://mutated.example/"; first = false; }
      got.push(d);
    }, opts(["<all_urls>"]));
    const off2 = WEBREQ.register("ext-2", "completed", (d: WrCompletedDetails) => { got.push(d); }, opts(["<all_urls>"]));
    const offE = WEBREQ.register("ext-2", "errorOccurred", (d: WrErrorDetails) => { (d as Record<string, unknown>).error = "clobbered"; errs.push(d); }, opts(["<all_urls>"]));
    WEBREQ.completed({ ...details(), statusCode: 200 });
    WEBREQ.errorOccurred({ ...details(), error: "boom" });
    expect(got[0].url).toBe("https://mutated.example/");
    expect(got[1].url).toBe("https://example.com/x");
    /* errorOccurred has a single listener; the engine's own detail
       object must survive the listener's mutation. */
    WEBREQ.errorOccurred({ ...details(), error: "boom2" });
    expect(errs[1].error).toBe("boom2");
    off1(); off2(); offE();
    WEBREQ.resetForTests();
  });
});

/* #282: permissions are re-read at delivery, not snapshot at registration. */
describe("webRequest live permissions (#282)", () => {
  it("revoking host permissions stops delivery and blocking", () => {
    WEBREQ.resetForTests();
    const hosts = ["<all_urls>"];
    const seen: string[] = [];
    const off = WEBREQ.register("ext-r", "beforeRequest", (d: WrDetails) => {
      seen.push(d.url);
      return { cancel: true };
    }, opts(hosts, true));
    expect(WEBREQ.beforeRequest(details("https://a.example/"))).toBe(true);
    expect(seen).toHaveLength(1);
    /* Advanced-permissions backend mutates the array in place. */
    hosts.length = 0;
    hosts.push("https://other.example/*");
    expect(WEBREQ.beforeRequest(details("https://a.example/"))).toBe(false);
    expect(seen).toHaveLength(1);
    /* canBlock flip: cancel result must be ignored when blocking was
       revoked even on a permitted host. */
    hosts.length = 0;
    hosts.push("<all_urls>");
    const off2 = WEBREQ.register("ext-r", "beforeRequest", () => ({ cancel: true }), {
      perm: () => ({ hostPatterns: ["<all_urls>"], canBlock: false }),
      urls: [],
    });
    expect(WEBREQ.beforeRequest(details("https://a.example/"))).toBe(false);
    off2();
    off();
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
