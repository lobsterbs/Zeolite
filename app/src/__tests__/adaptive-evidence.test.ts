/* #487 phases 2-4 regression tests.

   Phase 2: planJsServeOutcome proves the ACTUAL transformation class
   per pass (a textual no-diff is never site-level proof; a skipped
   literal pass claims no proof at all).
   Phase 3: the per-origin evidence store is observe-only, bounded,
   hostname + counters only, TTL-pruned.
   Phase 4: the literal-pass demotion needs corroboration (>=3
   failures across >=2 distinct traces), is opt-in behind the
   swstate adaptiveTransit flag, and the kill switch restores the
   pass. The serve path records outcomes end to end. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The transform module keeps its pure exports; only the two
   wasm-backed functions are stubbed - these tests pin the serve-path
   evidence wiring, not the rewriter itself. */
const transformMock = vi.hoisted(() => ({
  rewriteCalls: 0,
  suffix: "",
  fail: false,
}));

vi.mock("../transform", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    scriptPinsOrigins: async () => false,
    rewriteJsBody: async (src: string) => {
      transformMock.rewriteCalls++;
      if (transformMock.fail) throw new Error("wasm load failed");
      return src + transformMock.suffix;
    },
  };
});

const transportMock = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async () => {
      transportMock.calls++;
      return new Response("console.log(1);", {
        headers: { "content-type": "application/javascript" },
      });
    },
  },
}));

import { handleFetch } from "../request";
import { encodeDestLegacy } from "../codec";
import { planJsServeOutcome } from "../transit";
import {
  ADAPTIVE_TTL_MS,
  adaptiveEvidenceReset,
  adaptiveEvidenceSnapshot,
  adaptiveEvidenceVersionForTests,
  classifyServeFailure,
  literalPassDemotion,
  recordBodyPassFailure,
  recordJsServeOutcome,
  recordServeFailure,
} from "../adaptive-evidence";
import { setAdaptiveTransit } from "../swstate";

describe("planJsServeOutcome (#487 phase 2)", () => {
  it("proves a body unchanged only when every pass ran and each was a no-op", () => {
    expect(planJsServeOutcome("s", "s", "s")).toEqual({
      specifierChanged: false,
      literalChanged: false,
      literalSkipped: false,
      provenUnchanged: true,
    });
    /* A changed specifier is a real transformation, not proof of
       an unchanged body. */
    const spec = planJsServeOutcome("s", "s1", "s1");
    expect(spec.specifierChanged).toBe(true);
    expect(spec.provenUnchanged).toBe(false);
    const lit = planJsServeOutcome("s", "s", "s2");
    expect(lit.literalChanged).toBe(true);
    expect(lit.provenUnchanged).toBe(false);
  });

  it("never claims proof for a skipped literal pass (pin or failure)", () => {
    const skip = planJsServeOutcome("s", "s", null);
    expect(skip.literalSkipped).toBe(true);
    expect(skip.provenUnchanged).toBe(false);
  });
});

