import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #451: bounded per-attempt CAPTCHA tracing. A failed challenge flow
   must report WHICH observable stage failed (asset 404 vs verify 403
   vs verify 429), never promise a solve, never record secrets. The
   transport mock mirrors request.test.ts / challenge-frame.test.ts for
   the integration half; the module-level half feeds the ring directly. */

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
      return new Response("mock", { headers: { "content-type": "text/plain" } });
    },
  },
  altConfigured: () => false,
  altRegister: () => {},
  altEndpoint: () => null,
  altWispFetch: async () => {
    throw new Error("no alt transport in test");
  },
  canReplayAfterFailure: () => false,
}));

const wsOpenUrls = vi.hoisted(() => [] as string[]);
vi.mock("../ws-runtime", () => ({
  wsBridge: {
    open: (_port: unknown, url: string) => {
      wsOpenUrls.push(url);
    },
    closeAll: () => {},
  },
}));

/* The rewriter wasm is a CI-vendored artifact (src/rewriter_wasm/ is
   emitted by the build pipeline); these flows never touch a rewrite
   branch, so the transform seam stands in with honest pass-throughs. */
vi.mock("../transform", () => ({
  initTransform: () => {},
  prewarmRewriter: async () => {},
  rewriter: async () => {
    throw new Error("no rewriter in test");
  },
  workerPrelude: async () => "",
  isHtml: (resp: Response) => (resp.headers.get("content-type") ?? "").includes("text/html"),
  isCss: (resp: Response) => (resp.headers.get("content-type") ?? "").includes("text/css"),
  isJs: (resp: Response) => {
    const ct = resp.headers.get("content-type") ?? "";
    return ct.includes("javascript") || ct.includes("ecmascript");
  },
  JS_BODY_CAP: 2 * 1024 * 1024,
  rawFrom: (_head: Uint8Array | undefined, reader: ReadableStreamDefaultReader<Uint8Array>) =>
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) c.enqueue(value);
        }
        c.close();
      },
    }),
  rewriteStream: (body: ReadableStream<Uint8Array>) => body,
  cssRewriteStream: (body: ReadableStream<Uint8Array>) => body,
  rewriteJsBody: async (js: string) => js,
  boundedBody: async (body: ReadableStream<Uint8Array> | null) => ({ over: false, head: null, rest: null, bytes: new Uint8Array(0), body }),
  passthroughStream: (head: Uint8Array | null, h: Uint8Array | null, rest: ReadableStream<Uint8Array> | null) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (head) c.enqueue(head);
        if (h) c.enqueue(h);
        void rest;
        c.close();
      },
    }),
  scriptPinsOrigins: async () => false,
}));

import { CAPTCHA_TRACE, classifyProvider, outcomeOf } from "../captcha-trace";
import { isChallengeFrameUrl } from "../request";
import { handleControlEvent, type ControlMessage } from "../control";
import { handleFetch } from "../request";
import { encodeDestLegacy } from "../codec";

const ORIGIN = "https://w.example.org";
const T0 = 1_700_000_000_000;

const snap = () => CAPTCHA_TRACE.snapshot();

describe("provider classification (#451)", () => {
  it("derives the provider from URL classification only", () => {
    expect(classifyProvider("https://www.google.com/recaptcha/api2/anchor?ar=1")).toBe("recaptcha");
    expect(classifyProvider("https://recaptcha.net/recaptcha/api.js")).toBe("recaptcha");
    expect(classifyProvider("https://challenges.cloudflare.com/turnstile/v0/g/x")).toBe("turnstile");
    expect(classifyProvider("https://hcaptcha.com/getcaptcha/abc")).toBe("hcaptcha");
    expect(classifyProvider("https://newassets.hcaptcha.com/captcha/v1/hcaptcha.html")).toBe("hcaptcha");
    expect(classifyProvider("https://www.google.com/maps/embed/v1?key=k")).toBe("unknown");
    expect(classifyProvider("https://example.com/recaptcha/api2/anchor")).toBe("unknown");
    expect(classifyProvider("not a url")).toBe("unknown");
    expect(classifyProvider("data:text/html,x")).toBe("unknown");
  });

  it("never disagrees with isChallengeFrameUrl about challenge hosts (pin, no drift)", () => {
    const corpus = [
      "https://www.google.com/recaptcha/api2/anchor?ar=1&k=KEY",
      "https://www.recaptcha.net/recaptcha/api2/bframe?x=1",
      "https://www.google.com/maps/embed/v1?key=k",
      "https://challenges.cloudflare.com/cf-turnstile-challenge",
      "https://hcaptcha.com/getcaptcha/abc",
      "https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html",
      "https://js.stripe.com/v3/other.js",
      "data:text/html,x",
      "https://example.com/recaptcha/api2/anchor",
    ];
    for (const u of corpus) {
      expect(classifyProvider(u) !== "unknown").toBe(isChallengeFrameUrl(u));
    }
  });

  it("maps observed statuses into the fixed outcome vocabulary", () => {
    expect(outcomeOf(200)).toBe("200");
    expect(outcomeOf(403)).toBe("403");
    expect(outcomeOf(429)).toBe("429");
    expect(outcomeOf(404)).toBe("other-status");
    expect(outcomeOf(502)).toBe("other-status");
  });
});

