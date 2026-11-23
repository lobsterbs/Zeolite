/* #706: a navigation to an interactive-auth host a breakout rule
   marks stamps a netlog marker row so the embedder's capture and
   sheet can act. Subresources and unmarked hosts leave no mark, and
   the transit decision stays untouched. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () =>
      new Response("plain doc", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  },
}));

import { handleFetch } from "../request";
import { netLogCursor, netLogSince } from "../netlog";
import { encodeDestLegacy } from "../codec";
import { policyResetForTests } from "../policy";

const ORIGIN = "https://w.example.org";
const POLICY_KDL = 'rule "auth-breakout" {\n  match host="login.example.com"\n  types "document"\n  route "breakout"\n  reason "#706 fixture"\n}\n';

let origFetch: typeof fetch;

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
    clientId: "c-br-1",
    resultingClientId: "c-br-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const markerRows = (before: number) =>
  netLogSince(before).filter((r) => typeof r.verdict === "string" && r.verdict.startsWith("engine: breakout required"));

describe("breakout policy marker rows (#706)", () => {
  beforeEach(() => {
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/policy.kdl"))
        return new Response(POLICY_KDL, { status: 200, headers: { "content-type": "text/kdl" } });
      if (u.includes("/rules.kdl"))
        return new Response("", { status: 200, headers: { "content-type": "text/kdl" } });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    policyResetForTests();
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
    globalThis.fetch = origFetch;
    vi.unstubAllGlobals();
    policyResetForTests();
  });

  it("a navigation to a marked host pushes exactly one marker row naming the rule", async () => {
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://login.example.com/oauth2/authorize"),
      "navigate",
      "document",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const rows = markerRows(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "engine: breakout required: auth-breakout",
      transport: "policy",
      status: 0,
      dest: "https://login.example.com/oauth2/authorize",
    });
  });

  it("a subresource to the same marked host leaves no marker row", async () => {
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://login.example.com/telemetry"),
      "cors",
      "image",
    );
    handleFetch(ev);
    await armed[0]!;
    expect(markerRows(before)).toHaveLength(0);
  });

  it("a navigation to an unmarked host leaves no marker row", async () => {
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://plain.example/"),
      "navigate",
      "document",
    );
    handleFetch(ev);
    await armed[0]!;
    expect(markerRows(before)).toHaveLength(0);
  });
});
