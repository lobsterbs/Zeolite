import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { WEBREQ } from "../webrequest";
import type { WrDetails, WrHeaderPair, WrReceiveDetails, WrRedirectDetails, WrResponseStartedDetails, WrSendDetails } from "../webrequest";
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
      seen.push({ ...d, requestHeaders: [...(d.requestHeaders ?? [])] });
      d.requestHeaders!.length = 0;
    }, opts(["<all_urls>"]));
    const off2 = WEBREQ.register("e2", "sendHeaders", (d: WrSendDetails) => seen.push(d), opts(["<all_urls>"]));
    const h = new Headers({ accept: "text/html", "x-a": "1" });
    WEBREQ.sendHeaders(details(), h);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.requestHeaders!.map((p) => p.name).sort()).toEqual(["accept", "x-a"]);
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
  onHeadersReceived: WrEvent;
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

/* #521 slice 2: per-listener extraInfoSpec enforcement. Legacy no-spec
   registrations keep the MV2 blanket model (capability follows the
   webRequestBlocking permission); a spec'd listener gets Firefox's
   per-listener opt-in semantics instead. */
describe("#521 slice 2: per-listener extraInfoSpec enforcement", () => {
  const optsSpec = (hostPatterns: string[], canBlock: boolean, spec?: string[], urls: string[] = []) =>
    ({ perm: () => ({ hostPatterns, canBlock }), urls, spec });

  it("a spec'd onBeforeRequest listener cannot cancel without the 'blocking' opt-in", () => {
    WEBREQ.resetForTests();
    /* ['requestHeaders'] only, even with webRequestBlocking: observe-only. */
    const offR = WEBREQ.register("e-rh", "beforeRequest", () => ({ cancel: true }), optsSpec(["<all_urls>"], true, ["requestHeaders"]));
    expect(WEBREQ.beforeRequest(details())).toBe(false);
    offR();
    /* With 'blocking' the same shape cancels. */
    const offB = WEBREQ.register("e-blk", "beforeRequest", () => ({ cancel: true }), optsSpec(["<all_urls>"], true, ["blocking", "requestHeaders"]));
    expect(WEBREQ.beforeRequest(details())).toBe(true);
    offB();
    /* Legacy no-spec listener: MV2 blanket model unchanged. */
    const offL = WEBREQ.register("e-leg", "beforeRequest", () => ({ cancel: true }), optsSpec(["<all_urls>"], true));
    expect(WEBREQ.beforeRequest(details())).toBe(true);
    offL();
    WEBREQ.resetForTests();
  });

  it("spec'd beforeSendHeaders: 'requestHeaders' delivers observe-only, 'blocking' may replace", () => {
    WEBREQ.resetForTests();
    const h = new Headers({ accept: "text/html" });
    const seen: string[] = [];
    /* ['requestHeaders'] only, canBlock: delivered WITH the field,
       its replacement ignored — the originals go out untouched. */
    const offO = WEBREQ.register("e-obs", "beforeSendHeaders", (d: WrSendDetails) => {
      seen.push((d.requestHeaders ?? []).map((p) => p.name).join(","));
      return { requestHeaders: [{ name: "x-zl-hack", value: "1" } as WrHeaderPair] };
    }, optsSpec(["<all_urls>"], true, ["requestHeaders"]));
    expect(WEBREQ.beforeSendHeaders(details(), h)).toBeNull();
    expect(seen).toEqual(["accept"]);
    expect(h.get("x-zl-hack")).toBeNull();
    offO();
    seen.length = 0;
    /* ['blocking'] only: may replace, but sees NO requestHeaders
       field (Firefox omits it without the "requestHeaders" opt-in). */
    const offB = WEBREQ.register("e-blk", "beforeSendHeaders", (d: WrSendDetails) => {
      seen.push("requestHeaders" in d ? "field" : "nofield");
      return { requestHeaders: [{ name: "x-zl-test", value: "1" } as WrHeaderPair] };
    }, optsSpec(["<all_urls>"], true, ["blocking"]));
    const out = WEBREQ.beforeSendHeaders(details(), h);
    expect(seen).toEqual(["nofield"]);
    expect(out!.get("x-zl-test")).toBe("1");
    offB();
    seen.length = 0;
    /* Legacy no-spec on a NON-blocking extension: not delivered at
       all (unchanged from the pre-spec model). */
    const offL = WEBREQ.register("e-leg", "beforeSendHeaders", () => { seen.push("delivered"); }, optsSpec(["<all_urls>"], false));
    expect(WEBREQ.beforeSendHeaders(details(), h)).toBeNull();
    expect(seen).toEqual([]);
    offL();
    /* Spec'd observe-only on a NON-blocking extension: delivered,
       mutation still ignored (the permission is the gate the spec
       cannot lift). */
    const offN = WEBREQ.register("e-nb", "beforeSendHeaders", (d: WrSendDetails) => {
      seen.push("delivered:" + ((d.requestHeaders ?? []).length > 0));
      return { requestHeaders: [{ name: "x-zl-hack", value: "1" } as WrHeaderPair] };
    }, optsSpec(["<all_urls>"], false, ["requestHeaders"]));
    expect(WEBREQ.beforeSendHeaders(details(), h)).toBeNull();
    expect(seen).toEqual(["delivered:true"]);
    expect(h.get("x-zl-hack")).toBeNull();
    offN();
    WEBREQ.resetForTests();
  });

  it("headersReceived mirrors the model: spec'd observe-only delivery, legacy silence", () => {
    WEBREQ.resetForTests();
    const h = new Headers({ "content-type": "text/html" });
    const seen: string[] = [];
    /* Legacy non-blocking: silent (the pipeline test pins this
       end-to-end too). */
    const offL = WEBREQ.register("e-leg", "headersReceived", () => { seen.push("legacy"); }, optsSpec(["<all_urls>"], false));
    /* Spec'd ['responseHeaders'] non-blocking: delivered observe-only. */
    const offO = WEBREQ.register("e-obs", "headersReceived", (d: WrReceiveDetails) => {
      seen.push("obs:" + (d.responseHeaders ?? []).map((p) => p.name).join(","));
      return { responseHeaders: [{ name: "x-zl-hack", value: "1" } as WrHeaderPair] };
    }, optsSpec(["<all_urls>"], false, ["responseHeaders"]));
    expect(WEBREQ.headersReceived(details(), 200, h)).toBeNull();
    expect(seen).toEqual(["obs:content-type"]);
    expect(h.get("x-zl-hack")).toBeNull();
    offL();
    offO();
    /* Blocking spec + permission: replacement honored. */
    const offB = WEBREQ.register("e-blk", "headersReceived", () => (
      { responseHeaders: [{ name: "x-zl-test", value: "1" } as WrHeaderPair] }
    ), optsSpec(["<all_urls>"], true, ["blocking", "responseHeaders"]));
    const out = WEBREQ.headersReceived(details(), 200, h);
    expect(out!.get("x-zl-test")).toBe("1");
    offB();
    WEBREQ.resetForTests();
  });

  it("beforeRedirect carries the 3xx response headers only with the 'responseHeaders' spec", () => {
    WEBREQ.resetForTests();
    const seen: Array<Record<string, unknown>> = [];
    const offY = WEBREQ.register("e-y", "beforeRedirect", (d: WrRedirectDetails) => {
      seen.push({ has: "responseHeaders" in d, first: d.responseHeaders?.[0]?.name });
    }, optsSpec(["<all_urls>"], false, ["responseHeaders"]));
    const offN = WEBREQ.register("e-n", "beforeRedirect", (d: WrRedirectDetails) => {
      seen.push({ has: "responseHeaders" in d });
    }, optsSpec(["<all_urls>"], false, ["blocking"]));
    const h = new Headers({ location: "https://b.example/y" });
    WEBREQ.beforeRedirect(details(), "https://b.example/y", 301, h);
    expect(seen).toEqual([
      { has: true, first: "location" },
      { has: false },
    ]);
    offY();
    offN();
    WEBREQ.resetForTests();
  });

  it("sendHeaders omits requestHeaders for a spec'd listener without 'requestHeaders'", () => {
    WEBREQ.resetForTests();
    const seen: boolean[] = [];
    const offB = WEBREQ.register("e-b", "sendHeaders", (d: WrSendDetails) => seen.push("requestHeaders" in d), optsSpec(["<all_urls>"], false, ["blocking"]));
    const offL = WEBREQ.register("e-l", "sendHeaders", (d: WrSendDetails) => seen.push("requestHeaders" in d), optsSpec(["<all_urls>"], false));
    WEBREQ.sendHeaders(details(), new Headers({ accept: "text/html" }));
    expect(seen).toEqual([false, true]);
    offB();
    offL();
    WEBREQ.resetForTests();
  });

  it("surface: observe-only registration on header events without webRequestBlocking", async () => {
    const { api } = await apiFor("obsonly", ["webRequest"], ["<all_urls>"]);
    const wr = api.browser.webRequest as unknown as WrSurface;
    const l = () => {};
    /* Legacy no-spec registration still throws. */
    expect(() => wr.onHeadersReceived.addListener(l)).toThrow(/webRequestBlocking/);
    /* A blocking spec still throws without the permission: the spec
       cannot grant a capability the manifest does not carry. */
    expect(() => wr.onHeadersReceived.addListener(l, undefined, ["blocking"])).toThrow(/webRequestBlocking/);
    /* An observe-only spec registers without the permission. */
    wr.onHeadersReceived.addListener(l, undefined, ["responseHeaders"]);
    expect(wr.onHeadersReceived.hasListener(l)).toBe(true);
    wr.onHeadersReceived.removeListener(l);
    expect(wr.onHeadersReceived.hasListener(l)).toBe(false);
  });
});
