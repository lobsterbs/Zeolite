import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: { ready: async () => {} },
  altRegister: () => {},
  altConfig: () => {},
  altConfigured: () => false,
  altEndpoint: () => null,
  primaryWispOverrideValue: () => null,
}));

vi.mock("../ws-runtime", () => ({
  wsBridge: { open: () => {}, closeAll: () => {} },
}));

import { handleControlEvent, type ControlMessage } from "../control";
import { persistRoute } from "../request";
import { b64uEncode, looksKeyedToken, routeCodec, setRouteKey } from "../codec";
import { setStrictOpacity, strictOpacityEnabled } from "../swstate";

/* #609: strict opaque custody. A keyless worker refuses zl:mint
   with a named reason under strictOpacity instead of silently
   answering a browser-decodable legacy route; the codec field
   makes every mint's custody visible; config and ping echo the
   toggle and the custody; the toggle persists with the route
   shape. */

const mkEvent = (sourceUrl: string, msg: ControlMessage) => {
  const posted: unknown[] = [];
  const ev = {
    data: msg,
    ports: [{ postMessage: (p: unknown) => posted.push(p), close: () => {} }],
    source: { url: sourceUrl, id: "c1" },
  } as unknown as ExtendableMessageEvent;
  return { ev, posted };
};

const deps = { ready: Promise.resolve(), persistRoute: async () => {} };
const HOST = "https://w.example.org/";

describe("strict opaque custody (#609)", () => {
  beforeEach(() => {
    vi.stubGlobal("self", { location: { origin: "https://w.example.org" } });
    setRouteKey(null);
    setStrictOpacity(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setRouteKey(null);
    setStrictOpacity(false);
  });

  it("refuses a keyless mint under strict opacity with a named reason", async () => {
    setStrictOpacity(true);
    const { ev, posted } = mkEvent(HOST, { type: "zl:mint", dest: "https://target.example.org/" });
    await handleControlEvent(ev, deps);
    const r = posted[0] as { ok: boolean; error?: string; route?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("strict opacity");
    expect(r.route).toBeUndefined();
  });

  it("keeps answering a keyless mint with a legacy route in compat mode", async () => {
    const { ev, posted } = mkEvent(HOST, { type: "zl:mint", dest: "https://target.example.org/" });
    await handleControlEvent(ev, deps);
    const r = posted[0] as { ok: boolean; route: string; codec: string };
    expect(r.ok).toBe(true);
    expect(r.codec).toBe("legacy");
    expect(looksKeyedToken(new URL(r.route, "https://w.example.org").pathname)).toBe(false);
  });

  it("answers a keyed mint with codec keyed", async () => {
    setRouteKey(b64uEncode(new Uint8Array(16).fill(7)));
    const { ev, posted } = mkEvent(HOST, { type: "zl:mint", dest: "https://target.example.org/" });
    await handleControlEvent(ev, deps);
    const r = posted[0] as { ok: boolean; route: string; codec: string };
    expect(r.ok).toBe(true);
    expect(r.codec).toBe("keyed");
    expect(looksKeyedToken(new URL(r.route, "https://w.example.org").pathname)).toBe(true);
  });

  it("refuses a proxied-page mint under strict opacity when keyless too", async () => {
    setStrictOpacity(true);
    const { ev, posted } = mkEvent(HOST + "j/abc", { type: "zl:mint", dest: "https://target.example.org/" });
    await handleControlEvent(ev, deps);
    const r = posted[0] as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("strict opacity");
  });

  it("applies and echoes strictOpacity through zl:config and zl:ping", async () => {
    const cfg = mkEvent(HOST, { type: "zl:config", strictOpacity: true });
    await handleControlEvent(cfg.ev, deps);
    expect(cfg.posted[0]).toMatchObject({ ok: true, strictOpacity: true });
    expect(strictOpacityEnabled()).toBe(true);
    const ping = mkEvent(HOST, { type: "zl:ping" });
    await handleControlEvent(ping.ev, deps);
    expect(ping.posted[0]).toMatchObject({ ok: true, strictOpacity: true, custody: "legacy" });
    const off = mkEvent(HOST, { type: "zl:config", strictOpacity: false });
    await handleControlEvent(off.ev, deps);
    expect(off.posted[0]).toMatchObject({ ok: true, strictOpacity: false });
    expect(strictOpacityEnabled()).toBe(false);
  });

  it("names the keyed custody in zl:ping when a route key is held", async () => {
    setRouteKey(b64uEncode(new Uint8Array(16).fill(9)));
    const ping = mkEvent(HOST, { type: "zl:ping" });
    await handleControlEvent(ping.ev, deps);
    expect(ping.posted[0]).toMatchObject({ custody: "keyed" });
    expect(routeCodec()).toBe("keyed");
  });

  it("answers zl:navHandle with codec keyed", async () => {
    setRouteKey(b64uEncode(new Uint8Array(16).fill(3)));
    const { ev, posted } = mkEvent(HOST, { type: "zl:navHandle", dest: "https://target.example.org/" });
    await handleControlEvent(ev, deps);
    expect(posted[0]).toMatchObject({ ok: true, codec: "keyed" });
  });
});

describe("persistRoute carries strict-opacity (#609)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setStrictOpacity(false);
  });

  it("writes the live strict-opacity value into the route shape", async () => {
    const puts: { body: string }[] = [];
    vi.stubGlobal("self", { registration: { scope: "https://engine.test/" } });
    vi.stubGlobal("caches", {
      open: async () => ({
        put: async (_url: string, res: Response) => {
          puts.push({ body: await res.text() });
        },
      }),
    });
    setStrictOpacity(true);
    await persistRoute("/j/");
    expect(puts[0].body).toContain("strict-opacity #true");
    setStrictOpacity(false);
    await persistRoute("/j/");
    expect(puts[1].body).toContain("strict-opacity #false");
    expect(puts[1].body).not.toContain("strict-opacity #true");
  });
});
