import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/* #416 slice 1: the shell navigation lockdown. A hijacked top-level
   navigation is the one request shape whose committed URL the host UI
   itself owns, and the fetch spec exposes the hijack precisely: the
   initiator (clientId) is the nested pane while the window being
   replaced (replacesClientId) is the shell. These tests pin both call
   sites of the recapture (the foreign branch for cross-origin
   targets, the engine path right before the disabled-site gate for
   decoded routes) and every fail-closed exclusion. The transport
   mock, self and caches stubs mirror request.test.ts: the vendored
   libcurl bundle never loads under vitest and these tests pin
   classification, not transport. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  gate: undefined as undefined | Promise<void>,
  urls: [] as string[],
  queue: [] as Response[],
  inits: [] as Array<{ method?: string; headers?: Headers; body?: unknown } | undefined>,
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init?: { method?: string; headers?: Headers; body?: unknown }) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      transportMock.inits.push(init ? { method: init.method, headers: new Headers(init.headers), body: init.body } : undefined);
      if (transportMock.gate) await transportMock.gate;
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { b64uEncode, buildQueryHandleUrl, setRouteKey, setScheme } from "../codec";

describe("shell escape recapture (#416 slice 1)", () => {
  const ORIGIN = "https://shell.example";
  const KEY = b64uEncode(Uint8Array.from({ length: 16 }, (_, i) => i));
  /* The parked-page shape of the MSAL/AAD authorize hijack: the
     committed query route carries the engine-origin redirect_uri the
     page minted (Arm B of the login-host fix passes it through, and
     the recapture must reopen exactly what the ladder decoded). */
  const PAGE =
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=cid&redirect_uri=" +
    encodeURIComponent(ORIGIN + "/mail/") +
    "&response_type=code";

  const postMessage = vi.fn();
  const clients: Record<string, Record<string, unknown> | undefined> = {};

  const shellClient = (frameType: string, url: string) => ({
    type: "window",
    frameType,
    url,
    postMessage,
  });

  const mkEvent = (routeUrl: string, clientId: string, replacesClientId: string, method = "GET") => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: routeUrl,
        method,
        mode: "navigate",
        destination: "document",
        credentials: "same-origin",
        referrer: "",
        body: null,
        headers: new Headers(),
      },
      clientId,
      resultingClientId: clientId + "-new",
      replacesClientId,
      respondWith: (p: Promise<Response>) => void armed.push(p),
      waitUntil: () => {},
    } as unknown as FetchEvent;
    return { ev, armed };
  };

  /* The boot route restore mints and installs its own key when the
     key history is empty; every key the tests set must outlive it. */
  beforeAll(async () => {
    await routeReady;
  });

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.urls = [];
    transportMock.queue = [
      new Response("ok", { headers: { "content-type": "text/plain" } }),
    ];
    setScheme("/j/");
    setRouteKey(KEY);
    postMessage.mockClear();
    for (const k of Object.keys(clients)) delete clients[k];
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async (id: string) => clients[id] ?? null },
    });
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("no cache storage");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recaptures a cross-origin hijack of the shell as a new tab", async () => {
    clients["shell-1"] = shellClient("top-level", ORIGIN + "/");
    const { ev, armed } = mkEvent("https://evil.example/x", "pane-1", "shell-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.type).toBe("error");
    expect(transportMock.calls).toBe(0);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      lb: "zlescape",
      data: { dest: "https://evil.example/x" },
    });
  });

  it("recaptures a query-route hijack with the decoded destination", async () => {
    clients["shell-1"] = shellClient("top-level", ORIGIN + "/index.html");
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const { ev, armed } = mkEvent(ORIGIN + h, "pane-1", "shell-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.type).toBe("error");
    expect(transportMock.calls).toBe(0);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      lb: "zlescape",
      data: { dest: PAGE },
    });
  });

  it("serves a pane navigation of its own window unchanged", async () => {
    const h = buildQueryHandleUrl(PAGE);
    const { ev, armed } = mkEvent(ORIGIN + h, "pane-1", "pane-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
    expect(transportMock.urls).toEqual([PAGE]);
  });

  it("serves an engine-minted popup (no client is replaced)", async () => {
    const h = buildQueryHandleUrl(PAGE);
    const { ev, armed } = mkEvent(ORIGIN + h, "pane-1", "");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("serves when the replaced client is a nested pane, not the shell", async () => {
    clients["pane-2"] = shellClient("nested", ORIGIN + "/mail/");
    const h = buildQueryHandleUrl(PAGE);
    const { ev, armed } = mkEvent(ORIGIN + h, "pane-1", "pane-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
    expect(transportMock.urls).toEqual([PAGE]);
  });

  it("serves when the clients API cannot resolve the replaced client", async () => {
    const h = buildQueryHandleUrl(PAGE);
    const { ev, armed } = mkEvent(ORIGIN + h, "pane-1", "shell-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("serves when the replaced top document is parked off the shell root", async () => {
    clients["shell-1"] = shellClient("top-level", ORIGIN + "/mail/");
    const h = buildQueryHandleUrl(PAGE);
    const { ev, armed } = mkEvent(ORIGIN + h, "pane-1", "shell-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("serves when the replaced top document is on another origin", async () => {
    clients["shell-1"] = shellClient("top-level", "https://other.example/");
    const { ev, armed } = mkEvent("https://evil.example/x", "pane-1", "shell-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("serves a POST hijack (an abort would lose the body)", async () => {
    clients["shell-1"] = shellClient("top-level", ORIGIN + "/");
    const h = buildQueryHandleUrl(PAGE);
    const { ev, armed } = mkEvent(ORIGIN + h, "pane-1", "shell-1", "POST");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(postMessage).not.toHaveBeenCalled();
    expect(transportMock.urls).toEqual([PAGE]);
  });
});