describe("adaptive evidence store (#487 phase 3)", () => {
  beforeEach(() => {
    adaptiveEvidenceReset();
  });

  it("stores hostnames and counters only, never URLs or queries", () => {
    recordJsServeOutcome("https://secret.example/path?q=token", {
      specifierChanged: false,
      literalChanged: false,
      literalSkipped: false,
    });
    const snap = adaptiveEvidenceSnapshot();
    expect(snap.origins).toBe(1);
    const e = snap.entries[0]!;
    expect(e.origin).toBe("secret.example");
    expect(e.observed).toBe(1);
    expect(e.provenUnchanged).toBe(1);
    expect(JSON.stringify(snap)).not.toContain("path?q=token");
  });

  it("is bounded and drop-oldest (512 origins)", () => {
    for (let i = 0; i < 513; i++) {
      recordJsServeOutcome("https://o" + i + ".example/x.js", {
        specifierChanged: true,
        literalChanged: false,
        literalSkipped: false,
      });
    }
    const snap = adaptiveEvidenceSnapshot();
    expect(snap.origins).toBe(512);
    expect(snap.dropped).toBe(1);
    expect(snap.entries.find((e) => e.origin === "o0.example")).toBeUndefined();
  });

  it("TTL-stale evidence is pruned and never demotes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 3; i++) recordBodyPassFailure("https://old.example/x.js", "t" + i);
    expect(literalPassDemotion("https://old.example/x.js")).toBe(true);
    vi.setSystemTime(1_000_000 + ADAPTIVE_TTL_MS + 1);
    expect(literalPassDemotion("https://old.example/x.js")).toBe(false);
    expect(adaptiveEvidenceSnapshot().entries.find((e) => e.origin === "old.example")).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("learned literal-pass demotion (#487 phase 4)", () => {
  beforeEach(() => {
    adaptiveEvidenceReset();
  });

  it("needs corroboration: 3 failures across 2 distinct traces", () => {
    recordBodyPassFailure("https://c.example/a.js", "t1");
    recordBodyPassFailure("https://c.example/a.js", "t1");
    recordBodyPassFailure("https://c.example/a.js", "t1");
    /* 3 failures but one trace: one flaky wasm load never changes
       behavior. */
    expect(literalPassDemotion("https://c.example/a.js")).toBe(false);
    recordBodyPassFailure("https://c.example/a.js", "t2");
    expect(literalPassDemotion("https://c.example/a.js")).toBe(true);
  });

  it("fewer than 3 failures never demotes", () => {
    recordBodyPassFailure("https://d.example/a.js", "t1");
    recordBodyPassFailure("https://d.example/a.js", "t2");
    expect(literalPassDemotion("https://d.example/a.js")).toBe(false);
  });
});

const ORIGIN = "https://w.example.org";
let origFetch: typeof fetch;

const mkEvent = (routeUrl: string, clientId: string, mode: string, destination: string) => {
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
    clientId,
    resultingClientId: clientId + "-new",
    respondWith: (p: Promise<Response>) => void armed.push(p),
    waitUntil: () => {},
  } as unknown as FetchEvent;
  return { ev, armed };
};

const serve = async (clientId: string) => {
  const { ev, armed } = mkEvent(
    ORIGIN + encodeDestLegacy("https://js.example/app.js"),
    clientId,
    "cors",
    "script",
  );
  handleFetch(ev);
  return armed[0]!;
};

describe("serve path records outcomes and gates the learned skip (#487)", () => {
  beforeEach(() => {
    transportMock.calls = 0;
    transformMock.rewriteCalls = 0;
    transformMock.suffix = "";
    transformMock.fail = false;
    adaptiveEvidenceReset();
    setAdaptiveTransit(false);
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('allow "js.example"', { status: 200 })) as typeof fetch;
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
    setAdaptiveTransit(false);
  });

  it("a fresh script serve records its ACTUAL transformation class", async () => {
    const served = await serve("c-a1");
    expect(served.status).toBe(200);
    expect(transformMock.rewriteCalls).toBe(1);
    const e = adaptiveEvidenceSnapshot().entries.find((x) => x.origin === "js.example");
    expect(e).toBeDefined();
    expect(e!.observed).toBe(1);
    expect(e!.provenUnchanged).toBe(1);
    expect(e!.literalChanged).toBe(0);
  });

  it("a literal change is recorded as literalChanged, never provenUnchanged", async () => {
    transformMock.suffix = "/*lit*/";
    const served = await serve("c-a2");
    expect(served.status).toBe(200);
    const e = adaptiveEvidenceSnapshot().entries.find((x) => x.origin === "js.example")!;
    expect(e.literalChanged).toBe(1);
    expect(e.provenUnchanged).toBe(0);
  });

  it("corroborated failures demote only when opted in; the kill switch restores the pass", async () => {
    /* Three failing serves on three distinct clientIds: the specifier
       output still serves, the failures corroborate. */
    transformMock.fail = true;
    for (let i = 0; i < 3; i++) {
      const served = await serve("c-f" + i);
      expect((await served).status).toBe(200);
    }
    expect(transformMock.rewriteCalls).toBe(3);
    expect(literalPassDemotion("https://js.example/app.js")).toBe(true);

    /* Demotion is OFF by default: the next serve still runs the
       literal pass. */
    transformMock.fail = false;
    await (await serve("c-f3")).text();
    expect(transformMock.rewriteCalls).toBe(4);

    /* Opt in: the next serve skips the literal pass and records the
       demotion served. */
    setAdaptiveTransit(true);
    const demoted = await serve("c-f4");
    expect((await demoted).status).toBe(200);
    expect(transformMock.rewriteCalls).toBe(4);
    const e = adaptiveEvidenceSnapshot().entries.find((x) => x.origin === "js.example")!;
    expect(e.demotionsServed).toBe(1);

    /* Kill switch off: the pass runs again on the very next serve. */
    setAdaptiveTransit(false);
    await (await serve("c-f5")).text();
    expect(transformMock.rewriteCalls).toBe(5);
  });
});


describe("failure-source classification and version invalidation (#539)", () => {
  beforeEach(() => {
    adaptiveEvidenceReset();
    adaptiveEvidenceVersionForTests(null);
  });

  afterEach(() => {
    adaptiveEvidenceVersionForTests(null);
  });

  it("classifies upstream statuses, challenge pages, transport and rewrite-stage failures", () => {
    expect(classifyServeFailure(200, null, false)).toBeNull();
    expect(classifyServeFailure(null, null, false)).toBeNull();
    expect(classifyServeFailure(302, null, false)).toBe("UPSTREAM_3XX");
    expect(classifyServeFailure(404, null, false)).toBe("UPSTREAM_4XX");
    expect(classifyServeFailure(503, null, false)).toBe("UPSTREAM_5XX");
    expect(classifyServeFailure(null, "transport", false)).toBe("TRANSPORT_ERROR");
    expect(classifyServeFailure(null, "rewrite", false)).toBe("REWRITE_STAGE_ERROR");
    expect(classifyServeFailure(404, null, true)).toBe("CHALLENGE_PAGE");
  });

  it("recorded failure classes are observe-only and never demote", () => {
    for (let i = 0; i < 50; i++) {
      recordServeFailure("https://n.example/app.js", "UPSTREAM_3XX");
      recordServeFailure("https://n.example/app.js", "UPSTREAM_4XX");
      recordServeFailure("https://n.example/app.js", "UPSTREAM_5XX");
      recordServeFailure("https://n.example/app.js", "TRANSPORT_ERROR");
      recordServeFailure("https://n.example/app.js", "CHALLENGE_PAGE");
      recordServeFailure("https://n.example/app.js", "REWRITE_STAGE_ERROR");
    }
    expect(literalPassDemotion("https://n.example/app.js")).toBe(false);
    const e = adaptiveEvidenceSnapshot().entries.find((x) => x.origin === "n.example");
    expect(e).toBeDefined();
    expect(e!.upstream3xx).toBe(50);
    expect(e!.upstream4xx).toBe(50);
    expect(e!.upstream5xx).toBe(50);
    expect(e!.challengePages).toBe(50);
    expect(e!.transportErrors).toBe(50);
    expect(e!.rewriteStageErrors).toBe(50);
    /* Corroborated body-pass failures on the same origin still demote:
       the observe-only classes stay independent of the demotion gate. */
    recordBodyPassFailure("https://n.example/app.js", "t0");
    recordBodyPassFailure("https://n.example/app.js", "t1");
    recordBodyPassFailure("https://n.example/app.js", "t1");
    expect(literalPassDemotion("https://n.example/app.js")).toBe(true);
  });

  it("an engine-version change wipes learned state", () => {
    adaptiveEvidenceVersionForTests("1.0.0");
    recordBodyPassFailure("https://v.example/a.js", "t0");
    recordBodyPassFailure("https://v.example/a.js", "t1");
    recordBodyPassFailure("https://v.example/a.js", "t1");
    expect(literalPassDemotion("https://v.example/a.js")).toBe(true);
    adaptiveEvidenceVersionForTests("1.0.1");
    expect(literalPassDemotion("https://v.example/a.js")).toBe(false);
    const snap = adaptiveEvidenceSnapshot();
    expect(snap.origins).toBe(0);
    expect(snap.version).toBe("1.0.1");
    expect(snap.versionResets).toBe(1);
  });

  it("teardown reset clears the store, counters and version stamp", () => {
    recordBodyPassFailure("https://r.example/a.js", "t0");
    adaptiveEvidenceReset();
    expect(adaptiveEvidenceSnapshot().origins).toBe(0);
    expect(literalPassDemotion("https://r.example/a.js")).toBe(false);
  });
});
