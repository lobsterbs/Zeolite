import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #663: the JS_BODY_CAP seam at the request layer. The reported duck.ai
   class is an entry script over the cap serving verbatim (RAW_BODY_CAP,
   request.ts bbS.over branch, passthroughStream): the specifier, literal
   and location passes all skip it. The 2026-11-14 cap raise (2 -> 8 MiB,
   transform.ts JS_BODY_CAP) already covers the reported bundle (the live
   duck.ai entry is 2.43 MiB), so the honest contract to pin here is the
   boundary itself: under the cap the passes run (relative module
   specifiers route), over the cap the body serves byte-identical and
   verbatim with the RAW_BODY_CAP diag stage and the js-body-cap netlog
   annotate. No per-site cap exception, no streaming JS rewrite pass. */

const transportMock = vi.hoisted(() => ({
  calls: 0,
  queue: [] as Response[],
}));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      transportMock.calls++;
      const queued = transportMock.queue.shift();
      if (queued) return queued;
      return new Response("mock", { headers: { "content-type": "text/html" } });
    },
  },
}));

vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
    add_injection(_p: string) {}
    set_blocked_hosts(_h: string[]) {}
    set_lazy_images() {}
  }
  return {
    JsRewriter,
    globalsStats: () => "0,0,0",
    default: async () => {},
  };
});

import { handleFetch } from "../request";
import { cookiesResetForTests } from "../cookies";
import { currentPrefix, decodePath, encodeDestLegacy, setScheme } from "../codec";
import { DIAG } from "../diag";
import { netLog } from "../netlog";
import { JS_BODY_CAP } from "../transform";

const ORIGIN = "https://zl.test";
const MODULE = "https://duck.ai/entry.duckai.3311f1d805377bbc184b.js";

const mkEvent = (routeUrl: string, destination: string) => {
  const armed: Promise<Response>[] = [];
  const ev = {
    request: {
      url: routeUrl,
      method: "GET",
      mode: "cors",
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

const jsResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "application/javascript; charset=utf-8" } });

const stubSelf = () =>
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: ORIGIN + "/" },
    clients: { get: async () => null },
  });

async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const r = s.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
};

describe("#663 JS_BODY_CAP seam at the request layer", () => {
  beforeEach(() => {
    cookiesResetForTests();
    setScheme("/j/");
    transportMock.calls = 0;
    transportMock.queue = [];
    stubSelf();
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("no cache storage");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("under the cap the specifier pass runs: the relative module import routes", async () => {
    const body = 'import("./chunk-AbC123.js");\nconsole.log(1);\n';
    transportMock.queue = [jsResponse(body)];
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(MODULE), "script");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const text = await served.text();
    expect(text).not.toContain('"./chunk-AbC123.js"');
    const m = text.match(new RegExp(currentPrefix().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([A-Za-z0-9_-]+)"));
    expect(m).toBeTruthy();
    expect(decodePath(currentPrefix() + m![1])).toBe("https://duck.ai/chunk-AbC123.js");
    // no RAW_BODY_CAP stage for an under-cap body
    expect(DIAG.snapshot(0).events.some((e) => e.stage === "RAW_BODY_CAP")).toBe(false);
  });

  it("over the cap the body serves byte-identical and verbatim (RAW_BODY_CAP)", async () => {
    const enc = new TextEncoder();
    const head = 'import("./big-chunk.js");\n';
    const marker = "window.__overcap_marker=8784516783;";
    // head + filler pushes the accumulated total past JS_BODY_CAP
    const filler = "/*" + "x".repeat(JS_BODY_CAP) + "*/";
    const body = head + filler + marker;
    transportMock.queue = [
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(body));
            c.close();
          },
        }),
        { headers: { "content-type": "application/javascript; charset=utf-8" } },
      ),
    ];
    const netBefore = netLog.length;
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(MODULE), "script");
    handleFetch(ev);
    expect(armed.length).toBe(1);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const out = await readAll(served.body!);
    const want = enc.encode(body);
    expect(sameBytes(out, want)).toBe(true); // byte-identical verbatim serve
    const text = new TextDecoder().decode(out);
    // the specifier pass skipped: the relative import is still raw
    expect(text).toContain('"./big-chunk.js"');
    expect(text).toContain(marker);
    // the diag stage and the netlog annotate both fired
    expect(DIAG.snapshot(0).events.some((e) => e.stage === "RAW_BODY_CAP")).toBe(true);
    const row = netLog.slice(netBefore).find((r) => r.dest === MODULE || r.path?.includes("j/"));
    expect(row).toBeTruthy();
    expect(row!.rewritten).toBe("js-body-cap");
  });
});
