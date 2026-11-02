import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Control-plane torture suite (bug-scout round, coverage-guided).
   control.ts entered this round at 47.6% lines / 65.6% branches /
   57.1% functions never executed by any of the 2648 tests: the whole
   zl:find/downloads/recording/session/embedder block, the guest and
   relay registration arms, the wsOpen dark branches and every
   validation refusal was dark. Methodology matches the cookies and
   sw rounds: deterministic edge cases at the dark seams first, then
   a seeded differential fuzz through the dispatcher where every
   deviation must be classified - an unclassified deviation fails.

   The heavy leaves stay mocked exactly like control.test.ts (the
   transport seam, the ws bridge factories, the request pipeline's
   fetchers); the control plane itself, the cookie jar, the codec,
   the recording/session/download/doctor subsystems and the sender
   gate all run REAL. */

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  engineReady: async () => {},
  /* Real setPrimaryWisp validates ws(s):// or ""; mirror that so the
     zl:wispPrimary wiring tests exercise the control seam, not the
     transport's own validator (transport.test.ts owns that). */
  setPrimaryWisp: (u: unknown) =>
    u === "" || (typeof u === "string" && (u.startsWith("ws://") || u.startsWith("wss://"))),
  altRegister: () => {},
  altConfigured: () => false,
  wispTransport: {
    ready: () => transportState.readyImpl(),
    switchEngine: (e: string) => {
      transportState.switched.push(e);
    },
  },
}));

const transportState = vi.hoisted(() => ({
  readyImpl: async (): Promise<void> => {},
  switched: [] as string[],
}));

/* ws bridge factories captured: the torture must be able to prove a
   refused zl:wsOpen never reached the transport, and that whatever
   DID reach it carries only token-grammar protocol strings. */
const wsState = vi.hoisted(() => ({
  opens: [] as Array<{ port: unknown; url: string; protocols: unknown[]; headers: unknown }>,
  relayOpens: [] as Array<{ port: unknown; url: string; protocols: unknown[] }>,
  closeAllCount: 0,
}));
vi.mock("../ws-runtime", () => ({
  wsBridge: {
    open: (port: unknown, url: string, protocols: unknown[], headers?: unknown) => {
      wsState.opens.push({ port, url, protocols, headers });
    },
    closeAll: () => {
      wsState.closeAllCount++;
    },
  },
  wsRelayBridge: {
    open: (port: unknown, url: string, protocols: unknown[]) => {
      wsState.relayOpens.push({ port, url, protocols });
    },
    closeAll: () => {},
  },
}));

const reqState = vi.hoisted(() => ({
  cacheClears: 0,
  ghosteryStatus: 404,
  ghosteryBody: "",
}));
vi.mock("../request", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../request")>();
  return {
    ...mod,
    pageCacheClear: async () => {
      reqState.cacheClears++;
    },
    /* guestRegister script fetch: 404 by default (refusal path), a
       test flips it to 200 when it wants the accept path. */
    ghosteryListFetch: async () =>
      new Response(reqState.ghosteryBody, { status: reqState.ghosteryStatus }),
  };
});

/* The extension dispatcher is captured (not run): its registry stays
   real so routing is exercised, its machinery has its own suites. */
const extState = vi.hoisted(() => ({ dispatched: [] as unknown[] }));
vi.mock("../extensions/control", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../extensions/control")>();
  return {
    ...mod,
    dispatchExtControl: (msg: unknown, ctx: { reply: (d: unknown) => void }) => {
      extState.dispatched.push(msg);
      ctx.reply({ ok: true, ext: true });
    },
  };
});

import { handleControlEvent, type ControlMessage } from "../control";
import { currentPrefix, encodeDest, isEnginePath, setScheme } from "../codec";
import { senderIsHostPage } from "../cpgate";
import { DIAG } from "../diag";
import { setTracing, tracingSnapshot } from "../tracing";
import { encryptSession } from "../session";

const ORIGIN = "https://w.example.org";

/* ---- harness -------------------------------------------------------- */

let clientSeq = 0;
const mkPort = () => {
  const state = { posted: [] as unknown[], closed: false };
  const port = {
    postMessage: (p: unknown) => {
      if (!state.closed) state.posted.push(p);
    },
    close: () => {
      state.closed = true;
    },
    onmessage: null as ((ev: { data: unknown }) => void) | null,
  };
  return { port, state };
};

const mkEvent = (
  sourceUrl: string | null,
  msg: unknown,
  opts: { withPort?: boolean; sourceId?: string } = {},
) => {
  const { withPort = true, sourceId } = opts;
  const p = withPort ? mkPort() : null;
  const waits: Promise<unknown>[] = [];
  const ev = {
    data: msg,
    ports: p ? [p.port] : [],
    source: sourceUrl === null ? null : { url: sourceUrl, id: sourceId ?? `c${++clientSeq}` },
    waitUntil: (pr: Promise<unknown>) => {
      waits.push(pr);
    },
  } as unknown as ExtendableMessageEvent;
  return {
    ev,
    posted: p ? p.state.posted : [],
    port: p?.port ?? null,
    portState: p?.state ?? { posted: [] as unknown[], closed: false },
    waits,
  };
};

const fetchState = { status: 200, body: "/* finder stub */" };

/* selfOver merges into the worker self stand-in; globalOver replaces
   standalone globals (caches) - conflating them silently drops the
   override, which is exactly the kind of harness bug this suite
   exists to not have. */
const stubGlobals = (
  selfOver: Record<string, unknown> = {},
  globalOver: { caches?: unknown } = {},
) => {
  vi.stubGlobal("self", {
    location: { origin: ORIGIN, host: "w.example.org", href: ORIGIN + "/sw.js" },
    registration: { scope: ORIGIN + "/", unregister: async () => {} },
    clients: { get: async () => undefined, matchAll: async () => [] },
    ...selfOver,
  });
  vi.stubGlobal("fetch", async () => new Response(fetchState.body, { status: fetchState.status }));
  vi.stubGlobal(
    "caches",
    globalOver.caches ?? { keys: async () => ["zeolite-page-v1"], delete: async () => true },
  );
};

const mkDeps = () => ({
  ready: Promise.resolve(),
  persistRoute: vi.fn(async () => {}),
});

const hostEvent = (msg: unknown, opts?: Parameters<typeof mkEvent>[2]) =>
  mkEvent(ORIGIN + "/", msg, opts);
/* A proxied page whose route decodes to the given origin. */
const pageEvent = (destOrigin: string, msg: unknown) =>
  mkEvent(ORIGIN + encodeDest(destOrigin + "/"), msg);

/* RFC 6455 token grammar: the charset native WebSocket accepts in
   subprotocol positions. The differential oracle for the fuzz. */
const WS_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,255}$/;

/* The route-prefix grammar the fixed engine must enforce; the fuzz
   oracle mirrors it exactly, so any deviation is a classification
   failure, not a judgement call. */
