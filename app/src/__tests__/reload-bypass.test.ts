import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* zl:reloadBypass (#211, LobsterBrowse): the embedder's
   Reload-and-bypass-cache arms a one-shot page-cache bypass consumed
   by the next DOCUMENT GET. A subresource GET never consumes it, an
   armed document fetch skips the page-cache lookup entirely, and the
   flag never survives the document fetch. */

const transportMock = vi.hoisted(() => ({ calls: 0, urls: [] as string[] }));
const cacheMock = vi.hoisted(() => ({ lookups: [] as string[] }));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { dispatchCore, type ControlMessage } from "../control";
import { b64uEncode, buildQueryHandleUrl, setRouteKey, setScheme } from "../codec";
import { reloadBypassArmed, setQueryRoutes, setReloadBypass } from "../swstate";

const ORIGIN = "https://engine.example";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

const mkEvent = (routeUrl: string, mode: string, destination: string) => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "GET",
      mode,
      destination,
      credentials: "same-origin",
      referrer: "",
      body: null,
      headers: new Headers(),
    },
    clientId: "c-1",
    resultingClientId: "c-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const mkReplies = () => {
  const replies: unknown[] = [];
  return { replies, reply: (payload: unknown) => replies.push(payload) };
};
const mkMsgEvent = (sourceUrl: string, msg: ControlMessage) =>
  ({
    data: msg,
    ports: [{ postMessage: () => {}, close: () => {} }],
    source: { url: sourceUrl, id: "c1" },
  }) as unknown as ExtendableMessageEvent;
const ctx = (ev: ExtendableMessageEvent, reply: (p: unknown) => void) => ({
  e: ev,
  reply,
  port: { postMessage: () => {}, close: () => {} },
  persistRoute: async () => {},
});

beforeEach(async () => {
  await routeReady;
  setScheme("/j/");
  setRouteKey(KEY);
  setQueryRoutes(true);
  setReloadBypass(false);
  transportMock.calls = 0;
  transportMock.urls = [];
  cacheMock.lookups = [];
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (req: Request) => {
        cacheMock.lookups.push(req.url);
        return null;
      },
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("zl:reloadBypass (#211, LB)", () => {
  it("arms on the control message", async () => {
    expect(reloadBypassArmed()).toBe(false);
    const r = mkReplies();
    await dispatchCore(
      { type: "zl:reloadBypass" } as unknown as ControlMessage,
      ctx(mkMsgEvent(ORIGIN + "/", { type: "zl:reloadBypass" } as unknown as ControlMessage), r.reply),
    );
    expect((r.replies[0] as { ok: boolean }).ok).toBe(true);
    expect(reloadBypassArmed()).toBe(true);
  });

  it("a document GET consumes the armed bypass and skips the cache; a subresource GET does neither", async () => {
    const route = ORIGIN + (buildQueryHandleUrl("https://s.example/p?q=1") as string);
    setReloadBypass(true);
    /* armed + subresource: cache-first still runs, the flag survives */
    const sub = mkEvent(route, "no-cors", "script");
    handleFetch(sub.ev);
    await sub.armed[0]!;
    const afterSub = cacheMock.lookups.length;
    expect(afterSub).toBeGreaterThan(0);
    expect(reloadBypassArmed()).toBe(true);
    /* armed + document: no cache lookup, the flag is consumed */
    const doc = mkEvent(route, "navigate", "document");
    handleFetch(doc.ev);
    await doc.armed[0]!;
    expect(cacheMock.lookups.length).toBe(afterSub);
    expect(reloadBypassArmed()).toBe(false);
    /* disarmed + document: cache-first is back */
    const doc2 = mkEvent(route, "navigate", "document");
    handleFetch(doc2.ev);
    await doc2.armed[0]!;
    expect(cacheMock.lookups.length).toBeGreaterThan(afterSub);
  });
});
