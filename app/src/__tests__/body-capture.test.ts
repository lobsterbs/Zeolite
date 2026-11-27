/* Debugger wave slice 3 (#717 discriminator): with capture armed,
   the netlog row for a dispatched request carries the first 16KB of
   the outgoing upstream body, post-surgery, redacted at netLogPush.
   Four proofs: the ring redacts body secrets, a driven POST records
   the body only when armed (string and ArrayBuffer shapes), and the
   source contract pins the seam markers in place. A one-shot
   ReadableStream body (over-cap upload without a spool) is skipped
   by design: reading it would consume the dispatch body. */

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
import { setBodyCapture } from "../swstate";

const ORIGIN = "https://w.example.org";
let origFetch: typeof fetch;

const mkEvent = (
  routeUrl: string,
  mode: string,
  destination: string,
  method = "GET",
  body: BodyInit | null = null,
) => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method,
      mode,
      destination,
      credentials: "same-origin",
      referrer: "",
      body,
      headers: new Headers(),
    },
    clientId: "c-body-1",
    resultingClientId: "c-body-1-new",
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

describe("opt-in upstream request-body prefix capture (debugger wave slice 3)", () => {
  beforeEach(() => {
    origFetch = globalThis.fetch;
    setBodyCapture(false);
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
    setBodyCapture(false);
    vi.unstubAllGlobals();
  });

  it("netLogPush redacts request-body secrets on the way into the ring", () => {
    const before = netLogCursor();
    const detail: NetDetail = {
      internalUrl: "/zl/aGk",
      ttfb: 40,
      reqHeaders: {},
      requestBody: "email=ops@example.org&password=hunter2&token=abc123",
    };
    netLogPush({
      method: "POST",
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
    const b = rows[0]!.detail!.requestBody!;
    expect(b).toContain("email=ops@example.org");
    expect(b).toContain("password=[redacted]");
    expect(b).toContain("token=[redacted]");
    expect(b).not.toContain("hunter2");
    expect(b).not.toContain("abc123");
  });

  it("an armed driven POST records the outgoing body prefix (string shape)", async () => {
    setBodyCapture(true);
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/api"),
      "cors",
      "empty",
      "POST",
      'f.req=[[["w",7,["ops@example.org"]]]]&password=hunter2',
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const rows = netLogSince(before).filter((r) => r.detail);
    const row = rows.find((r) => r.detail!.stages);
    expect(row).toBeDefined();
    expect(row!.detail!.requestBody).toBeDefined();
    expect(row!.detail!.requestBody).toContain("f.req=");
    expect(row!.detail!.requestBody).toContain("password=[redacted]");
    expect(row!.detail!.requestBody).not.toContain("hunter2");
  });

  it("an armed driven POST records the outgoing body prefix (ArrayBuffer shape)", async () => {
    setBodyCapture(true);
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/api"),
      "cors",
      "empty",
      "POST",
      new TextEncoder().encode("payload=zeolite-probe&secret=open-sesame"),
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const rows = netLogSince(before).filter((r) => r.detail);
    const row = rows.find((r) => r.detail!.stages);
    expect(row).toBeDefined();
    expect(row!.detail!.requestBody).toContain("payload=zeolite-probe");
    expect(row!.detail!.requestBody).toContain("secret=[redacted]");
  });

  it("a disarmed request records no body: the toggle is the whole gate", async () => {
    const before = netLogCursor();
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://x.example/api"),
      "cors",
      "empty",
      "POST",
      'f.req=[[["w",7,["ops@example.org"]]]]',
    );
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const rows = netLogSince(before).filter((r) => r.detail);
    for (const r of rows)
      expect(r.detail!.requestBody).toBeUndefined();
  });

  it("source contract: the capture and export seams stay pinned", () => {
    readOnce("../swstate.ts", "export function setBodyCapture(on: boolean): void {", "swstate.ts");
    readOnce("../swstate.ts", "export function bodyCaptureEnabled(): boolean {", "swstate.ts");
    readOnce("../control.ts", "if (typeof msg.bodyCapture === \"boolean\") setBodyCapture(msg.bodyCapture);", "control.ts");
    readOnce("../control.ts", "bodyCapture: bodyCaptureEnabled(),", "control.ts");
    readOnce("../request.ts", "let bodyShot: string | undefined;", "request.ts");
    readOnce("../request.ts", "if (bodyShot !== undefined) d.requestBody = bodyShot;", "request.ts");
    readOnce("../request.ts", "if (hopBody != null && bodyCaptureEnabled()) {", "request.ts");
    readOnce("../netlog.ts", "requestBody?: string;", "netlog.ts");
    readOnce("../netlog.ts", "requestBody: redactSecrets(d.requestBody)", "netlog.ts");
    readOnce("../devtools.ts", "request_body \" + kdlStr(e.detail.requestBody));", "devtools.ts");
    readOnce("../devtools.ts", "request body (first 16KB, upstream, redacted):", "devtools.ts");
  });
});