const SCHEME_PREFIX = /^\/[A-Za-z0-9_-]{1,32}\/$/;
const RESERVED_SEGMENTS = new Set(["__zl_nav__", "__zl_navh__", "zl-ext", "zl-cs", "zlsw-register"]);
const schemePrefixValid = (p: unknown): p is string => {
  if (typeof p !== "string" || !SCHEME_PREFIX.test(p)) return false;
  const seg = p.slice(1, -1);
  return !seg.startsWith("__zl") && !RESERVED_SEGMENTS.has(seg);
};

/* Deterministic LCG (mulberry32) - the same seeded shape as the
   cookies and sw torture rounds. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

beforeEach(() => {
  stubGlobals();
  setScheme("/j/");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ---- A. route-prefix poisoning --------------------------------------
   setScheme never validated anything: zl:config {prefix:""} (or "/",
   "j", "/a/b/", a reserved engine root) was applied with ok:true,
   persisted into route-config, and restored on every boot. "" and
   "/" collapse isEnginePath to true for EVERY same-origin path, so
   the host's own pages become "proxied pages": the host-only gate
   refuses zl:config itself, zl:doctor included - a permanent,
   restart-surviving lockout the operator cannot debug. */

describe("A. zl:config prefix validation (the engine-path collapse)", () => {
  it.each([
    ["empty string (every path becomes an engine path)", ""],
    ["root slash (same collapse)", "/"],
    ["slash-less segment", "j"],
    ["missing trailing slash", "/j"],
    ["multi-segment", "/a/b/"],
    ["reserved navh root", "/__zl_navh__/"],
    ["reserved nav marker root", "/__zl_nav__/"],
    ["reserved extension root", "/zl-ext/"],
    ["reserved content-script root", "/zl-cs/"],
    ["reserved boot-page root", "/zlsw-register/"],
    ["asset collision (dot passes nothing else)", "/sw.js/"],
    ["whitespace", "/a b/"],
    ["non-ASCII", "/été/"],
    ["too long segment", "/" + "a".repeat(33) + "/"],
    ["non-string", 42],
  ])("refuses prefix %s", async (_name, prefix) => {
    const ev = hostEvent({ type: "zl:config", prefix });
    const deps = mkDeps();
    await handleControlEvent(ev.ev, deps);
    const reply = ev.posted[0] as { ok: boolean; error?: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/prefix/i);
    expect(currentPrefix()).toBe("/j/");
    expect(deps.persistRoute).not.toHaveBeenCalled();
  });

  it.each([["default shape", "/j/"], ["alternate", "/k/"], ["mixed charset", "/A-b_0/"]])(
    "accepts and applies %s",
    async (_name, prefix) => {
      const ev = hostEvent({ type: "zl:config", prefix });
      const deps = mkDeps();
      await handleControlEvent(ev.ev, deps);
      const reply = ev.posted[0] as { ok: boolean; prefix: string };
      expect(reply.ok).toBe(true);
      expect(reply.prefix).toBe(prefix);
      expect(currentPrefix()).toBe(prefix);
      expect(deps.persistRoute).toHaveBeenCalledWith(prefix);
    },
  );

  it("a poisoned empty prefix must not lock the host out of its own control plane", async () => {
    const bad = hostEvent({ type: "zl:config", prefix: "" });
    await handleControlEvent(bad.ev, mkDeps());
    /* The lockout demonstration: with prefix "" applied, the host page
       at "/" classifies as a proxied page, so even zl:doctor - the
       tool that exists to diagnose a wedged engine - is refused. */
    const doc = hostEvent({ type: "zl:doctor" });
    await handleControlEvent(doc.ev, mkDeps());
    const reply = doc.posted[0] as { ok: boolean; error?: string };
    expect(reply.error).not.toBe("host-only control message");
    expect(isEnginePath("/devtools.html")).toBe(false);
    expect(isEnginePath("/bootstrap.js")).toBe(false);
    expect(senderIsHostPage("/devtools.html", ORIGIN)).toBe(true);
  });

  it("a refused config changes no other knob (atomic refusal)", async () => {
    /* httpsUpgrade and imageLazy both default true - the pin is that
       a refused prefix leaves EVERY knob exactly as it was, so the
       payload's imageLazy:false must never land. */
    const ev = hostEvent({ type: "zl:config", prefix: "", httpsUpgrade: false, imageLazy: false });
    await handleControlEvent(ev.ev, mkDeps());
    expect((ev.posted[0] as { ok: boolean }).ok).toBe(false);
    const ping = hostEvent({ type: "zl:ping" });
    await handleControlEvent(ping.ev, mkDeps());
    const reply = ping.posted[0] as { httpsUpgrade: boolean; imageLazy: boolean };
    expect(reply.httpsUpgrade).toBe(true);
    expect(reply.imageLazy).toBe(true);
  });

  it("the restore arms fall back to the default shape for a poisoned persisted value", () => {
    /* The KDL/legacy restore paths delegate to the same validated
        setScheme; the codec contract is pinned here (the full
        sw.ts re-import suites own the cache arms end to end). */
    expect(setScheme("")).toBe(false);
    expect(setScheme("/")).toBe(false);
    expect(setScheme("/__zl_navh__/")).toBe(false);
    expect(setScheme("/j/")).toBe(true);
    expect(currentPrefix()).toBe("/j/");
    expect(isEnginePath("/devtools.html")).toBe(false);
  });
});

/* ---- B. zl:wsOpen protocol tokens -----------------------------------
   msg.protocols is page-controlled and passed to the transport
   handshake verbatim. Native WebSocket throws SyntaxError for
   non-token subprotocols; the control plane happily forwarded
   CRLF-bearing strings (header-injection-shaped input for the
   vendored ws client), non-strings and duplicates. */

describe("B. zl:wsOpen protocol token validation", () => {
  const wsOpen = (protocols: unknown) =>
    hostEvent({ type: "zl:wsOpen", url: "wss://ws.example.org/socket", protocols });

  it.each([
    ["CRLF header-injection shape", ["chat\r\nX-Evil: 1"]],
    ["non-string element", ["chat", 7]],
    ["object element", [{}]],
    ["duplicate tokens", ["a", "a"]],
    ["empty-string token", [""]],
    ["over-long token", ["x".repeat(256)]],
  ])("refuses %s without touching the transport", async (_name, protocols) => {
    wsState.opens.length = 0;
    const ev = wsOpen(protocols);
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([
      { ev: "error", error: "bad zl:wsOpen" },
      { ev: "close", code: 1006, clean: false },
    ]);
    expect(ev.portState.closed).toBe(true);
    expect(wsState.opens).toHaveLength(0);
  });

  it.each([
    ["empty array", []],
    ["single token", ["chat"]],
    ["full token charset", ["!#$%&'*+-.^_`|~0Az"]],
    ["several tokens", ["chat", "superchat"]],
  ])("bridges %s verbatim", async (_name, protocols) => {
    wsState.opens.length = 0;
    const ev = wsOpen(protocols);
    await handleControlEvent(ev.ev, mkDeps());
    expect(wsState.opens).toHaveLength(1);
    expect(wsState.opens[0]!.protocols).toEqual(protocols);
    expect(wsState.opens[0]!.url).toBe("wss://ws.example.org/socket");
  });

  it("a non-array protocols value stays the documented empty coercion (never a string spread)", async () => {
    wsState.opens.length = 0;
    const ev = wsOpen("chat\r\nX-Evil: 1");
    await handleControlEvent(ev.ev, mkDeps());
    expect(wsState.opens).toHaveLength(1);
    expect(wsState.opens[0]!.protocols).toEqual([]);
  });
});

