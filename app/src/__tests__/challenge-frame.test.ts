import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #129: challenge-widget frames stay engine-routed. The request
   engine (transport mock mirroring request.test.ts) serves frame
   NAVIGATIONS to challenge URLs through the tunnel like any other
   document; #120's provider-direct 302 was an IP leak (the #32
   class) and left the widget cross-origin, so its postMessage to
   the embedder was dropped and the challenge spun. Every other
   request shape (scripts, XHR, non-challenge frames) routes as
   before. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  urls: [] as string[],
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string) => {
      transportMock.calls++;
      transportMock.urls.push(url);
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
}));

import { handleFetch, isChallengeFrameUrl } from "../request";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://w.example.org";
const b64 = (s: string) => btoa(s).replace(/=+$/, (p) => ".".repeat(p.length));

describe("isChallengeFrameUrl (#120 shapes)", () => {
  it("accepts recaptcha frame URLs on the google hosts only under /recaptcha/", () => {
    expect(isChallengeFrameUrl("https://www.google.com/recaptcha/enterprise/anchor?ar=1")).toBe(true);
    expect(isChallengeFrameUrl("https://www.recaptcha.net/recaptcha/api2/bframe?x=1")).toBe(true);
    expect(isChallengeFrameUrl("https://recaptcha.net/recaptcha/api.js")).toBe(true);
    expect(isChallengeFrameUrl("https://www.google.com/maps/embed/v1?key=k")).toBe(false);
    expect(isChallengeFrameUrl("https://www.google.com/search?q=x")).toBe(false);
  });

  it("accepts the dedicated challenge providers on any path", () => {
    expect(isChallengeFrameUrl("https://challenges.cloudflare.com/cf-turnstile-challenge")).toBe(true);
    expect(isChallengeFrameUrl("https://hcaptcha.com/getcaptcha/abc")).toBe(true);
    expect(isChallengeFrameUrl("https://newassets.hcaptcha.com/captcha/v1/a/static/hcaptcha.html")).toBe(true);
  });

  it("rejects everything else honestly", () => {
    expect(isChallengeFrameUrl("https://example.com/recaptcha/api2/anchor")).toBe(false);
    expect(isChallengeFrameUrl("https://js.stripe.com/v3/other.js")).toBe(false);
    expect(isChallengeFrameUrl("not a url")).toBe(false);
    expect(isChallengeFrameUrl("data:text/html,x")).toBe(false);
  });
});

describe("challenge frame navigation routing (#129)", () => {
  /* Plain-object requests/events (mode "navigate" is constructor-
     illegal on a node Request), mirroring the #110 harness. */
  const mkEvent = (routeUrl: string, mode: string, destination: string, referrer: string) => {
    const armed: Promise<Response>[] = [];
    const ev = {
      request: {
        url: routeUrl,
        method: "GET",
        mode,
        destination,
        credentials: "same-origin",
        referrer,
        body: null,
        headers: new Headers(),
      },
      clientId: "chal-1",
      resultingClientId: "chal-1-new",
      respondWith: (p: Promise<Response>) => void armed.push(p),
      waitUntil: () => {},
    } as unknown as FetchEvent;
    return { ev, armed };
  };

  beforeEach(() => {
    transportMock.calls = 0;
    transportMock.urls = [];
    transportMock.queue = [];
    vi.stubGlobal("self", {
      location: { origin: ORIGIN },
      registration: { scope: ORIGIN + "/" },
      clients: { get: async () => null },
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

  it("routes a recaptcha anchor frame navigation through the engine with the co= fix", async () => {
    const anchor =
      "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=KEY&co=" + b64(ORIGIN + ":443") + "&v=V";
    const referrer = ORIGIN + encodeDestLegacy("https://www.google.com/sorry/ipblur");
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy(anchor),
      "navigate",
      "iframe",
      referrer,
    );
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    /* the fetch rides the transport: the frame never goes provider-direct */
    expect(transportMock.calls).toBe(1);
    expect(served.headers.get("location")).toBeNull();
    /* the site-key domain check rides along: co= names the embedding
       page's virtual origin, not the engine origin */
    expect(transportMock.urls[0]).toContain("co=" + b64("https://www.google.com:443"));
  });

  it("routes a Turnstile frame navigation through the engine", async () => {
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://challenges.cloudflare.com/cf-turnstile-challenge"),
      "navigate",
      "frame",
      "",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.calls).toBe(1);
    expect(served.headers.get("location")).toBeNull();
  });

  it("still routes a script load of the same anchor URL through the engine", async () => {
    const anchor = "https://www.google.com/recaptcha/api.js?co=" + b64(ORIGIN + ":443");
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(anchor), "cors", "script", "");
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.calls).toBe(1);
  });

  it("still routes a non-challenge google iframe through the engine", async () => {
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://www.google.com/maps/embed/v1?key=k"),
      "navigate",
      "iframe",
      "",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    expect(transportMock.calls).toBe(1);
  });
});