describe("per-attempt stage records (#451)", () => {
  beforeEach(() => {
    CAPTCHA_TRACE.resetForTests();
  });

  it("asset 404 vs verify 403 vs verify 429 produce distinguishable records", () => {
    const a = CAPTCHA_TRACE.observe({
      attemptId: "zl-t-a-1", clientId: "c-a", ts: T0,
      stage: "ASSET_LOAD", outcome: outcomeOf(404),
      url: "https://newassets.hcaptcha.com/captcha/v1/config", note: "widget asset",
    });
    const b1 = CAPTCHA_TRACE.observe({
      attemptId: "zl-t-b-1", clientId: "c-b", ts: T0 + 10,
      stage: "SUBMISSION", url: "https://hcaptcha.com/getcaptcha/site", note: "verify-family request",
    });
    const b2 = CAPTCHA_TRACE.observe({
      attemptId: "zl-t-b-1", clientId: "c-b", ts: T0 + 40,
      stage: "VERIFY_OUTCOME", outcome: "403", transport: "wisp",
      url: "https://hcaptcha.com/getcaptcha/site", note: "verify-family response",
    });
    const c1 = CAPTCHA_TRACE.observe({
      attemptId: "zl-t-c-1", clientId: "c-c", ts: T0 + 100,
      stage: "SUBMISSION", url: "https://www.google.com/recaptcha/api2/userverify",
    });
    const c2 = CAPTCHA_TRACE.observe({
      attemptId: "zl-t-c-1", clientId: "c-c", ts: T0 + 140,
      stage: "VERIFY_OUTCOME", outcome: "429", url: "https://www.google.com/recaptcha/api2/userverify",
    });
    expect(a).toBe("zl-t-a-1");
    expect(b1).toBe("zl-t-b-1");
    expect(b2).toBe("zl-t-b-1");
    expect(c1).toBe("zl-t-c-1");
    const s = snap();
    expect(s.attempts.length).toBe(3);
    const byId = new Map(s.attempts.map((x) => [x.attemptId, x]));
    /* the asset-404 flow: an ASSET_LOAD with an other-status outcome and no verdict */
    expect(byId.get("zl-t-a-1")!.stages).toEqual([
      { stage: "ASSET_LOAD", ts: T0, outcome: "other-status", url: "https://newassets.hcaptcha.com/captcha/v1/config", note: "widget asset" },
    ]);
    expect(byId.get("zl-t-a-1")!.closed).toBe(false);
    expect(byId.get("zl-t-a-1")!.provider).toBe("hcaptcha");
    /* the verify-403 flow: submission then outcome, closed, timed */
    const b = byId.get("zl-t-b-1")!;
    expect(b.stages.map((x) => [x.stage, x.outcome])).toEqual([["SUBMISSION", undefined], ["VERIFY_OUTCOME", "403"]]);
    expect(b.closed).toBe(true);
    expect(b.stages[1]!.ms).toBe(30);
    expect(b.stages[1]!.transport).toBe("wisp");
    /* the verify-429 flow: same shape, different outcome class */
    const c = byId.get("zl-t-c-1")!;
    expect(c.stages[1]!.outcome).toBe("429");
    expect(c.closed).toBe(true);
  });

  it("two concurrent clientIds never mix attempts (cross-session isolation)", () => {
    CAPTCHA_TRACE.observe({ attemptId: "zl-t-x-1", clientId: "sess-x", ts: T0, stage: "FRAME_HANDSHAKE", url: "https://www.google.com/recaptcha/api2/anchor?k=A" });
    CAPTCHA_TRACE.observe({ attemptId: "zl-t-y-1", clientId: "sess-y", ts: T0 + 1, stage: "FRAME_HANDSHAKE", url: "https://challenges.cloudflare.com/cf-turnstile-challenge" });
    /* later observations for each session land in their OWN attempt */
    CAPTCHA_TRACE.observe({ attemptId: "zl-t-x-2", clientId: "sess-x", ts: T0 + 5, stage: "ASSET_LOAD", outcome: "200", url: "https://www.google.com/recaptcha/api.js" });
    CAPTCHA_TRACE.observe({ attemptId: "zl-t-y-2", clientId: "sess-y", ts: T0 + 6, stage: "SUBMISSION", url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/flow/ov1/x" });
    const s = snap();
    expect(s.attempts.length).toBe(2);
    const x = s.attempts.filter((a) => a.clientId === "sess-x");
    const y = s.attempts.filter((a) => a.clientId === "sess-y");
    expect(x.length).toBe(1);
    expect(y.length).toBe(1);
    expect(x[0]!.provider).toBe("recaptcha");
    expect(y[0]!.provider).toBe("turnstile");
    /* no record crossed sessions: x never saw a submission, y never an asset */
    expect(x[0]!.stages.map((r) => r.stage)).toEqual(["FRAME_HANDSHAKE", "ASSET_LOAD"]);
    expect(y[0]!.stages.map((r) => r.stage)).toEqual(["FRAME_HANDSHAKE", "SUBMISSION"]);
    expect(x[0]!.attemptId).toBe("zl-t-x-1");
    expect(y[0]!.attemptId).toBe("zl-t-y-1");
  });

  it("same-client observations without an explicit id merge into the open attempt", () => {
    const first = CAPTCHA_TRACE.observe({ clientId: "c-m", ts: T0, stage: "FRAME_HANDSHAKE", url: "https://hcaptcha.com/getcaptcha/abc" });
    const second = CAPTCHA_TRACE.observe({ clientId: "c-m", ts: T0 + 20, stage: "SUBMISSION", url: "https://hcaptcha.com/getcaptcha/abc" });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    const s = snap();
    expect(s.attempts.length).toBe(1);
    expect(s.attempts[0]!.stages.map((r) => r.stage)).toEqual(["FRAME_HANDSHAKE", "SUBMISSION"]);
  });

  it("a closed attempt is never appended to; a later flow mints a fresh attempt", () => {
    const first = CAPTCHA_TRACE.observe({ attemptId: "zl-t-z-1", clientId: "c-z", ts: T0, stage: "VERIFY_OUTCOME", outcome: "403", url: "https://hcaptcha.com/getcaptcha/abc" });
    const second = CAPTCHA_TRACE.observe({ attemptId: "zl-t-z-1", clientId: "c-z", ts: T0 + 10, stage: "ASSET_LOAD", outcome: "200", url: "https://newassets.hcaptcha.com/x" });
    expect(first).toBe("zl-t-z-1");
    expect(second).not.toBe("zl-t-z-1");
    const s = snap();
    expect(s.attempts.length).toBe(2);
    expect(s.attempts.find((a) => a.attemptId === "zl-t-z-1")!.stages.length).toBe(1);
  });

  it("ring bounds: 64 attempts kept, oldest evicted, drop counters honest", () => {
    for (let i = 0; i < 70; i++) {
      CAPTCHA_TRACE.observe({ attemptId: "zl-t-r-" + i, ts: T0 + i, stage: "BOOTSTRAP_SEEN", url: "https://hcaptcha.com/getcaptcha/" + i });
    }
    const s = snap();
    expect(s.attempts.length).toBe(64);
    expect(s.droppedAttempts).toBe(6);
    const ids = new Set(s.attempts.map((a) => a.attemptId));
    expect(ids.has("zl-t-r-0")).toBe(false);
    expect(ids.has("zl-t-r-5")).toBe(false);
    expect(ids.has("zl-t-r-6")).toBe(true);
    expect(ids.has("zl-t-r-69")).toBe(true);
  });

  it("stage cap: 16 records kept per attempt, overwrite-oldest, counter honest", () => {
    for (let i = 0; i < 20; i++) {
      CAPTCHA_TRACE.observe({ attemptId: "zl-t-s-1", ts: T0 + i, stage: "ASSET_LOAD", url: "https://newassets.hcaptcha.com/" + i });
    }
    const s = snap();
    expect(s.attempts.length).toBe(1);
    const stages = s.attempts[0]!.stages;
    expect(stages.length).toBe(16);
    expect(s.droppedStages).toBe(4);
    /* the OLDEST records were evicted, the newest survive */
    expect(stages[0]!.url).toBe("https://newassets.hcaptcha.com/4");
    expect(stages[15]!.url).toBe("https://newassets.hcaptcha.com/19");
  });

  it("redacts hostile URLs and notes; no token/sitekey material is stored", () => {
    const hostile =
      "https://hcaptcha.com/getcaptcha/site?g-recaptcha-response=LEAK1&h-captcha-response=LEAK2&cf-turnstile-response=LEAK3&sitekey=LEAK4";
    CAPTCHA_TRACE.observe({
      attemptId: "zl-t-sec-1", ts: T0, stage: "SUBMISSION", url: hostile,
      note: "POST token=LEAK5 authorization: Bearer LEAK6",
    });
    CAPTCHA_TRACE.observe({
      attemptId: "zl-t-sec-2", ts: T0, stage: "VERIFY_OUTCOME", outcome: "403",
      url: "https://www.google.com/recaptcha/api2/userverify?c=LEAK7&reason=q",
    });
    const raw = JSON.stringify(snap());
    expect(raw).not.toContain("LEAK1");
    expect(raw).not.toContain("LEAK2");
    expect(raw).not.toContain("LEAK3");
    expect(raw).not.toContain("LEAK5");
    expect(raw).not.toContain("LEAK6");
    expect(raw).not.toContain("g-recaptcha-response=LEAK");
    expect(raw).toContain("[redacted]");
    /* non-secret query parts survive redactSecrets untouched */
    expect(raw).toContain("reason=q");
  });

  it("unobservable stages are recorded as explicitly unknown, never guessed", () => {
    CAPTCHA_TRACE.observe({ attemptId: "zl-t-u-1", clientId: "c-u", ts: T0, stage: "FRAME_HANDSHAKE", url: "https://challenges.cloudflare.com/cf-turnstile-challenge" });
    CAPTCHA_TRACE.markUnknown({ attemptId: "zl-t-u-1", ts: T0 + 30, stage: "SUBMISSION" });
    const s = snap();
    const stages = s.attempts[0]!.stages;
    expect(stages.length).toBe(2);
    expect(stages[1]).toMatchObject({ stage: "SUBMISSION", unknown: true });
    expect(stages[1]!.outcome).toBeUndefined();
    expect(stages[1]!.note).toBe("unknown");
  });

  it("an engine that never sees a challenge holds no trace state", () => {
    /* no buffers, timers or eager structures exist before the first
       captcha observation: the empty snapshot is empty counters only. */
    expect(snap()).toEqual({ attempts: [], droppedAttempts: 0, droppedStages: 0 });
    CAPTCHA_TRACE.observe({ attemptId: "zl-t-n-1", ts: T0, stage: "FRAME_HANDSHAKE", url: "https://challenges.cloudflare.com/x" });
    expect(snap().attempts.length).toBe(1);
    CAPTCHA_TRACE.resetForTests();
    expect(snap()).toEqual({ attempts: [], droppedAttempts: 0, droppedStages: 0 });
  });
});

/* Integration: the engine's own CHALLENGE emit points feed the trace. */
describe("challenge emit points feed the trace (#451)", () => {
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
    CAPTCHA_TRACE.resetForTests();
    transportMock.calls = 0;
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

  it("a Turnstile frame navigation records one FRAME_HANDSHAKE attempt", async () => {
    const { ev, armed } = mkEvent(
      ORIGIN + encodeDestLegacy("https://challenges.cloudflare.com/cf-turnstile-challenge?token=LEAK8"),
      "navigate",
      "frame",
      "",
    );
    handleFetch(ev);
    await armed[0]!;
    const s = snap();
    expect(s.attempts.length).toBe(1);
    const a = s.attempts[0]!;
    expect(a.provider).toBe("turnstile");
    expect(a.clientId).toBe("chal-1-new");
    expect(a.stages.map((r) => r.stage)).toEqual(["FRAME_HANDSHAKE"]);
    expect(a.stages[0]!.url).not.toContain("token=LEAK8");
    expect(a.stages[0]!.url).toContain("[redacted]");
  });

  it("a recaptcha anchor frame merges the co= repair and the frame observation into one attempt", async () => {
    const b64 = (s: string) => btoa(s).replace(/=+$/, (p) => ".".repeat(p.length));
    const anchor =
      "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=KEY&co=" + b64(ORIGIN + ":443") + "&v=V";
    const referrer = ORIGIN + encodeDestLegacy("https://www.google.com/sorry/ipblur");
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(anchor), "navigate", "iframe", referrer);
    handleFetch(ev);
    const served = await armed[0]!;
    expect(served.status).toBe(200);
    const s = snap();
    /* one flow, not two: the co= repair (frame destination -> handshake)
       and the #129 frame observation land in the same attempt */
    expect(s.attempts.length).toBe(1);
    const a = s.attempts[0]!;
    expect(a.provider).toBe("recaptcha");
    expect(a.attemptId).not.toBe("");
    expect(a.stages.map((r) => r.stage)).toEqual(["FRAME_HANDSHAKE", "FRAME_HANDSHAKE"]);
    /* recorded URLs passed through the shared redaction gate (the
       redaction contract test above pins the secret classes); here the
       non-secret shape is recorded verbatim. */
    for (const r of a.stages) expect(r.url).toContain("https://www.google.com/recaptcha/");
  });

  it("a recaptcha api.js SCRIPT load records ASSET_LOAD, not a handshake", async () => {
    const b64 = (s: string) => btoa(s).replace(/=+$/, (p) => ".".repeat(p.length));
    const anchor = "https://www.google.com/recaptcha/api.js?co=" + b64(ORIGIN + ":443");
    const referrer = ORIGIN + encodeDestLegacy("https://www.google.com/sorry/ipblur");
    const { ev, armed } = mkEvent(ORIGIN + encodeDestLegacy(anchor), "cors", "script", referrer);
    handleFetch(ev);
    await armed[0]!;
    const s = snap();
    expect(s.attempts.length).toBe(1);
    expect(s.attempts[0]!.stages.map((r) => r.stage)).toEqual(["ASSET_LOAD"]);
    expect(s.attempts[0]!.provider).toBe("recaptcha");
  });
});

/* Control plane: zl:captchaTrace is host-only, same gate class as
   zl:exportDiagnostics, and the registry/dispatch pinning in
   control.test.ts covers the label pairing. */
describe("zl:captchaTrace control message (#451)", () => {
  const mkMsgEvent = (sourceUrl: string, msg: ControlMessage) => {
    const posted: unknown[] = [];
    const ev = {
      data: msg,
      ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
      source: { url: sourceUrl, id: "c1" },
    } as unknown as ExtendableMessageEvent;
    return { ev, posted };
  };
  const deps = { ready: Promise.resolve(), persistRoute: async () => {} };

  beforeEach(() => {
    CAPTCHA_TRACE.resetForTests();
    vi.stubGlobal("self", { location: { origin: ORIGIN } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a host sender with the compact snapshot", async () => {
    CAPTCHA_TRACE.observe({ attemptId: "zl-t-h-1", clientId: "c-h", ts: T0, stage: "FRAME_HANDSHAKE", url: "https://hcaptcha.com/getcaptcha/abc" });
    const { ev, posted } = mkMsgEvent(ORIGIN + "/", { type: "zl:captchaTrace" });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([
      {
        ok: true,
        attempts: [{
          attemptId: "zl-t-h-1",
          clientId: "c-h",
          provider: "hcaptcha",
          startedAt: T0,
          closed: false,
          stages: [{ stage: "FRAME_HANDSHAKE", ts: T0, url: "https://hcaptcha.com/getcaptcha/abc" }],
        }],
        droppedAttempts: 0,
        droppedStages: 0,
      },
    ]);
  });

  it("refuses a proxied-page sender (host-only)", async () => {
    const { ev, posted } = mkMsgEvent(ORIGIN + "/j/someRouteToken", { type: "zl:captchaTrace" });
    await handleControlEvent(ev, deps);
    expect(posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });
});