/* ---- C. zl:teardown honesty ----------------------------------------- */

describe("C. zl:teardown", () => {
  it("an unregister rejection stays a bounded diagnostic, never an escaping rejection", async () => {
    stubGlobals(
      {
        registration: {
          scope: ORIGIN + "/",
          unregister: async () => {
            throw new Error("storage poisoned");
          },
        },
      },
    );
    const ev = hostEvent({ type: "zl:teardown" });
    const deps = mkDeps();
    await handleControlEvent(ev.ev, deps);
    for (const w of ev.waits) {
      let escaped: unknown = null;
      await Promise.resolve(w).catch((e) => {
        escaped = e;
      });
      /* The reply already said ok:true; the unregister failure must
         surface as a diagnostic, not as an unhandled rejection the
         browser logs after the event lifetime ended. */
      expect(escaped).toBeNull();
    }
    expect(ev.posted).toContainEqual({ ok: true });
    expect(DIAG.eventsSince(0).some((d) => d.message === "teardown unregister failed")).toBe(true);
  });

  it("a Cache Storage failure fails honestly before the ok", async () => {
    stubGlobals(
      {},
      {
        caches: {
          keys: async () => {
            throw new Error("no cache storage");
          },
          delete: async () => true,
        },
      },
    );
    const ev = hostEvent({ type: "zl:teardown" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([]);
    for (const w of ev.waits) {
      await expect(w).rejects.toBeInstanceOf(Error);
    }
  });

  it("the happy path closes bridged sockets and drops every owned cache", async () => {
    wsState.closeAllCount = 0;
    const dropped: string[] = [];
    stubGlobals(
      {},
      {
        caches: {
          keys: async () => ["zeolite-page-v1", "zeolite-route-v1"],
          delete: async (n: string) => {
            dropped.push(n);
            return true;
          },
        },
      },
    );
    const ev = hostEvent({ type: "zl:teardown" });
    await handleControlEvent(ev.ev, mkDeps());
    for (const w of ev.waits) await w;
    expect(wsState.closeAllCount).toBe(1);
    expect(dropped.sort()).toEqual(["zeolite-page-v1", "zeolite-route-v1"]);
    expect(ev.posted).toContainEqual({ ok: true });
  });
});

/* ---- D. dark-region honest-answer battery --------------------------- */

describe("D1. embedder handshake (#107 phase 2)", () => {
  it("getEmbedder fails closed (null origin) before any registration", async () => {
    const ev = pageEvent("https://frame.example", { type: "zl:getEmbedder" });
    await handleControlEvent(ev.ev, mkDeps());
    const reply = ev.posted[0] as { ok: boolean; origin: string | null };
    expect(reply.ok).toBe(true);
    expect(reply.origin).toBeNull();
  });

  it("registers a clean https origin and refuses anything else", async () => {
    const ok = hostEvent({ type: "zl:embedderOrigin", origin: "https://app.example" });
    await handleControlEvent(ok.ev, mkDeps());
    expect(ok.posted).toEqual([{ ok: true }]);
    for (const bad of ["https://app.example/x", "http://app.example", "garbage", "", 42, "https://"]) {
      const ev = hostEvent({ type: "zl:embedderOrigin", origin: bad });
      await handleControlEvent(ev.ev, mkDeps());
      expect(ev.posted).toEqual([{ ok: false, error: "bad zl:embedderOrigin" }]);
    }
  });

  it("getEmbedder answers a proxied frame with the registered origin and its own decoded URL", async () => {
    const ev = pageEvent("https://frame.example", { type: "zl:getEmbedder" });
    await handleControlEvent(ev.ev, mkDeps());
    const reply = ev.posted[0] as { ok: boolean; origin: string | null; url: string | null; clientId: string | null };
    expect(reply.ok).toBe(true);
    expect(reply.origin).toBe("https://app.example");
    expect(reply.url).toBe("https://frame.example/");
    expect(typeof reply.clientId).toBe("string");
  });
});

describe("D2. zl:fingerprint cache-drop (#377)", () => {
  it("a profile-key change drops the page cache; a repeat does not", async () => {
    /* The drop is keyed on the RAW profile value (JSON), independent
       of whether swstate accepts the profile - that is the #377
       contract: whatever the host pushes next never shares the old
       profile's cached pages. */
    const before = reqState.cacheClears;
    const first = hostEvent({ type: "zl:fingerprint", profile: { userAgent: "A/1" } });
    await handleControlEvent(first.ev, mkDeps());
    expect(reqState.cacheClears).toBe(before + 1);
    const again = hostEvent({ type: "zl:fingerprint", profile: { userAgent: "A/1" } });
    await handleControlEvent(again.ev, mkDeps());
    expect(reqState.cacheClears).toBe(before + 1);
    const other = hostEvent({ type: "zl:fingerprint", profile: null });
    await handleControlEvent(other.ev, mkDeps());
    expect(reqState.cacheClears).toBe(before + 2);
  });
});

describe("D3. session recording (#29/1.9)", () => {
  afterEach(async () => {
    /* `rec` and the forced tracing side effect are module state; a
       leftover recording would bleed into every later describe. */
    const stop = hostEvent({ type: "zl:recordStop" });
    try {
      await handleControlEvent(stop.ev, mkDeps());
    } catch {
      /* already stopped */
    }
    setTracing(false);
  });

  it("refuses stop without a start, start without a stop, and double start", async () => {
    const stop = hostEvent({ type: "zl:recordStop" });
    await handleControlEvent(stop.ev, mkDeps());
    expect(stop.posted).toEqual([{ ok: false, error: "no recording active" }]);

    const start = hostEvent({ type: "zl:recordStart" });
    await handleControlEvent(start.ev, mkDeps());
    expect((start.posted[0] as { ok: boolean }).ok).toBe(true);

    const again = hostEvent({ type: "zl:recordStart" });
    await handleControlEvent(again.ev, mkDeps());
    expect((again.posted[0] as { ok: false; error: string }).error).toMatch(/^recording already active/);
  });

  it("start forces tracing on and stop restores the prior choice", async () => {
    expect(tracingSnapshot(0).enabled).toBe(false);
    const start = hostEvent({ type: "zl:recordStart", recId: "sess-1" });
    await handleControlEvent(start.ev, mkDeps());
    expect((start.posted[0] as { record: { id: string } }).record.id).toBe("sess-1");
    expect(tracingSnapshot(0).enabled).toBe(true);
    const stop = hostEvent({ type: "zl:recordStop" });
    await handleControlEvent(stop.ev, mkDeps());
    const reply = stop.posted[0] as { ok: boolean; record: { id: string; netEntries: unknown[] } };
    expect(reply.ok).toBe(true);
    expect(reply.record.id).toBe("sess-1");
    expect(tracingSnapshot(0).enabled).toBe(false);
  });

  it("a garbage recId degrades to the generated id, never an error", async () => {
    const start = hostEvent({ type: "zl:recordStart", recId: 42 });
    await handleControlEvent(start.ev, mkDeps());
    const reply = start.posted[0] as { ok: boolean; record: { id: string } };
    expect(reply.ok).toBe(true);
    expect(reply.record.id).toMatch(/^rec-/);
    const stop = hostEvent({ type: "zl:recordStop" });
    await handleControlEvent(stop.ev, mkDeps());
    expect((stop.posted[0] as { ok: boolean }).ok).toBe(true);
  });
});

describe("D4. downloads registry (#118)", () => {
  it("answers the snapshot newest-first", async () => {
    const ev = hostEvent({ type: "zl:downloads" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted[0]).toMatchObject({ ok: true, downloads: [] });
  });

  it.each([
    ["cancel", "zl:cancelDownload"],
    ["pause", "zl:pauseDownload"],
    ["resume", "zl:resumeDownload"],
    ["save", "zl:saveDownload"],
  ])("%s refuses a non-string id", async (_name, type) => {
    const ev = hostEvent({ type, id: 7 });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, error: "missing id" }]);
  });

  it("resume and save answer through waitUntil for an unknown id", async () => {
    const resume = hostEvent({ type: "zl:resumeDownload", id: "nope" });
    await handleControlEvent(resume.ev, mkDeps());
    for (const w of resume.waits) await w;
    expect((resume.posted[0] as { ok: boolean }).ok).toBe(false);

    const save = hostEvent({ type: "zl:saveDownload", id: "nope" });
    await handleControlEvent(save.ev, mkDeps());
    for (const w of save.waits) await w;
    expect(save.posted[0]).toEqual({ ok: false, error: "no buffered artifact for this entry" });
  });
});

