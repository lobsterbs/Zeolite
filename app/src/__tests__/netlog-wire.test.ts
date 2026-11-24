/* #713: every netlog row for a dispatched request now carries the
   WIRE header set (the FINAL outgoing set at the #521 seam, post
   rules+DNR+profile+jar) plus the pre-dispatch stage. The MI613e
   chase proved the old detail only showed the PRE-rewrite page
   headers, so a wire-voice switch could not be verified from an
   exported KDL. Three proofs: the ring redacts wire secrets, a real
   drive through handleFetch records the wire set with a stage stamp,
   and the source contract pins the seam markers in place. */

import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () =>
      new Response("mock", { headers: { "content-type": "text/plain" } }),
  },
}));

import { handleFetch } from "../request";
import {
  netLogCursor,
  netLogPush,
  netLogSince,
  type NetDetail,
} from "../netlog";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://w.example.org";
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
    clientId: "c-wire-1",
    resultingClientId: "c-wire-1-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const readOnce = (rel: string, marker: string, path: string): void => {
  const text = readFileSync(new URL(rel, import.meta.url), "utf8");
  const hits = text.split(marker).length - 1;
  if (hits !== 1)
    throw new Error(`${path}: expected marker once, found ${hits}: ${marker}`);
};

describe("netlog wire header set + pre-dispatch stage (#713)", () => {
  beforeEach(() => {
    origFetch = globalThis.fetch;
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
  });

  it("netLogPush redacts wire secret headers and stores the stage", () => {
    const before = netLogCursor();
    const detail: NetDetail = {
      internalUrl: "/zl/aGk",
      ttfb: 40,
      reqHeaders: {},
      wireHeaders: {
        cookie: "sess=secret; other=1",
        authorization: "Bearer tok",
        "user-agent": "Chrome (Windows) wire",
      },
      stages: { pre: 12 },
    };
    netLogPush({
      method: "GET",
      path: "/zl/aGk",
      dest: "https://x.example/api",
      status: 200,
      ms: 40,
      bytes: 4,
      rtype: "FETCH",
      detail,
    });
    const rows = netLogSince(before);
    expect(rows).toHaveLength(1);
    const w = rows[0]!.detail!.wireHeaders!;
    expect(w["cookie"]).toBe("[redacted]");
    expect(w["authorization"]).toBe("[redacted]");
    expect(w["user-agent"]).toBe("Chrome (Windows) wire");
    expect(rows[0]!.detail!.stages!.pre).toBe(12);
  });

  it("a driven upstream request records the wire set and the pre-dispatch stage", async () => {
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/api"),
      "cors",
      "empty",
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const rows = netLogSince(before).filter((r) => r.detail);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    /* The row that dispatched upstream must carry the post-surgery
       wire set, distinct from the pre-rewrite page set: the MI613e
       verdict turned on exactly this distinction. */
    const row = rows.find((r) => r.detail!.stages && r.detail!.wireHeaders);
    expect(row).toBeDefined();
    expect(row!.detail!.stages!.pre).toBeGreaterThanOrEqual(0);
    expect(Object.keys(row!.detail!.wireHeaders!).length).toBeGreaterThan(0);
    expect(row!.detail!.wireHeaders).not.toEqual(row!.detail!.reqHeaders);
  });

  it("source contract: the #521 wire snapshot and export keys stay pinned", () => {
    readOnce("../request.ts", "let wireShot: Record<string, string> | undefined;", "request.ts");
    readOnce("../request.ts", "if (wireShot) d.wireHeaders = wireShot;", "request.ts");
    readOnce("../request.ts", "if (tSend) d.stages = { pre: tSend - t0 };", "request.ts");
    readOnce("../request.ts", "wireShot = flatRed(sendHeaders);", "request.ts");
    readOnce("../request.ts", "tSend = Date.now();", "request.ts");
    readOnce("../netlog.ts", "wireHeaders?: Record<string, string>;", "netlog.ts");
    readOnce("../netlog.ts", "wireHeaders: headers(d.wireHeaders),", "netlog.ts");
    readOnce("../netlog.ts", "stages?: Record<string, number>;", "netlog.ts");
    readOnce("../devtools.ts", "page headers (incoming):", "devtools.ts");
    readOnce("../devtools.ts", "wire headers (upstream, post-surgery):", "devtools.ts");
    readOnce("../devtools.ts", "      page_request_header ", "devtools.ts");
    readOnce("../devtools.ts", "      wire_header ", "devtools.ts");
    readOnce("../devtools.ts", "      stage \" + kdlStr(k) + \"=\" + kdlNum(v))", "devtools.ts");
  });
});
