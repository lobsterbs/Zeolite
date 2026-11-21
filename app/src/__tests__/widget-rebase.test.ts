import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/* #703: the Google apps launcher fetch class. Page JS builds the widget
   loader URL from window.location.origin, so the request arrives as a
   bare engine-origin /widget/app/so path with the origin= parameter
   naming the engine. These tests pin the fetch-seam rebase to
   ogs.google.com, the downstream virtualOgsOrigin repair of origin=,
   and both fail-closed exclusion arms. The transport mock, self and
   caches stubs mirror request.test.ts: the vendored libcurl bundle
   never loads under vitest and these tests pin classification. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  urls: [] as string[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      return new Response("widget", { headers: { "content-type": "text/html" } });
    },
  },
}));

import { handleFetch, routeReady } from "../request";
import { b64uEncode, buildQueryHandleUrl, encodeNavHandle, setRouteKey, setScheme } from "../codec";

describe("apps widget fetch rebase (#703)", () => {
  const ORIGIN = "https://shell.example";
  const KEY = b64uEncode(Uint8Array.from({ length: 16 }, (_, i) => i));
  const PAGE = "https://www.google.com/";

  const fetchSpy = vi.fn(async (_input: Request) => new Response("app", { status: 404 }));
  const clients: Record<string, Record<string, unknown> | undefined> = {};

  const mkEvent = (path: string, referrer: string) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: ORIGIN + path,
        method: "GET",
        mode: "cors",
        destination: "empty",
        credentials: "same-origin",
        referrer,
        body: null,
        headers: new Headers(),
      },
      clientId: "page-1",
      resultingClientId: "page-1",
      respondWith: (p: Promise<Response>) => void armed.push(p),
      waitUntil: () => {},
    } as unknown as FetchEvent;
    return { ev, armed };
  };

  beforeAll(async () => {
    await routeReady;
  });

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.urls = [];
    setScheme("/j/");
    setRouteKey(KEY);
    fetchSpy.mockClear();
    for (const k of Object.keys(clients)) delete clients[k];
    vi.stubGlobal("fetch", fetchSpy);
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

  it("rebases a bare engine-origin widget path to ogs.google.com and repairs origin=", async () => {
    const h = buildQueryHandleUrl(PAGE);
    expect(h).not.toBeNull();
    const path =
      "/widget/app/so?eom=1&awwd=1&origin=" + encodeURIComponent(ORIGIN) + "&cn=app&pid=1";
    const { ev, armed } = mkEvent(path, ORIGIN + h);
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    /* The engine legitimately self-fetches /rules.kdl, /policy.kdl and
       the siteconfig through the same global fetch on the intercepted
       path; the rebase contract is that NONE of those fetches carries
       the widget URL to the bare engine-origin passthrough, and the
       upstream request goes through the transport instead. */
    const passthroughs = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(passthroughs.some((u) => u.includes("/widget/app/so"))).toBe(false);
    expect(transportMock.calls).toBe(1);
    const up = new URL(transportMock.urls[0]);
    expect(up.origin).toBe("https://ogs.google.com");
    expect(up.pathname).toBe("/widget/app/so");
    expect(up.searchParams.get("eom")).toBe("1");
    expect(up.searchParams.get("origin")).toBe("https://www.google.com");
    expect(up.searchParams.get("cn")).toBe("app");
  });

  it("fails closed and passes through with no context and no referrer", async () => {
    const { ev, armed } = mkEvent("/widget/app/so?origin=" + encodeURIComponent(ORIGIN), "");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(transportMock.calls).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0][0] as Request).url).toBe(
      ORIGIN + "/widget/app/so?origin=" + encodeURIComponent(ORIGIN),
    );
    expect(served.status).toBe(404);
  });

  it("fails closed when the referrer is an undecodable host path", async () => {
    const { ev, armed } = mkEvent("/widget/app/so?origin=" + encodeURIComponent(ORIGIN), ORIGIN + "/");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(transportMock.calls).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not touch other bare engine paths", async () => {
    const h = buildQueryHandleUrl(PAGE);
    const { ev, armed } = mkEvent("/some/other/path.png", ORIGIN + h);
    handleFetch(ev);
    await armed[0]!;
    expect(transportMock.calls).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  /* #703 wild reopen (night capture, pin 189): the launcher nav has no
     client context and the strict referrer policy sends the origin
     form (undecodable), but the injector appends the page's MAC zlNavh
     handle to the widget URL itself. The riding token rebase-arms the
     guard and the origin= repair; the token never reaches upstream. */
  it("rebases and repairs from the zlNavh riding the widget URL (#703 wild)", async () => {
    const token = encodeNavHandle(PAGE)!;
    const path =
      "/widget/app/so?eom=1&awwd=1&origin=" + encodeURIComponent(ORIGIN) +
      "&cn=app&pid=1&hl=en&dm=&zlNavh=" + token;
    const { ev, armed } = mkEvent(path, ORIGIN + "/");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.calls).toBe(1);
    const up = new URL(transportMock.urls[0]);
    expect(up.origin).toBe("https://ogs.google.com");
    expect(up.pathname).toBe("/widget/app/so");
    expect(up.searchParams.get("origin")).toBe("https://www.google.com");
    expect(up.searchParams.get("zlNavh")).toBeNull();
  });

  it("keeps the fail-closed passthrough when the riding zlNavh is garbage", async () => {
    const path =
      "/widget/app/so?origin=" + encodeURIComponent(ORIGIN) + "&zlNavh=not-a-token";
    const { ev, armed } = mkEvent(path, ORIGIN + "/");
    handleFetch(ev);
    const served = await armed[0]!;
    /* rebase arms on the token (MAC checked later, not here), but the
       origin repair fails closed: upstream still names the engine. */
    expect(transportMock.calls).toBe(1);
    const up = new URL(transportMock.urls[0]);
    expect(up.searchParams.get("origin")).toBe(ORIGIN);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });
});