describe("D5. encrypted session export/import (#599-class honesty)", () => {
  const PASS = "long-enough-passphrase";

  it("refuses a short passphrase", async () => {
    const ev = hostEvent({ type: "zl:exportSession", passphrase: "short" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([
      { ok: false, error: "passphrase must be at least 8 characters" },
    ]);
  });

  it("exports a ciphertext session container and never the passphrase", async () => {
    const ev = hostEvent({ type: "zl:exportSession", passphrase: PASS, extra: { note: "x" } });
    await handleControlEvent(ev.ev, mkDeps());
    for (const w of ev.waits) await w;
    const reply = ev.posted[0] as { ok: boolean; blob: { zlSession: number } };
    expect(reply.ok).toBe(true);
    /* The blob is the structured-clone session container, ciphertext
       inside; the passphrase never appears in the reply. */
    expect(reply.blob.zlSession).toBe(1);
    expect(JSON.stringify(ev.posted)).not.toContain(PASS);
  });

  it("refuses a missing passphrase or blob on import", async () => {
    const ev = hostEvent({ type: "zl:importSession" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, error: "missing passphrase or blob" }]);
  });

  it("a wrong passphrase or corrupt blob answers an honest error", async () => {
    const ev = hostEvent({
      type: "zl:importSession",
      passphrase: PASS,
      blob: new Blob(["garbage"]),
    });
    await handleControlEvent(ev.ev, mkDeps());
    for (const w of ev.waits) await w;
    expect((ev.posted[0] as { ok: boolean }).ok).toBe(false);
  });

  it("a session without a cookies array is refused, not coerced", async () => {
    const blob = await encryptSession(PASS, { cookies: "nope", extra: null });
    const ev = hostEvent({ type: "zl:importSession", passphrase: PASS, blob });
    await handleControlEvent(ev.ev, mkDeps());
    for (const w of ev.waits) await w;
    expect(ev.posted[0]).toMatchObject({ ok: false });
    expect((ev.posted[0] as { error: string }).error).toMatch(/no cookies in session blob/);
  });

  it("merge mode with a bogus conflict rule degrades to keep-existing", async () => {
    const blob = await encryptSession(PASS, {
      cookies: [["https://merge.example/", ["m=1"]]],
      extra: null,
    });
    const ev = hostEvent({
      type: "zl:importSession",
      passphrase: PASS,
      blob,
      mode: "merge",
      rule: "bogus-rule",
    });
    await handleControlEvent(ev.ev, mkDeps());
    for (const w of ev.waits) await w;
    const reply = ev.posted[0] as { ok: boolean; merged: unknown };
    expect(reply.ok).toBe(true);
    expect(reply.merged).toBeDefined();
  });
});

describe("D6. jar knobs and netlog cursors", () => {
  it("zl:sameSite echoes the effective policy for an unknown knob value", async () => {
    const ev = hostEvent({ type: "zl:sameSite", policy: "bogus" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted[0]).toMatchObject({ ok: true, policy: "off" });
  });

  it("zl:getNetLog treats a non-numeric since as an empty delta with a truthful cursor", async () => {
    const ev = hostEvent({ type: "zl:getNetLog", since: "garbage" });
    await handleControlEvent(ev.ev, mkDeps());
    const reply = ev.posted[0] as { entries: unknown[]; lastSeq: number; generation: number };
    expect(reply.entries).toEqual([]);
    expect(typeof reply.lastSeq).toBe("number");
    expect(typeof reply.generation).toBe("number");
  });

  it("zl:getNetLog slices a hostile clientId to 256 chars", async () => {
    const long = "c".repeat(400);
    const ev = hostEvent({ type: "zl:getNetLog", since: 0, clientId: long });
    await handleControlEvent(ev.ev, mkDeps());
    const reply = ev.posted[0] as { clientId: string };
    expect(reply.clientId).toBe(long.slice(0, 256));
  });

  it("zl:getDiag answers the delta shape with a generation", async () => {
    const ev = hostEvent({ type: "zl:getDiag", since: 0 });
    await handleControlEvent(ev.ev, mkDeps());
    const reply = ev.posted[0] as { ok: boolean; generation: number };
    expect(reply.ok).toBe(true);
    expect(typeof reply.generation).toBe("number");
  });
});

describe("D7. guest kernel registration arms (#477)", () => {
  it("zl:guestRegister refuses an unverified page or missing script URL with a bounded diagnostic", async () => {
    const ev = pageEvent("https://g.example", { type: "zl:guestRegister" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted[0]).toMatchObject({ ok: false });
    expect((ev.posted[0] as { error: string }).error).toMatch(/verified page and a script URL/);
    expect(
      DIAG.eventsSince(0).some((d) => d.message === "guest register rejected"),
    ).toBe(true);
  });

  it("zl:guestRegister answers a canonical-registration rejection with the TypeError text", async () => {
    const ev = pageEvent("https://g.example", { type: "zl:guestRegister", scriptURL: "::not a url::" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted[0]).toMatchObject({ ok: false });
    expect((ev.posted[0] as { error: string }).error.length).toBeGreaterThan(0);
  });

  it("host zl:guestSpawn with empty fields is refused honestly by the kernel", async () => {
    const ev = hostEvent({ type: "zl:guestSpawn" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toHaveLength(1);
    expect((ev.posted[0] as { ok: boolean }).ok).toBe(false);
  });

  it.each([
    ["zl:guestHost", "guest host registration needs a port"],
    ["zl:relayRegister", "relay registration needs a port"],
  ])("%s without a port is refused silently (nothing to answer on)", async (type) => {
    /* The reply rides e.ports[0]; with no port the refusal is
       inherently silent - the branch is defense, not an answer
       path. The pin: no crash, no waitUntil armed, and the relay
       kernel never flips available. */
    const ev = {
      data: { type },
      ports: [],
      source: { url: ORIGIN + "/", id: "c-np-" + type },
      waitUntil: () => {
        throw new Error("no lifetime extension expected");
      },
    } as unknown as ExtendableMessageEvent;
    await expect(handleControlEvent(ev, mkDeps())).resolves.toBeUndefined();
    const probe = hostEvent({ type: "zl:wsOpen", url: "wss://x.example.org/s", protocols: [] });
    wsState.relayOpens.length = 0;
    await handleControlEvent(probe.ev, mkDeps());
    expect(wsState.relayOpens).toHaveLength(0);
  });

  it("zl:guestHost with a port registers and answers ok", async () => {
    const ev = hostEvent({ type: "zl:guestHost" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: true }]);
  });

  it("zl:guestUnregister refuses an unverifiable page and answers ok for its own origin", async () => {
    /* An undecodable sender has no verified page: refusal. */
    const undecodable = mkEvent(ORIGIN + "/j/abc", {
      type: "zl:guestUnregister",
      scriptURL: "https://g.example/sw.js",
      scope: "/",
    });
    await handleControlEvent(undecodable.ev, mkDeps());
    expect(undecodable.posted[0]).toMatchObject({ ok: false });
    /* A decodable sender addresses its OWN origin only; unregistering
       an unknown scope is a successful no-op by kernel design. */
    const own = pageEvent("https://g.example", {
      type: "zl:guestUnregister",
      scriptURL: "https://g.example/sw.js",
      scope: "/",
    });
    await handleControlEvent(own.ev, mkDeps());
    expect((own.posted[0] as { ok: boolean }).ok).toBe(true);
  });
});

describe("D8. wisp endpoints and auth (#168/#496)", () => {
  it("zl:wispPrimary accepts a ws(s) url, persists, and refuses garbage", async () => {
    const ok = hostEvent({ type: "zl:wispPrimary", url: "wss://wisp.example/ep" });
    const deps = mkDeps();
    await handleControlEvent(ok.ev, deps);
    expect(ok.posted).toEqual([{ ok: true }]);
    expect(deps.persistRoute).toHaveBeenCalledTimes(1);

    const bad = hostEvent({ type: "zl:wispPrimary", url: "http://wisp.example" });
    await handleControlEvent(bad.ev, mkDeps());
    expect(bad.posted).toEqual([
      { ok: false, error: "primary wisp needs a ws(s):// url or an empty string" },
    ]);
  });

  it("zl:wispRegister accepts, persists, and refuses non-ws schemes", async () => {
    const ok = hostEvent({ type: "zl:wispRegister", url: "wss://alt.example" });
    const deps = mkDeps();
    await handleControlEvent(ok.ev, deps);
    expect(ok.posted).toEqual([{ ok: true }]);
    expect(deps.persistRoute).toHaveBeenCalledTimes(1);

    const bad = hostEvent({ type: "zl:wispRegister", url: "https://alt.example" });
    await handleControlEvent(bad.ev, mkDeps());
    expect(bad.posted).toEqual([
      { ok: false, error: "wisp registration needs a ws(s):// url or an empty string" },
    ]);
  });

  it("zl:wispAuth clears, refuses a bogus op, and never echoes the secret", async () => {
    const clear = hostEvent({ type: "zl:wispAuth", wispAuth: { op: "clear" } });
    await handleControlEvent(clear.ev, mkDeps());
    expect((clear.posted[0] as { ok: boolean }).ok).toBe(true);

    const bogus = hostEvent({ type: "zl:wispAuth", wispAuth: { op: "bogus" } });
    await handleControlEvent(bogus.ev, mkDeps());
    expect(bogus.posted[0]).toMatchObject({ ok: false });

    const missing = hostEvent({ type: "zl:wispAuth" });
    await handleControlEvent(missing.ev, mkDeps());
    expect((missing.posted[0] as { ok: boolean }).ok).toBe(true);
  });
});

describe("D9. engine selection, loading, tracing and site routing", () => {
  it("zl:transport polls the restored engine, refuses a bogus one, and switches a valid one", async () => {
    transportState.switched.length = 0;
    const poll = hostEvent({ type: "zl:transport" });
    await handleControlEvent(poll.ev, mkDeps());
    expect(poll.posted).toEqual([{ ok: true, engine: "libcurl" }]);

    const bad = hostEvent({ type: "zl:transport", engine: "curl" });
    await handleControlEvent(bad.ev, mkDeps());
    expect(bad.posted).toEqual([{ ok: false, error: "transport needs engine libcurl|epoxy" }]);

    const good = hostEvent({ type: "zl:transport", engine: "epoxy" });
    await handleControlEvent(good.ev, mkDeps());
    expect(good.posted).toEqual([{ ok: true, engine: "libcurl" }]);
    expect(transportState.switched).toEqual(["epoxy"]);
  });

  it("zl:loadState answers inflight/stream counts without enumerating other sites", async () => {
    const ev = hostEvent({ type: "zl:loadState", host: "h.example" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted[0]).toMatchObject({ ok: true, inflight: 0, streams: 0 });
  });

  it("zl:tracing toggles and echoes; getTracing carries the generation", async () => {
    const on = hostEvent({ type: "zl:tracing", enabled: true });
    await handleControlEvent(on.ev, mkDeps());
    expect(on.posted).toEqual([{ ok: true, enabled: true }]);
    const off = hostEvent({ type: "zl:tracing", enabled: false });
    await handleControlEvent(off.ev, mkDeps());
    expect(off.posted).toEqual([{ ok: true, enabled: false }]);

    const get = hostEvent({ type: "zl:getTracing", since: 0 });
    await handleControlEvent(get.ev, mkDeps());
    expect(get.posted[0]).toMatchObject({ ok: true });
    expect(typeof (get.posted[0] as { generation: number }).generation).toBe("number");
  });

  it("zl:siteRoute refuses a missing site", async () => {
    const ev = hostEvent({ type: "zl:siteRoute" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, error: "missing site" }]);
  });

  it("extension control types route to the extension dispatcher, never the core switch", async () => {
    extState.dispatched.length = 0;
    const ev = hostEvent({ type: "zl:listExt" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(extState.dispatched).toHaveLength(1);
    expect(ev.posted).toEqual([{ ok: true, ext: true }]);
  });
});

describe("D10. zl:docCookie port (#35/#534)", () => {
  it("a portless call is silent by construction; an unverifiable sender is refused", async () => {
    const noPort = mkEvent(ORIGIN + encodeDest("https://d.example/"), { type: "zl:docCookie", set: "a=1" }, { withPort: false });
    await handleControlEvent(noPort.ev, mkDeps());
    expect(noPort.posted).toEqual([]);
    expect(noPort.waits).toHaveLength(0);

    const undecodable = mkEvent(ORIGIN + "/j/abc", { type: "zl:docCookie", set: "a=1" });
    await handleControlEvent(undecodable.ev, mkDeps());
    expect(undecodable.posted).toEqual([{ ok: false, error: "bad zl:docCookie" }]);
  });

  it("serves the initial view, follow-up port writes, and cookieStore ops with rid echo", async () => {
    const ev = pageEvent("https://d.example", { type: "zl:docCookie", set: "a=1" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted[0]).toMatchObject({ ok: true, cookie: "a=1" });

    (ev.port as unknown as { onmessage: (ev2: { data: unknown }) => void }).onmessage({
      data: { set: "b=2" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(ev.posted[1]).toMatchObject({ ok: true, cookie: "a=1; b=2" });

    (ev.port as unknown as { onmessage: (ev2: { data: unknown }) => void }).onmessage({
      data: { cs: { op: "getAll", rid: 7 } },
    });
    await new Promise((r) => setTimeout(r, 0));
    const cs = ev.posted[2] as { rid: number; items: unknown };
    expect(cs.rid).toBe(7);
    expect(Array.isArray(cs.items)).toBe(true);
  });
});

describe("D11. zl:wsOpen dark branches", () => {
  it("an unavailable transport closes the port honestly with 1006", async () => {
    transportState.readyImpl = async () => {
      throw new Error("no wisp");
    };
    try {
      const ev = hostEvent({ type: "zl:wsOpen", url: "wss://ws.example.org/s", protocols: [] });
      await handleControlEvent(ev.ev, mkDeps());
      expect(ev.posted).toEqual([
        { ev: "error", error: "transport unavailable" },
        { ev: "close", code: 1006, clean: false },
      ]);
      expect(ev.portState.closed).toBe(true);
    } finally {
      transportState.readyImpl = async () => {};
    }
  });

  it("an engine-local ws URL with no recoverable home closes honestly", async () => {
    const ev = mkEvent(null, { type: "zl:wsOpen", url: "wss://w.example.org/j/xyz", protocols: [] });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([
      { ev: "error", error: "unknown ws context" },
      { ev: "close", code: 1006, clean: false },
    ]);
    expect(ev.portState.closed).toBe(true);
  });

  it("an engine-local ws URL retargets to the sender's own virtual origin", async () => {
    wsState.opens.length = 0;
    wsState.relayOpens.length = 0;
    /* The sender's route decodes to https://page.example/, so an
       engine-local ws URL with a decodable route tail resolves
       against that origin, never the engine's own. */
    const ev = mkEvent(ORIGIN + encodeDest("https://page.example/"), {
      type: "zl:wsOpen",
      url: "wss://w.example.org" + encodeDest("https://page.example/socket"),
      protocols: [],
    });
    await handleControlEvent(ev.ev, mkDeps());
    expect(wsState.opens).toHaveLength(1);
    expect(wsState.opens[0]!.url).toBe("wss://page.example/socket");
    expect(ev.posted).toEqual([]);
  });
});

describe("D12. diagnostics exports fail closed (#494/#495)", () => {
  it("zl:exportDiagnostics refuses a malformed trace identity", async () => {
    const ev = hostEvent({ type: "zl:exportDiagnostics", clientId: "c1", traceId: "nope" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, status: "identity-unavailable" }]);
  });

  it("zl:captchaTrace from a proxied page is a host-only refusal", async () => {
    const ev = pageEvent("https://p.example", { type: "zl:captchaTrace" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });

  it("an unregistered proxied page cannot use the zl:extPage exception", async () => {
    const ev = pageEvent("https://p.example", { type: "zl:extPage", extId: "evil@example" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, error: "host-only control message" }]);
  });
});

describe("D13. zl:domInspect validation (#550)", () => {
  it.each([
    ["empty clientId", { type: "zl:domInspect", op: "authorize", clientId: "" }],
    ["oversized clientId", { type: "zl:domInspect", op: "authorize", clientId: "c".repeat(300) }],
    ["bogus op", { type: "zl:domInspect", op: "bogus", clientId: "c1" }],
    ["missing op", { type: "zl:domInspect", clientId: "c1" }],
  ])("refuses %s", async (_name, msg) => {
    const ev = hostEvent(msg);
    await handleControlEvent(ev.ev, mkDeps());
    expect((ev.posted[0] as { ok: boolean }).ok).toBe(false);
    expect((ev.posted[0] as { error: string }).error).toMatch(/^bad zl:domInspect/);
  });
});

describe("D14. zl:decodeRoutes bounds (#180)", () => {
  it("truncates to 64 routes, nulls oversized ones, and closes the port after the reply", async () => {
    /* The oversized entry sits INSIDE the first 64 so the bound,
       not the truncation, is what nulls it. */
    const routes = ["x".repeat(3000), ...[...Array(70).keys()].map((i) => ORIGIN + encodeDest("https://t.example/" + i))];
    const ev = pageEvent("https://t.example", { type: "zl:decodeRoutes", routes });
    await handleControlEvent(ev.ev, mkDeps());
    const reply = ev.posted[0] as { ok: boolean; dests: Array<string | null> };
    expect(reply.ok).toBe(true);
    expect(reply.dests).toHaveLength(64);
    expect(reply.dests[0]).toBeNull();
    expect(reply.dests[1]).toBe("https://t.example/0");
    expect(ev.portState.closed).toBe(true);
  });
});

describe("D15. zl:mint and zl:spa404", () => {
  it("zl:mint refuses a non-http(s) dest", async () => {
    const ev = hostEvent({ type: "zl:mint", dest: "javascript:alert(1)" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, error: "mint needs an absolute http(s) dest" }]);
  });

  it("zl:spa404 is replyless by design and never crashes the dispatcher", async () => {
    const ev = pageEvent("https://s.example", { type: "zl:spa404" });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([]);
  });
});

/* ---- E. zl:find (the whole block was dark) -------------------------- */

describe("E. zl:find", () => {
  it.each([
    ["bogus cmd", { cmd: "bogus", dest: "https://t.example/", pattern: "x" }],
    ["find without pattern", { cmd: "find", dest: "https://t.example/" }],
    ["missing dest", { cmd: "find", pattern: "x" }],
  ])("refuses %s", async (_name, msg) => {
    const ev = hostEvent({ type: "zl:find", ...msg });
    await handleControlEvent(ev.ev, mkDeps());
    expect(ev.posted).toEqual([{ ok: false, error: "bad zl:find" }]);
  });

  it("a portless find is refused silently (the reply rides the port)", async () => {
    const ev = mkEvent(ORIGIN + "/", { type: "zl:find", cmd: "find", dest: "https://t.example/", pattern: "x" }, { withPort: false });
    await expect(handleControlEvent(ev.ev, mkDeps())).resolves.toBeUndefined();
    expect(ev.posted).toEqual([]);
    expect(ev.waits).toHaveLength(0);
  });

  it("answers honestly when no proxied page sits at the destination", async () => {
    const ev = hostEvent({ type: "zl:find", cmd: "find", dest: "https://t.example/", pattern: "x" });
    await handleControlEvent(ev.ev, mkDeps());
    for (const w of ev.waits) await w;
    expect(ev.posted).toEqual([{ ok: false, error: "find: no proxied page at dest" }]);
  });

  it("relays the compiled finder and carries the page's answer back", async () => {
    const dest = "https://t.example/page";
    const targetPosted: Array<{ msg: unknown; transfer: unknown[] }> = [];
    stubGlobals({
      clients: {
        get: async () => undefined,
        matchAll: async () => [
          { id: "tc1", url: ORIGIN + encodeDest(dest), postMessage: (m: unknown, t?: unknown[]) => targetPosted.push({ msg: m, transfer: t ?? [] }) },
          { id: "tc2", url: ORIGIN + "/devtools.html" },
        ],
      },
    });
    const ev = hostEvent({ type: "zl:find", cmd: "find", dest, pattern: "needle" });
    await handleControlEvent(ev.ev, mkDeps());
    for (const w of ev.waits) await w;
    /* target.postMessage is NOT awaited by the handler; give the
       MessageChannel entanglement a tick to deliver the page answer. */
    expect(targetPosted).toHaveLength(1);
    const load = targetPosted[0]!.msg as { type: string; cmd: string; pattern: string; code: string };
    expect(load.type).toBe("zl:findLoad");
    expect(load.cmd).toBe("find");
    expect(load.pattern).toBe("needle");
    expect(load.code).toBe("/* finder stub */");
    const pagePort = targetPosted[0]!.transfer[0] as MessagePort;
    pagePort.postMessage({ ok: true, matches: 3, ordinal: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(ev.posted).toEqual([{ ok: true, matches: 3, ordinal: 2 }]);
  });

  it("a page that never answers fails on the bounded timeout, and a late answer never double-replies", async () => {
    vi.useFakeTimers();
    try {
      const dest = "https://t.example/slow";
      const targetPosted: Array<{ msg: unknown; transfer: unknown[] }> = [];
      stubGlobals({
        clients: {
          get: async () => undefined,
          matchAll: async () => [
            { id: "tc3", url: ORIGIN + encodeDest(dest), postMessage: (m: unknown, t?: unknown[]) => targetPosted.push({ msg: m, transfer: t ?? [] }) },
          ],
        },
      });
      const ev = hostEvent({ type: "zl:find", cmd: "find", dest, pattern: "x" });
      const done = handleControlEvent(ev.ev, mkDeps());
      await done;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ev.posted).toEqual([{ ok: false, error: "find: page did not answer" }]);
      const pagePort = targetPosted[0]!.transfer[0] as MessagePort;
      pagePort.postMessage({ ok: true, matches: 9 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ev.posted).toEqual([{ ok: false, error: "find: page did not answer" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("E2. zl:find with an unavailable finder bundle", () => {
  /* finderSource caches its one fetch for the worker lifetime, so
     this case needs a fresh control module. */
  it("answers 'finder bundle unavailable' instead of pretending", async () => {
    vi.resetModules();
    fetchState.status = 404;
    try {
      const { handleControlEvent: fresh } = await import("../control");
      const ev = hostEvent({ type: "zl:find", cmd: "find", dest: "https://t.example/", pattern: "x" });
      await fresh(ev.ev, mkDeps());
      for (const w of ev.waits) await w;
      expect(ev.posted).toEqual([{ ok: false, error: "finder bundle unavailable" }]);
    } finally {
      fetchState.status = 200;
    }
  });
});

/* ---- F. seeded differential fuzz ------------------------------------
   Every message the control plane can receive - garbage types,
   garbage field soup, hostile senders - must stay inside the
   contract: a structured reply (or a bridged ws port, or the
   documented replyless zl:spa404), no escaping rejection, no
   unhandled rejection, and the route prefix never collapses the
   engine-path predicate. Any deviation is a failure. */

describe("F. seeded message-soup fuzz (seed 0x5ee17c)", () => {
  const rand = mulberry32(0x5ee17c);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const TYPES = [
    "zl:ping", "zl:config", "zl:wispAuth", "zl:mint", "zl:decodeRoutes", "zl:navHandle",
    "zl:adblock", "zl:rules", "zl:jarProfile", "zl:getJars", "zl:clearJar", "zl:transport",
    "zl:tracing", "zl:getTracing", "zl:siteRoute", "zl:wsOpen", "zl:docCookie", "zl:spa404",
    "zl:getVirtualOrigin", "zl:embedderOrigin", "zl:getEmbedder", "zl:fingerprint",
    "zl:recordStart", "zl:recordStop", "zl:find", "zl:downloads", "zl:cancelDownload",
    "zl:pauseDownload", "zl:resumeDownload", "zl:saveDownload", "zl:exportSession",
    "zl:importSession", "zl:sameSite", "zl:teardown", "zl:getNetLog", "zl:getDiag",
    "zl:doctor", "zl:exportDiagnostics", "zl:captchaTrace", "zl:domInspect", "zl:loadState",
    "zl:relayRegister", "zl:reloadBypass", "zl:wispRegister", "zl:wispPrimary",
    "zl:guestHost", "zl:guestSpawn", "zl:guestTerminate", "zl:guestRegister", "zl:guestUnregister",
    /* garbage labels */
    "zl:", "zl:nop", "", "ZL:PING", "zl:config ", "ping", undefined, 42, null,
  ];
  const SENDERS = [
    ORIGIN + "/",
    ORIGIN + "/index.html",
    ORIGIN + "/devtools.html",
    ORIGIN + "/j/abc",
    ORIGIN + encodeDest("https://fuzz.example/"),
    ORIGIN + "/__zl_navh__/tok",
    ORIGIN + "/zl-ext/page",
    null,
    "about:blank",
    "https://other.origin/page",
  ];
  const FIELD_POOL: Record<string, readonly unknown[]> = {
    dest: ["https://t.example/", "not a url", 123, null],
    url: ["wss://ws.example.org/s", "ws://x", "bogus", 42],
    prefix: ["", "/", "/j/", "j", "/a/b/", "/__zl_navh__/", "/k/"],
    protocols: [undefined, [], ["chat"], ["a\r\nb"], ["x", "x"], [1], "chat"],
    since: [0, 5, "garbage", -1],
    clientId: ["c1", "", "y".repeat(300)],
    id: ["d1", 5, null],
    passphrase: ["short", "long-enough-pass"],
    blob: [null, {}, new Blob(["x"])],
    origin: ["https://a.example", "garbage", 3],
    rules: [{}, undefined],
    ua: ["UA/1", undefined],
    profile: [{ userAgent: "x" }, null],
    recId: ["r1", 2],
    cmd: ["find", "next", "prev", "clear", "bogus"],
    pattern: ["p", 3],
    options: [{}, null],
    nodeId: [1, -1, 1e6],
    op: ["authorize", "revoke", "snapshot", "styles", "console", "bogus"],
    engine: ["libcurl", "epoxy", "x"],
    enabled: [true, false, undefined],
    site: ["s.example", ""],
    mode: ["merge", "replace", "x"],
    rule: ["import-wins", "keep-newest", "bogus"],
    wispAuth: [{ op: "clear" }, { op: "set" }, { op: "x" }],
    nav: [true, false],
    host: ["h.example", ""],
    scope: ["/", "garbage"],
    scriptURL: ["https://g.example/sw.js", "::bad::"],
    script: ["", "x"],
    routes: [[], ["https://t.example/"], ["x".repeat(3000)]],
    expectedScope: [ORIGIN + "/", "x".repeat(2000)],
    expectedVersion: ["3.0.1", 42],
  };

  it("120 seeded messages: every deviation classified, no escapes, no prefix collapse", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => {
      unhandled.push(e);
    };
    const proc = (globalThis as unknown as {
      process?: { on(ev: string, fn: (e: unknown) => void): void; off(ev: string, fn: (e: unknown) => void): void };
    }).process;
    proc?.on("unhandledRejection", onUnhandled);
    try {
      for (let i = 0; i < 120; i++) {
        wsState.opens.length = 0;
        wsState.relayOpens.length = 0;
        const msg: Record<string, unknown> = {};
        const type = pick(TYPES);
        if (type !== undefined) msg.type = type;
        for (const [k, pool] of Object.entries(FIELD_POOL)) {
          if (rand() < 0.22) msg[k] = pick(pool);
        }
        const sender = pick(SENDERS);
        const ev = mkEvent(sender, msg);
        const deps = mkDeps();
        let escaped: unknown = null;
        const p = handleControlEvent(ev.ev, deps);
        await vi.advanceTimersByTimeAsync(11_000);
        try {
          await p;
        } catch (err) {
          escaped = err;
        }
        /* Invariant 1: the dispatch either completes or its rejection
           is the documented handler-failure class (a structured
           "control handler failed" answer rides the port in
           production via messageListener). */
        if (escaped !== null) {
          expect(escaped).toBeInstanceOf(Error);
        }
        /* Invariant 2: the message is observable - a reply, a
           bridged ws port, an escaping (classified) rejection, or the
           documented replyless zl:spa404. Nothing silent. */
        const bridged =
          wsState.opens.some((o) => o.port === (ev.ev.ports[0] ?? null)) ||
          wsState.relayOpens.some((o) => o.port === (ev.ev.ports[0] ?? null));
        const observable =
          ev.posted.length > 0 || bridged || escaped !== null || msg.type === "zl:spa404";
        expect(observable).toBe(true);
        /* Invariant 3: whatever reached the transport handshake is
           token-shaped - the page never injects non-token protocol
           strings past the control seam. */
        for (const o of [...wsState.opens, ...wsState.relayOpens]) {
          expect(o.protocols.every((pr) => typeof pr === "string" && WS_TOKEN.test(pr))).toBe(true);
        }
        /* Invariant 4: the route prefix never collapses the
           engine-path predicate - the host keeps its control plane. */
        expect(isEnginePath("/devtools.html")).toBe(false);
        expect(senderIsHostPage("/devtools.html", ORIGIN)).toBe(true);
      }
    } finally {
      proc?.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
    expect(unhandled).toEqual([]);
  }, 60_000);

  it("100 seeded messages over the risky types: the defect classes cannot slip through unclassified", async () => {
    /* The general soup samples uniformly, so the CRLF-protocol and
       prefix-collapse classes may never be drawn in 120 iterations;
       this targeted soup draws ONLY the seams where the three
       defect classes live, so their absence post-fix is proven,
       not lucky. */
    const RISKY = [
      "zl:wsOpen", "zl:config", "zl:find", "zl:importSession", "zl:exportSession",
      "zl:guestRegister", "zl:exportDiagnostics", "zl:docCookie", "zl:decodeRoutes",
      "zl:navHandle", "zl:mint", "zl:teardown",
    ] as const;
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 100; i++) {
        wsState.opens.length = 0;
        wsState.relayOpens.length = 0;
        const msg: Record<string, unknown> = { type: pick(RISKY as unknown as readonly unknown[]) };
        for (const [k, pool] of Object.entries(FIELD_POOL)) {
          if (rand() < 0.4) msg[k] = pick(pool);
        }
        const sender = pick(SENDERS);
        const ev = mkEvent(sender, msg);
        let escaped: unknown = null;
        const p = handleControlEvent(ev.ev, mkDeps());
        await vi.advanceTimersByTimeAsync(11_000);
        try {
          await p;
        } catch (err) {
          escaped = err;
        }
        const bridged =
          wsState.opens.some((o) => o.port === (ev.ev.ports[0] ?? null)) ||
          wsState.relayOpens.some((o) => o.port === (ev.ev.ports[0] ?? null));
        const observable = ev.posted.length > 0 || bridged || escaped !== null;
        expect(observable).toBe(true);
        for (const o of [...wsState.opens, ...wsState.relayOpens]) {
          expect(o.protocols.every((pr) => typeof pr === "string" && WS_TOKEN.test(pr))).toBe(true);
        }
        expect(isEnginePath("/devtools.html")).toBe(false);
        expect(senderIsHostPage("/devtools.html", ORIGIN)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("80 seeded prefixes: the config seam enforces exactly the documented grammar", async () => {
    const CHARS = "abz09-_".split("");
    const SPECIALS = ["", "/", "/j/", "j", "//", "/a/b/", "/__zl_navh__/", "/__zl_nav__/",
      "/zl-ext/", "/zl-cs/", "/zlsw-register/", "/devtools.html/", "/sw.js/",
      "/" + "a".repeat(33) + "/", "/a b/", "/é/", "/-/", "/_/"];
    for (let i = 0; i < 80; i++) {
      let p: string;
      if (rand() < 0.4) {
        p = pick(SPECIALS);
      } else {
        const n = 1 + Math.floor(rand() * 36);
        let seg = "";
        for (let j = 0; j < n; j++) seg += pick(CHARS);
        if (rand() < 0.25) seg = "__zl" + seg;
        p = (rand() < 0.9 ? "/" : "") + seg + (rand() < 0.9 ? "/" : "");
      }
      setScheme("/j/");
      const before = currentPrefix();
      const ev = hostEvent({ type: "zl:config", prefix: p });
      const deps = mkDeps();
      await handleControlEvent(ev.ev, deps);
      const reply = ev.posted[0] as { ok: boolean; prefix?: string };
      if (schemePrefixValid(p)) {
        expect(reply.ok).toBe(true);
        expect(currentPrefix()).toBe(p);
        expect(deps.persistRoute).toHaveBeenCalledWith(p);
      } else {
        expect(reply.ok).toBe(false);
        expect(currentPrefix()).toBe(before);
        expect(deps.persistRoute).not.toHaveBeenCalled();
      }
      /* The no-lockout invariant holds after every config attempt. */
      expect(isEnginePath("/devtools.html")).toBe(false);
      expect(senderIsHostPage("/devtools.html", ORIGIN)).toBe(true);
    }
  });
});
