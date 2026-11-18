import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #634/#431 transport repro: the MSAL redirect chain driven through the
   REAL handleFetch hop loop with a mocked transport queue, asserting
   that every hop's Set-Cookie is captured against the hop URL it came
   from and that the Cookie header for each hop carries exactly the
   cookies whose domain/path scope the hop target (RFC 6265 5.3/5.4):

     authorize (login.microsoftonline.com)
       -> 302 Set-Cookie batch (incl. cross-domain SSO cookies that must
          be honestly rejected) -> Location login.live.com/Me.htm?v=3
     Me.htm (login.live.com)
       -> 302 Set-Cookie .live.com batch -> Location back to authorize
     authorize again -> 200

   The mocked responses carry `rawHeaders` the way the vendored
   transport does (Response construction drops set-cookie), which is
   what jarHeaders() reads. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
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
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch } from "../request";
import { encodeDestLegacy } from "../codec";
import { cookieHeaderFor, cookiesResetForTests, jarSnapshot } from "../cookies";

const ORIGIN = "https://w.example.org";

const AUTHORIZE =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20-a13f-4107-85dc-02114787ef48&response_type=code&response_mode=fragment";
const ME_HTM = "https://login.live.com/Me.htm?v=3";
const AUTHORIZE_2 =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20&sso_reload=true";

/* A 3xx the way the vendored transport surfaces it: location readable on
   .headers, the full raw pair list (incl. every set-cookie) on
   .rawHeaders. */
function hop302(location: string, setCookies: string[]): Response {
  const r = new Response(null, { status: 302, headers: { location } });
  (r as Response & { rawHeaders?: [string, string][] }).rawHeaders = [
    ["location", location],
    ...setCookies.map((c): [string, string] => ["set-cookie", c]),
  ];
  return r;
}

const HOP1_SETCOOKIE = [
  "ESTSSC=abc123; Domain=.login.microsoftonline.com; Path=/; Secure; SameSite=None",
  "ESTSAUTH=xyz; Domain=.login.microsoftonline.com; Path=/; Secure; HttpOnly; SameSite=Lax",
  "CCState=state1; Domain=.microsoftonline.com; Path=/; Secure",
  "LoginAttempts=1; Path=/; Secure; HttpOnly",
  "SSOLive=1; Domain=.live.com; Path=/; Secure; SameSite=None",
  "SSOMs=1; Domain=.microsoft.com; Path=/; Secure",
];

const HOP2_SETCOOKIE = [
  "MSPRequ=req1; Domain=.live.com; Path=/; Secure",
  "MSPAuth=tok; Path=/; Secure; HttpOnly",
  "BackToMso=1; Domain=.microsoftonline.com; Path=/; Secure",
];

function mkNavEvent(routeUrl: string, clientId: string) {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "GET",
      mode: "navigate",
      destination: "document",
      credentials: "same-origin",
      referrer: "",
      body: null,
      headers: new Headers(),
    },
    clientId,
    resultingClientId: clientId + "-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
}

describe("MSAL redirect chain through the handleFetch hop loop (#634/#431)", () => {
  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.urls = [];
    transportMock.inits = [];
    transportMock.queue = [];
    cookiesResetForTests();
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
    });
    /* working in-memory Cache Storage: a refused open is the documented
       fail-closed "cookies off" path, not what this repro exercises */
    const mem = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (k: string) => mem.get(k),
        put: async (k: string, r: Response) => void mem.set(k, r),
        delete: async (k: string) => mem.delete(k),
        keys: async () => [...mem.keys()],
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cookiesResetForTests();
  });

  it("follows authorize -> Me.htm -> authorize, capturing Set-Cookie per hop and scoping the Cookie header per hop target", async () => {
    transportMock.queue = [
      hop302(ME_HTM, HOP1_SETCOOKIE),
      hop302(AUTHORIZE_2, HOP2_SETCOOKIE),
      new Response("<html>login ok</html>", { status: 200, headers: { "content-type": "text/plain" } }),
    ];
    const { ev, armed } = mkNavEvent(ORIGIN + encodeDestLegacy(AUTHORIZE), "msal-1");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);

    /* the chain followed engine-side: all three upstream URLs, in order */
    expect(transportMock.urls).toEqual([AUTHORIZE, ME_HTM, AUTHORIZE_2]);

    /* hop 1: fresh jar, no cookie sent */
    expect(transportMock.inits[0]?.headers?.get("cookie") ?? "").toBe("");

    /* hop 2 (login.live.com): still nothing scopes it -> no cookie header */
    expect(transportMock.inits[1]?.headers?.get("cookie") ?? "").toBe("");

    /* hop 3 (back on login.microsoftonline.com): the hop-1 session rides
       along; nothing live.com-scoped leaks across */
    const hop3Cookie = transportMock.inits[2]?.headers?.get("cookie") ?? "";
    expect(hop3Cookie).toContain("ESTSSC=abc123");
    expect(hop3Cookie).toContain("ESTSAUTH=xyz");
    expect(hop3Cookie).toContain("CCState=state1");
    expect(hop3Cookie).toContain("LoginAttempts=1");
    expect(hop3Cookie).not.toContain("MSPRequ");
    expect(hop3Cookie).not.toContain("MSPAuth");
    expect(hop3Cookie).not.toContain("SSOLive");
    expect(hop3Cookie).not.toContain("SSOMs");

    /* the jar after the chain: same-site cookies stored per hop origin,
       cross-domain SSO cookies honestly rejected */
    const all = [...jarSnapshot().values()].flat();
    const names = all.map((c) => c.name).sort();
    expect(names).toEqual(["CCState", "ESTSAUTH", "ESTSSC", "LoginAttempts", "MSPAuth", "MSPRequ"]);
    expect(cookieHeaderFor(ME_HTM) ?? "").toContain("MSPRequ=req1");
    expect(cookieHeaderFor(ME_HTM) ?? "").toContain("MSPAuth=tok");
    expect(cookieHeaderFor(ME_HTM) ?? "").not.toContain("ESTSSC");
    expect(cookieHeaderFor(AUTHORIZE_2) ?? "").not.toContain("MSPRequ");
  });

  it("a surfaced 3xx (hop cap shape) keeps its Set-Cookie captured and maps Location to an engine route", async () => {
    /* one-shot-streamed body over the cap is the surfaced shape; simpler:
       a 3xx with no Location surfaces as-is */
    const r = hop302("", ["SURF=1; Domain=.login.microsoftonline.com; Path=/; Secure"]);
    r.headers.delete("location");
    (r as Response & { rawHeaders?: [string, string][] }).rawHeaders = [
      ["set-cookie", "SURF=1; Domain=.login.microsoftonline.com; Path=/; Secure"],
    ];
    transportMock.queue = [r];
    const { ev, armed } = mkNavEvent(ORIGIN + encodeDestLegacy(AUTHORIZE), "msal-2");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(302);
    /* the surfaced hop's Set-Cookie still landed in the jar */
    expect(cookieHeaderFor(AUTHORIZE) ?? "").toContain("SURF=1");
  });
});
